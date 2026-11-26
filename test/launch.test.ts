import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	spyOn,
	test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
import { driverFor } from "../src/harnesses/index.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type {
	LaunchHarness,
	LaunchOptions,
	LaunchRefs,
	LaunchState,
} from "../src/http/wire.ts";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import {
	harnessCommand,
	LAUNCH_HARNESSES,
	type LaunchDeps,
	Launches,
	parseLaunchParams,
	parseProbe,
	terminalDialog,
} from "../src/service/launch.ts";
import { SessionHistory } from "../src/service/session-history.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { FakeTailnet } from "./fake-tailnet.ts";
import { registration, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

/**
 * Launching agents (src/service/launch.ts) against a private tmux server
 * (`tmux -L`, a temp TMUX_TMPDIR and HOME) with a fake harness: a shell
 * script that may show a folder-trust dialog, then logs what it is typed.
 * The test plays the harness's registration (as its MCP server would) with
 * the pane's pid. Two nodes check the relayed launch and its reads.
 */

setDefaultTimeout(30_000);

const HAS_TMUX = Boolean(Bun.which("tmux"));
const SOCKET = `pulsar-launch-${process.pid}`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "pulsar-launch-")));
const HOME = join(root, "home");
const FAKE = join(root, "fake-harness.sh");
const OWNER = "me@example.com";
const TAILNET_RP = "tail-fake.ts.net";
const originOf = (name: string) => `https://${name}.tail-fake.ts.net:7337`;
const rpOf = (name: string) => ({
	rpId: TAILNET_RP,
	origins: [originOf(name)],
});
const USER = { kind: "human" as const, login: OWNER, node: "phone" };
const VERIFIED = { ...USER, verified: true as const };

/** What the next launch's fake harness does. */
let mode: "plain" | "trust" | "exit" = "plain";
let logN = 0;
const logs: string[] = [];
const resumedArgs: string[][] = [];
const sends: { node: string; agentId: string; body: string }[] = [];

writeFileSync(
	FAKE,
	`#!/bin/sh
# $1: plain | trust | exit; $2: where typed lines go
pwd -P > "$2.cwd"
if [ "$1" = exit ]; then echo "fake: no such thing"; exit 3; fi
if [ "$1" = trust ]; then
  echo "Do you trust the files in this folder?"
  read answer
  echo "trusted:$answer" >> "$2"
  # A TUI redraws: the dialog leaves the screen.
  printf '\\033[2J\\033[H'
fi
echo "fake harness ready"
while read line; do echo "got:$line" >> "$2"; done
`,
);

interface Node {
	name: string;
	dir: string;
	store: Store;
	service: PulsarService;
	http: HttpTransport;
	fed: Federation;
}
const tailnet = new FakeTailnet();
const nodes: Node[] = [];

async function startNode(name: string): Promise<Node> {
	const dir = mkdtempSync(join(root, `${name}-`));
	const store = new Store(join(dir, "pulsar.db"));
	const service = new PulsarService({
		store,
		scan: false,
		machine: name,
		push: { keyFile: join(dir, "vapid.json") },
		approvals: { probe: () => null },
		launch: {
			tmux: { socket: SOCKET },
			shell: "/bin/sh",
			command: (_h, resumeArgs) => {
				if (resumeArgs) resumedArgs.push(resumeArgs);
				const log = join(root, `typed-${logN++}.txt`);
				writeFileSync(log, "");
				logs.push(log);
				return `exec /bin/sh '${FAKE}' ${mode} '${log}'`;
			},
			timing: {
				pollMs: 40,
				readyMs: 4000,
				terminalMs: 6000,
				quietPolls: 3,
				followMs: 60,
			},
		},
	});
	const http = new HttpTransport(service, {
		identity: tailnet.identity,
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 30 },
	});
	await http.listen();
	const fed = new Federation(service, {
		tailnet: tailnet.view(name),
		members: new PoolMembers(null),
		intervals: {
			discoverMs: 150,
			heartbeatMs: 200,
			missed: 5,
			coalesceMs: 30,
			linkIdleMs: 60_000,
			outboxTickMs: 40,
			receiptTickMs: 40,
			requestTimeoutMs: 3000,
		},
	});
	http.fed = fed;
	tailnet.add(name);
	tailnet.serve(name, http.app, http.port, 7337);
	service.start();
	await fed.start();
	const node = { name, dir, store, service, http, fed };
	nodes.push(node);
	return node;
}

function tmux(...args: string[]): string {
	return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8" });
}

function git(cwd: string, ...args: string[]) {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.com",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.com",
		},
	}).trim();
}

/** Plays the harness connecting to Pulsar from the pane's process. */
function register(
	n: Node,
	s: LaunchState,
	harness: LaunchHarness = "pi",
	sessionId?: string,
	managed = false,
) {
	const pid = Number(
		tmux("display-message", "-p", "-t", `=${s.session}:`, "#{pane_pid}").trim(),
	);
	const controller = new AbortController();
	let agentId = "";
	// The real delivery path: the extension gets the first message pushed.
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: (event, data) => {
			if (event === "push")
				sends.push({
					node: n.name,
					agentId,
					body: String((data as { text?: unknown }).text ?? ""),
				});
		},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	const agent = n.service.registerAgent(
		caller,
		registration({
			harness,
			pid,
			cwd: s.cwd,
			project: "demo",
			...(sessionId ? { sessionId } : {}),
			...(managed ? { meta: { acp: "1", acpResume: "1" } } : {}),
		}),
	);
	agentId = agent.id;
	return { agent, close: () => controller.abort() };
}

const states = new Map<string, LaunchState[]>();
function track(n: Node) {
	n.service.events.on("launch", (s) => {
		const list = states.get(s.id) ?? [];
		list.push(s);
		states.set(s.id, list);
	});
}
const now = (n: Node, id: string) => n.service.launches.get(id)!;

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (e as { code?: string }).code ?? (e as Error).message;
	}
}

let nonceN = 0;
const nonce = () => `test-nonce-${process.pid}-${nonceN++}`;

let home: Node;
let relay: Node;
let phone: SoftAuthenticator;
const oldHome = process.env.HOME;
const oldTmp = process.env.TMUX_TMPDIR;
// Short: a tmux socket path has a length limit.
const tmuxDir = mkdtempSync(join(tmpdir(), "plt-"));
const project = join(HOME, "proj");

beforeAll(async () => {
	mkdirSync(project, { recursive: true });
	mkdirSync(join(HOME, "bin"));
	writeFileSync(join(HOME, "bin", "codex"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(HOME, "bin", "agy"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(join(HOME, "bin", "pulsar"), "#!/bin/sh\n", { mode: 0o755 });
	writeFileSync(
		join(HOME, ".profile"),
		'PATH="$HOME/bin:$PATH"; export PATH\n',
	);
	// The login shell and the private tmux server see a temp HOME.
	process.env.HOME = HOME;
	process.env.TMUX_TMPDIR = tmuxDir;
	delete process.env.TMUX;
	tailnet.add("phone");
	home = await startNode("home");
	relay = await startNode("relay");
	track(home);
	track(relay);
	for (const n of nodes) await n.fed.discover();
	await until(() => relay.fed.machineIdOf("home") !== null, 5000);
	phone = new SoftAuthenticator({ origin: originOf("home"), rpId: TAILNET_RP });
	const pk = home.service.passkeys;
	const options = await pk.registrationOptions(OWNER, rpOf("home"), {
		label: "iPhone",
	});
	await pk.verifyRegistration(OWNER, rpOf("home"), phone.register(options));
});

afterAll(async () => {
	for (const n of nodes) {
		n.fed.stop();
		n.service.stop();
		await n.http.close();
		n.store.close();
	}
	if (HAS_TMUX)
		try {
			tmux("kill-server");
		} catch {}
	process.env.HOME = oldHome;
	if (oldTmp === undefined) delete process.env.TMUX_TMPDIR;
	else process.env.TMUX_TMPDIR = oldTmp;
	rmSync(root, { recursive: true, force: true });
	rmSync(tmuxDir, { recursive: true, force: true });
});

describe("launch params and commands", () => {
	const ok = {
		nonce: "abcdefgh12",
		cwd: "/w",
		harness: "claude",
		workspace: "current",
	};

	test("new launches prefer installed ACP and preserve native fallback", () => {
		const bin = mkdtempSync(join(root, "launch-modes-"));
		const entries = [
			["claude", "claude-agent-acp"],
			["codex", "codex-acp"],
			["opencode", "opencode"],
			["pi", "pi-acp"],
		] as const;
		const shell = (harness: LaunchHarness) =>
			execFileSync("/bin/sh", ["-c", harnessCommand(harness)], {
				env: { PATH: bin },
				encoding: "utf8",
			}).trim();
		for (const [id] of entries)
			writeFileSync(join(bin, id), `#!/bin/sh\nprintf '%s' '${id}'\n`, {
				mode: 0o755,
			});
		writeFileSync(
			join(bin, "pulsar"),
			'#!/bin/sh\nprintf \'%s %s\' "$1" "$2"\n',
			{ mode: 0o755 },
		);
		expect(shell("claude")).toBe("claude");
		expect(shell("codex")).toBe("codex");
		expect(shell("pi")).toBe("pi");
		for (const [id, acp] of entries) {
			if (id !== acp)
				writeFileSync(join(bin, acp), "#!/bin/sh\n", { mode: 0o755 });
			expect(shell(id)).toBe(`acp ${id}`);
		}
		rmSync(join(bin, "pulsar"));
		expect(shell("opencode")).toBe("opencode");
		expect(harnessCommand("omp")).toBe("exec omp");
		expect(harnessCommand("antigravity")).toBe("exec pulsar acp antigravity");
		expect(harnessCommand("copilot")).toBe("exec pulsar acp copilot");
	});

	test("params are checked as they arrive", () => {
		expect(parseLaunchParams(ok)).toEqual(ok as never);
		expect(parseLaunchParams({ ...ok, cwd: "~/x", prompt: "  " })).toEqual({
			...ok,
			cwd: "~/x",
		} as never);
		const bad: unknown[] = [
			null,
			[],
			{ ...ok, extra: 1 },
			{ ...ok, nonce: "x" },
			{ ...ok, cwd: "relative/path" },
			{ ...ok, harness: "bash" },
			{ ...ok, harness: "claude --dangerously-skip-permissions" },
			{ ...ok, workspace: "elsewhere" },
			{ ...ok, branch: "x" },
			{ ...ok, workspace: "worktree", branch: "-f" },
			{ ...ok, workspace: "worktree", base: "--upload-pack=x" },
			{ ...ok, prompt: 5 },
		];
		for (const b of bad) expect(() => parseLaunchParams(b)).toThrow(/launch:/);
	});

	test("dialogs the terminal shows", () => {
		expect(terminalDialog("Do you trust the files in this folder?")).toBe(
			"folder trust",
		);
		expect(
			terminalDialog(
				"Quick safety check: Is this a project you created or one you trust?",
			),
		).toBe("folder trust");
		expect(terminalDialog("> ready")).toBeNull();
		// A tall pane: the dialog on top, blank rows under it.
		expect(terminalDialog(`Do you trust this folder?${"\n".repeat(49)}`)).toBe(
			"folder trust",
		);
		// Old output scrolled far above what shows now does not count.
		expect(
			terminalDialog(
				`Do you trust this folder?\n${"line\n".repeat(40)}> ready`,
			),
		).toBeNull();
	});
});

describe.skipIf(!HAS_TMUX)("launching on this node", () => {
	test("an archived native session resumes once, by exact ID and workspace", async () => {
		using scan = spyOn(
			driverFor("antigravity")!.scan!,
			"sessions",
		).mockReturnValue([]);
		const id = "66220000-0000-4000-8000-000000000001";
		const dir = join(HOME, ".gemini/antigravity-cli/conversations");
		mkdirSync(dir, { recursive: true });
		const { DatabaseSync } = createRequire(import.meta.url)(
			"node:sqlite",
		) as typeof import("node:sqlite");
		const db = new DatabaseSync(join(dir, `${id}.db`));
		db.exec("CREATE TABLE trajectory_meta(cascade_id TEXT)");
		db.prepare("INSERT INTO trajectory_meta VALUES (?)").run(id);
		db.close();
		const summary = new DatabaseSync(join(dir, "../conversation_summaries.db"));
		summary.exec(
			"CREATE TABLE conversation_summaries(conversation_id TEXT, workspace_uris TEXT, title TEXT, last_modified_time TEXT)",
		);
		summary
			.prepare("INSERT INTO conversation_summaries VALUES (?, ?, ?, ?)")
			.run(
				id,
				JSON.stringify([`file://${project}`]),
				"Saved",
				new Date().toISOString(),
			);
		summary.close();
		const params = {
			nonce: nonce(),
			cwd: project,
			workspace: "current",
			harness: "antigravity",
			resumeSessionId: id,
		};
		expect(
			await code(
				home.service.launches.start(VERIFIED, { ...params, cwd: HOME }),
			),
		).toBe("bad_request");
		scan.mockReturnValueOnce([
			{
				harness: "antigravity",
				sessionId: id,
				pid: 123,
				cwd: project,
				status: "idle",
				meta: {},
			},
		]);
		expect(await code(home.service.launches.start(VERIFIED, params))).toBe(
			"conflict",
		);
		const s = await home.service.launches.start(VERIFIED, params);
		await until(() => now(home, s.id).step === "waiting", 5000);
		expect(resumedArgs.at(-1)).toEqual(["agy", "--conversation", id]);
		const duplicate = await home.service.launches.start(VERIFIED, {
			...params,
			nonce: nonce(),
		});
		await until(() => now(home, duplicate.id).step === "failed", 5000);
		expect(duplicate.session).toBe(s.session);
		const exact = register(home, s, "antigravity", id);
		try {
			await until(() => now(home, s.id).step === "done", 5000);
			expect(now(home, s.id).agentId).toBe(exact.agent.id);
			expect(
				await code(
					home.service.launches.start(VERIFIED, { ...params, nonce: nonce() }),
				),
			).toBe("conflict");
		} finally {
			exact.close();
		}
	});

	test("the login shell passes an opaque provider session id as one literal argument", () => {
		const id = "space and 'quotes' + $(uname) + `pwd`";
		const command = harnessCommand("cursor", ["/usr/bin/printf", "%s", id]);
		expect(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })).toBe(
			id,
		);
	});

	test("an ACP archive uses only its negotiated provider's exact resume command", async () => {
		const id = "space and 'quote/subsession";
		const history = new SessionHistory(home.store, home.name);
		const key = home.service.registry.agentId("cursor", id, null);
		const original = home.service.registry.upsert({
			harness: "cursor",
			sessionId: id,
			pid: null,
			cwd: project,
			project: "demo",
			branch: null,
			tags: [],
			registered: false,
			meta: { acp: "1" },
		});
		original.status = "gone";
		const params = {
			nonce: nonce(),
			cwd: project,
			workspace: "current",
			harness: "cursor",
			resumeSessionId: id,
		};
		history.remember(original);
		expect(await code(home.service.launches.start(VERIFIED, params))).toBe(
			"bad_request",
		);
		original.meta.acpResume = "1";
		history.remember(original);
		const s = await home.service.launches.start(VERIFIED, params);
		await until(() => now(home, s.id).step === "waiting", 5000);
		expect(resumedArgs.at(-1)).toEqual([
			"pulsar",
			"acp",
			"cursor",
			"--resume",
			id,
		]);
		const wrong = register(home, s, "cursor", "fresh", true);
		try {
			await new Promise((resolve) => setTimeout(resolve, 120));
			expect(now(home, s.id).agentId).toBeNull();
			const exact = register(home, s, "cursor", id, true);
			try {
				await until(() => now(home, s.id).step === "done", 5000);
				expect(now(home, s.id).agentId).toBe(key);
			} finally {
				exact.close();
			}
		} finally {
			wrong.close();
		}
	});

	test("starts in tmux, waits until ready, then sends the first message", async () => {
		mode = "plain";
		const before = sends.length;
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: "~/proj",
			harness: "pi",
			workspace: "current",
			prompt: "fix the login bug",
			name: "login-fixer",
		});
		expect(s.cwd).toBe(project);
		expect(s.session).toMatch(/^pulsar-/);
		await until(() => now(home, s.id).step === "waiting", 5000);
		const cwdLog = `${logs.at(-1)!}.cwd`;
		await until(
			() =>
				existsSync(cwdLog) && readFileSync(cwdLog, "utf8").trim().length > 0,
			5000,
		);
		expect(readFileSync(cwdLog, "utf8").trim()).toBe(project);
		// Not registered yet: nothing goes out, however long it waits.
		await new Promise((r) => setTimeout(r, 300));
		expect(sends.length).toBe(before);
		const { agent, close } = register(home, s);
		try {
			// Registered but busy: still waiting.
			home.service.registry.setStatus(agent, "busy");
			await new Promise((r) => setTimeout(r, 300));
			expect(now(home, s.id).step).toBe("waiting");
			expect(sends.length).toBe(before);
			home.service.registry.setStatus(agent, "idle");
			await until(() => now(home, s.id).step === "done", 5000);
			const done = now(home, s.id);
			expect(done).toMatchObject({
				agentId: agent.id,
				sent: true,
				error: null,
			});
			expect(sends.at(-1)).toMatchObject({ node: "home", agentId: agent.id });
			// As the verified operator, through the extension's push.
			expect(sends.at(-1)!.body).toContain("fix the login bug");
			expect(sends.at(-1)!.body).toContain("human operator");
			// Stop and typing reach it through its pane.
			const pane = tmux(
				"display-message",
				"-p",
				"-t",
				`=${s.session}:`,
				"#{pane_id}",
			).trim();
			expect(agent.meta.tmux).toBe(pane);
			expect((await home.service.app.agent(VERIFIED, agent.id)).tmux).toBe(
				pane,
			);
			expect(agent.name).toBe("login-fixer");
			// The operator started it: its finished and failed turns notify.
			expect(home.service.interest.has(agent.id)).toBe(true);
			const steps = states.get(s.id)!.map((x) => x.step);
			expect(steps[0]).toBe("starting");
			expect(steps).toContain("waiting");
			expect(steps.at(-1)).toBe("done");
			const audit = home.store.db
				.prepare(
					"SELECT ok, target FROM audit WHERE op = 'agents.launch.result' ORDER BY id DESC LIMIT 1",
				)
				.get() as { ok: number; target: string };
			expect(audit).toEqual({ ok: 1, target: agent.id });
		} finally {
			close();
			tmux("kill-session", "-t", `=${s.session}`);
		}
	});

	test("a repeated press starts nothing new", async () => {
		mode = "plain";
		const p = {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
		};
		const a = await home.service.launches.launch(VERIFIED, null, p);
		const b = await home.service.launches.launch(VERIFIED, null, p);
		expect(b.id).toBe(a.id);
		await until(() => now(home, a.id).step === "waiting", 5000);
		const sessions = tmux("list-sessions", "-F", "#{session_name}")
			.split("\n")
			.filter((x) => x === a.session);
		expect(sessions.length).toBe(1);
		tmux("kill-session", "-t", `=${a.session}`);
		await until(() => now(home, a.id).step === "failed", 5000);
	});

	test("a folder-trust dialog waits for the terminal, then the message goes", async () => {
		mode = "trust";
		const before = sends.length;
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
			prompt: "hello",
		});
		await until(() => now(home, s.id).step === "terminal", 5000);
		expect(now(home, s.id).detail).toBe(
			"Waiting in the terminal: folder trust",
		);
		const { agent, close } = register(home, s);
		try {
			home.service.registry.setStatus(agent, "idle");
			await new Promise((r) => setTimeout(r, 300));
			// Registered and idle, but the dialog shows: nothing is typed.
			expect(now(home, s.id).step).toBe("terminal");
			expect(sends.length).toBe(before);
			// The operator answers on that machine.
			tmux("send-keys", "-t", `=${s.session}:`, "-l", "y");
			tmux("send-keys", "-t", `=${s.session}:`, "Enter");
			await until(() => now(home, s.id).step === "done", 5000);
			expect(sends.at(-1)?.body).toContain("hello");
			expect(readFileSync(logs.at(-1)!, "utf8")).toContain("trusted:y");
		} finally {
			close();
			tmux("kill-session", "-t", `=${s.session}`);
		}
	});

	test("a harness that exits fails the launch, with what it said", async () => {
		mode = "exit";
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
			prompt: "x",
		});
		await until(() => now(home, s.id).step === "failed", 5000);
		expect(now(home, s.id).error).toMatch(/^pi exited/);
		expect(now(home, s.id).sent).toBe(false);
	});

	test("an agent that never connects fails after the ready time; nothing is sent", async () => {
		mode = "plain";
		const before = sends.length;
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
			prompt: "x",
		});
		await until(() => now(home, s.id).step === "failed", 8000);
		expect(now(home, s.id).error).toContain("didn't connect to Pulsar");
		expect(sends.length).toBe(before);
		tmux("kill-session", "-t", `=${s.session}`);
	});

	test("a new worktree on a new branch, from a base", async () => {
		mode = "plain";
		const repo = join(HOME, "repo");
		mkdirSync(join(repo, "sub"), { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "sub", "a.txt"), "a");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "one");
		git(repo, "branch", "base-branch");

		const refs = (await home.service.launches.read(VERIFIED, null, {
			op: "launch.refs",
			cwd: join(repo, "sub"),
		})) as LaunchRefs;
		expect(refs.root).toBe(repo);
		expect(refs.current).toBe("main");
		expect(refs.branches.map((b) => b.name).sort()).toEqual([
			"base-branch",
			"main",
		]);

		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: join(repo, "sub"),
			harness: "pi",
			workspace: "worktree",
			branch: "feat/x",
			base: "base-branch",
		});
		const path = join(HOME, "repo-feat-x");
		expect(s.step).toBe("worktree");
		expect(s.cwd).toBe(join(path, "sub"));
		expect(s.branch).toBe("feat/x");
		await until(() => now(home, s.id).step === "waiting", 8000);
		expect(existsSync(join(path, "sub", "a.txt"))).toBe(true);
		expect(git(path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/x");
		const { close } = register(home, now(home, s.id));
		// No first message: registered is enough.
		await until(() => now(home, s.id).step === "done", 5000);
		close();
		tmux("kill-session", "-t", `=${s.session}`);

		const refuse = (p: Record<string, unknown>) =>
			code(
				home.service.launches.launch(VERIFIED, null, {
					nonce: nonce(),
					cwd: repo,
					harness: "pi",
					workspace: "worktree",
					...p,
				}),
			);
		expect(await refuse({ branch: "feat/x" })).toBe("bad_request");
		expect(await refuse({ branch: "bad..name" })).toBe("bad_request");
		expect(await refuse({ base: "no-such-branch" })).toBe("bad_request");
		expect(
			await code(
				home.service.launches.launch(VERIFIED, null, {
					nonce: nonce(),
					cwd: project,
					harness: "pi",
					workspace: "worktree",
				}),
			),
		).toBe("bad_request");
	});

	test("an agent Pulsar can't push to gets no message; the launch says so", async () => {
		mode = "plain";
		const before = sends.length;
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
			prompt: "x",
		});
		await until(() => now(home, s.id).step === "waiting", 5000);
		const pid = Number(
			tmux(
				"display-message",
				"-p",
				"-t",
				`=${s.session}:`,
				"#{pane_pid}",
			).trim(),
		);
		// Found by a scan only: idle, but nothing reaches its session.
		const agent = home.service.registry.upsert({
			harness: "pi",
			sessionId: `scan-${pid}`,
			pid,
			cwd: project,
			project: "proj",
			branch: null,
			tags: [],
			meta: {},
			registered: false,
			status: "idle",
		});
		expect(agent.reach).toBe("pull");
		await until(() => now(home, s.id).step === "failed", 8000);
		expect(now(home, s.id).error).toContain("can't reach its session");
		expect(sends.length).toBe(before);
		home.service.registry.markGone(agent);
		tmux("kill-session", "-t", `=${s.session}`);
	});

	test("a folder reached through a symlink: the worktree lands next to the real repo", async () => {
		mode = "plain";
		const repo = join(HOME, "repo2");
		mkdirSync(join(repo, "sub"), { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "sub", "a.txt"), "a");
		git(repo, "add", ".");
		git(repo, "commit", "-q", "-m", "one");
		const link = join(root, "linked-repo");
		symlinkSync(repo, link);
		const s = await home.service.launches.launch(VERIFIED, null, {
			nonce: nonce(),
			cwd: join(link, "sub"),
			harness: "pi",
			workspace: "worktree",
			branch: "via-link",
		});
		expect(s.cwd).toBe(join(HOME, "repo2-via-link", "sub"));
		await until(() => now(home, s.id).step === "waiting", 8000);
		expect(existsSync(join(HOME, "repo2-via-link", "sub", "a.txt"))).toBe(true);
		tmux("kill-session", "-t", `=${s.session}`);
	});

	test("two presses at once start one launch", async () => {
		mode = "plain";
		const p = {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
		};
		const [a, b] = await Promise.all([
			home.service.launches.launch(VERIFIED, null, p),
			home.service.launches.launch(VERIFIED, null, p),
		]);
		expect(b.id).toBe(a.id);
		await until(() => now(home, a.id).step === "waiting", 5000);
		tmux("kill-session", "-t", `=${a.session}`);
	});

	test("a missing folder is refused before anything starts", async () => {
		expect(
			await code(
				home.service.launches.launch(VERIFIED, null, {
					nonce: nonce(),
					cwd: join(HOME, "nope"),
					harness: "pi",
					workspace: "current",
				}),
			),
		).toBe("not_found");
	});
});

describe("the installed-harness probe", () => {
	/**
	 * A fake login shell like an operator's zsh: a banner, stderr noise and a
	 * terminal's escape codes with no newline before the probe's own output,
	 * then the real probe script, with claude and codex on its PATH. Counts
	 * its runs; sleeps `slow` seconds first while that file holds a number.
	 */
	function fakeShell() {
		const dir = mkdtempSync(join(root, "probe-"));
		const bin = join(dir, "bin");
		mkdirSync(bin);
		for (const b of ["claude", "codex", "codex-acp", "pulsar"])
			writeFileSync(join(bin, b), "#!/bin/sh\n", { mode: 0o755 });
		const count = join(dir, "runs");
		const slow = join(dir, "slow");
		const sh = join(dir, "fake-sh");
		writeFileSync(count, "");
		writeFileSync(
			sh,
			[
				"#!/bin/sh",
				`echo run >> '${count}'`,
				`if [ -s '${slow}' ]; then sleep "$(cat '${slow}')"; fi`,
				'echo "Welcome back!"',
				'echo "rc: compinit: insecure directories" >&2',
				"printf '\\033]1337;RemoteHost=me@mac\\007\\033]1337;CurrentDir=/Users/me\\007\\033[?2004h'",
				`PATH='${bin}:/usr/bin:/bin'; export PATH`,
				"shift",
				'exec /bin/sh -c "$1"',
				"",
			].join("\n"),
			{ mode: 0o755 },
		);
		const runs = () =>
			readFileSync(count, "utf8").split("\n").filter(Boolean).length;
		return { sh, slow, runs };
	}
	const launches = (shell: string, timing: Record<string, number>) =>
		new Launches({
			registry: { all: () => [], pool: null },
			machineId: () => "m1",
			machine: () => "m1",
			shell,
			timing,
		} as unknown as LaunchDeps);
	const installed = (o: LaunchOptions) =>
		o.harnesses.filter((h) => h.installed).map((h) => h.id);

	test("escape codes, a banner and stderr noise hide no harness", async () => {
		const f = fakeShell();
		const o = await launches(f.sh, {}).options();
		expect(o.checked).toBe(true);
		expect(installed(o)).toEqual(["claude", "codex"]);
		expect(o.harnesses.find((h) => h.id === "claude")?.mode).toBe("native");
		expect(o.harnesses.find((h) => h.id === "codex")?.mode).toBe("acp");
	});

	test("the marked lines are read anywhere in the output, escapes stripped", () => {
		const out =
			"\x1b]1337;RemoteHost=a@b\x07\x1b]1337;CurrentDir=/x\x1b\\PULSAR_BIN:claude:/u/bin/claude\n" +
			"\x1b[1mPULSAR_BIN:pi:/u/bin/pi\x1b[0m\nPULSAR_BIN:omp:alias omp=x\n/u/bin/codex\n";
		expect([...parseProbe(out)]).toEqual(["claude", "pi"]);
	});

	test("a slow login shell: reads say not checked yet, then its answer is kept", async () => {
		const f = fakeShell();
		writeFileSync(f.slow, "1");
		const l = launches(f.sh, { probeMs: 5000, probeWaitMs: 200 });
		const first = await l.options();
		expect(first.checked).toBe(false);
		expect(installed(first)).toEqual([]);
		await until(async () => (await l.options()).checked === true, 4000);
		expect(installed(await l.options())).toEqual(["claude", "codex"]);
		expect(f.runs()).toBe(1);
	});

	test("a probe that timed out is not kept; the next read asks again", async () => {
		const f = fakeShell();
		writeFileSync(f.slow, "2");
		const l = launches(f.sh, { probeMs: 300, probeWaitMs: 1000 });
		expect((await l.options()).checked).toBe(false);
		writeFileSync(f.slow, "");
		const o = await l.options();
		expect(o.checked).toBe(true);
		expect(installed(o)).toEqual(["claude", "codex"]);
		expect(f.runs()).toBe(2);
		// A finished probe is kept.
		await l.options();
		expect(f.runs()).toBe(2);
	});

	test("reads at the same time share one login shell", async () => {
		const f = fakeShell();
		const l = launches(f.sh, {});
		const all = await Promise.all([l.options(), l.options(), l.options()]);
		for (const o of all) expect(installed(o)).toEqual(["claude", "codex"]);
		expect(f.runs()).toBe(1);
	});
});

describe("this machine by name", () => {
	test("its name (any case, with a domain) reads and launches here, like its id", async () => {
		const l = home.service.launches;
		for (const m of [
			home.service.machineId,
			"home",
			"HOME",
			"home.tail-fake.ts.net",
		]) {
			const o = (await l.read(VERIFIED, m, {
				op: "launch.options",
			})) as LaunchOptions;
			expect(o.machineId).toBe(home.service.machineId);
			const r = (await l.read(VERIFIED, m, {
				op: "launch.refs",
				cwd: project,
			})) as LaunchRefs;
			expect(r.root).toBeNull();
		}
		expect(
			await code(l.read(VERIFIED, "elsewhere", { op: "launch.options" })),
		).toBe("not_found");
		if (!HAS_TMUX) return;
		mode = "plain";
		const s = await l.launch(VERIFIED, "HOME", {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
		});
		expect(s.machineId).toBe(home.service.machineId);
		expect(s.id.includes("/")).toBe(false);
		await until(() => now(home, s.id).step === "waiting", 5000);
		tmux("kill-session", "-t", `=${s.session}`);
	});
});

describe("who may launch", () => {
	const p = () => ({
		nonce: nonce(),
		cwd: project,
		harness: "pi",
		workspace: "current",
	});
	test("only the operator with a passkey session; agents and the terminal never", async () => {
		const l = home.service.launches;
		expect(await code(l.launch(USER, null, p()))).toBe("session_required");
		expect(
			await code(l.launch({ kind: "agent", agentId: "pi:x" }, null, p())),
		).toBe("forbidden");
		expect(await code(l.launch({ kind: "terminal" }, null, p()))).toBe(
			"forbidden",
		);
		expect(
			await code(l.read({ kind: "terminal" }, null, { op: "launch.options" })),
		).toBe("forbidden");
	});

	test("options list folders agents used and harnesses a login shell finds", async () => {
		const cwd = join(HOME, "options-project");
		mkdirSync(cwd);
		home.service.registry.upsert({
			...registration({ sessionId: "options-project", cwd }),
			meta: {},
			registered: false,
		});
		const o = (await home.service.launches.read(VERIFIED, null, {
			op: "launch.options",
		})) as LaunchOptions;
		expect(o.machine).toBe("home");
		expect(o.home).toBe(HOME);
		expect(o.projects.some((x) => x.path === cwd)).toBe(true);
		expect(o.harnesses.map((h) => h.id)).toEqual(
			Object.keys(LAUNCH_HARNESSES) as LaunchHarness[],
		);
		// The login shell's PATH (the temp HOME's profile), not the daemon's.
		expect(o.harnesses.find((h) => h.id === "codex")?.installed).toBe(true);
		expect(o.harnesses.find((h) => h.id === "antigravity")?.installed).toBe(
			true,
		);
	});
});

describe.skipIf(!HAS_TMUX)("launching on another machine", () => {
	async function sign(params: unknown) {
		const options = (await relay.service.acting.options(
			USER,
			"agents.launch",
			{ machine: "home" },
			params,
		)) as { challenge: string };
		return phone.assert(options, { origin: originOf("relay") });
	}

	test("the home node verifies and runs it; the relay follows its steps", async () => {
		mode = "plain";
		const params = {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
			prompt: "remote hello",
		};
		const assertion = await sign(params);
		const s = await relay.service.launches.launch(
			USER,
			"home",
			params,
			assertion,
		);
		const hid = home.service.machineId;
		expect(s.id.startsWith(`${hid}/`)).toBe(true);
		const localId = s.id.slice(hid.length + 1);
		await until(() => now(home, localId)?.step === "waiting", 5000);
		const { agent, close } = register(home, now(home, localId));
		try {
			home.service.registry.setStatus(agent, "idle");
			await until(() => now(relay, s.id).step === "done", 8000);
			expect(now(relay, s.id).agentId).toBe(`${hid}/${agent.id}`);
			// Sent on the home node, as the verified operator.
			expect(sends.at(-1)).toMatchObject({ node: "home", agentId: agent.id });
			expect(sends.at(-1)!.body).toContain("remote hello");
			// The app opens its session next: this node's pool has it.
			expect(relay.service.registry.find(`${hid}/${agent.id}`)).toBeDefined();
			// Interest on both nodes: the relay by pool address, home by local id.
			expect(relay.service.interest.has(`${hid}/${agent.id}`)).toBe(true);
			expect(home.service.interest.has(agent.id)).toBe(true);
			// The relay's own stream carried the steps.
			expect(states.get(s.id)!.at(-1)!.step).toBe("done");
			// Reads go to the home node too.
			const o = (await relay.service.launches.read(USER, "home", {
				op: "launch.options",
			})) as LaunchOptions;
			expect(o.machine).toBe("home");
			const st = (await relay.service.launches.read(USER, "home", {
				op: "launch.status",
				id: localId,
			})) as LaunchState;
			expect(st.id).toBe(s.id);
		} finally {
			close();
			tmux("kill-session", "-t", `=${now(home, localId).session}`);
		}
	});

	test("malformed params are refused at the home node, signed or not", async () => {
		const bad = {
			nonce: nonce(),
			cwd: "relative",
			harness: "pi",
			workspace: "current",
		};
		const assertion = await sign(bad);
		expect(
			await code(relay.service.launches.launch(USER, "home", bad, assertion)),
		).toBe("bad_request");
		const evil = { ...bad, cwd: project, harness: "pi; rm -rf /" };
		expect(
			await code(
				relay.service.launches.launch(USER, "home", evil, await sign(evil)),
			),
		).toBe("bad_request");
		// Without an assertion nothing reaches it.
		expect(
			await code(
				relay.service.launches.launch(USER, "home", { ...bad, cwd: project }),
			),
		).toBe("session_required");
	});
});

describe.skipIf(!HAS_TMUX)("over HTTP", () => {
	let http: HttpTransport;
	let base: string;
	let origin: string;
	let key: SoftAuthenticator;
	const api = async <T = Record<string, unknown>>(
		method: string,
		path: string,
		body?: unknown,
		token?: string,
	) => {
		const res = await fetch(`${base}/api/v1${path}`, {
			method,
			headers: {
				"X-Pulsar": "1",
				Origin: origin,
				...(token ? { Authorization: `Bearer ${token}` } : {}),
				...(body !== undefined ? { "Content-Type": "application/json" } : {}),
			},
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		return { status: res.status, body: (await res.json()) as T };
	};

	beforeAll(async () => {
		http = new HttpTransport(home.service, {
			identity: new StaticIdentity(OWNER, "phone"),
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
			hub: { coalesceMs: 30 },
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}`;
		origin = `http://localhost:${http.port}`;
		key = new SoftAuthenticator({ origin, rpId: "localhost" });
		const o = await api<{ options: never }>(
			"POST",
			"/passkeys/register/options",
			{
				label: "Mac",
			},
		);
		expect(
			(
				await api("POST", "/passkeys/register/verify", {
					response: key.register(o.body.options),
				})
			).status,
		).toBe(200);
	});
	afterAll(() => http.close());

	test("routes, the session gate, and launch events on the stream", async () => {
		mode = "plain";
		const hello = await api<{ features: string[] }>("GET", "/hello");
		expect(hello.body.features).toContain("launch");
		const mid = home.service.machineId;
		const opts = await api<LaunchOptions>("GET", `/machines/${mid}/projects`);
		expect(opts.status).toBe(200);
		expect(opts.body.machine).toBe("home");
		const refs = await api<LaunchRefs>(
			"GET",
			`/machines/home/refs?cwd=${encodeURIComponent(join(HOME, "repo"))}`,
		);
		expect(refs.body.current).toBe("main");
		expect((await api("GET", "/machines/nowhere/projects")).status).toBe(404);
		// By name, as the app sends it (its machine list is names): the same
		// answer as by id, with the login shell's probe.
		for (const m of [mid, "home", "HOME", "home.tail-fake.ts.net", "local"]) {
			const byName = await api<LaunchOptions>("GET", `/machines/${m}/projects`);
			expect(byName.status).toBe(200);
			expect(byName.body.machineId).toBe(mid);
			expect(byName.body.checked).toBe(true);
			expect(
				byName.body.harnesses.find((h) => h.id === "codex")?.installed,
			).toBe(true);
		}

		// The stream hears launch events.
		const ac = new AbortController();
		const res = await fetch(`${base}/api/v1/events`, {
			headers: { "X-Pulsar": "1", Origin: origin },
			signal: ac.signal,
		});
		let text = "";
		void (async () => {
			const reader = res.body!.getReader();
			const dec = new TextDecoder();
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					text += dec.decode(value);
				}
			} catch {}
		})();
		await until(() => text.includes("event: ready") || text.length > 0, 3000);

		const params = {
			nonce: nonce(),
			cwd: project,
			harness: "pi",
			workspace: "current",
		};
		const refused = await api<{ error: { code: string } }>(
			"POST",
			"/agents/launch",
			{
				params,
			},
		);
		expect(refused.status).toBe(401);
		expect(refused.body.error.code).toBe("session_required");

		const so = await api<{ requestId: string; options: never }>(
			"POST",
			"/session/options",
			{
				device: "Mac",
			},
		);
		const sv = await api<{ token: string }>("POST", "/session/verify", {
			requestId: so.body.requestId,
			assertion: key.assert(so.body.options),
		});
		const token = sv.body.token;
		const bad = await api(
			"POST",
			"/agents/launch",
			{ params: { ...params, harness: "sh" } },
			token,
		);
		expect(bad.status).toBe(400);
		const r = await api<LaunchState>(
			"POST",
			"/agents/launch",
			{ params },
			token,
		);
		expect(r.status).toBe(200);
		await until(
			() => text.includes("event: launch") && text.includes(r.body.id),
			5000,
		);
		const got = await api<LaunchState>("GET", `/launches/${r.body.id}`);
		expect(got.body.id).toBe(r.body.id);
		expect((await api("GET", "/launches/nope")).status).toBe(404);
		ac.abort();
		await until(() => now(home, r.body.id).step === "waiting", 5000);
		tmux("kill-session", "-t", `=${r.body.session}`);
	});
});
