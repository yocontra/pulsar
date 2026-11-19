import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Federation } from "../src/federation/index.ts";
import { PoolMembers } from "../src/federation/members.ts";
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
	parseLaunchParams,
	terminalDialog,
} from "../src/service/launch.ts";
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
const sends: { node: string; agentId: string; body: string }[] = [];

writeFileSync(
	FAKE,
	`#!/bin/sh
# $1: plain | trust | exit; $2: where typed lines go
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
			command: () => {
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
			send: async (_user, agentId, body) => {
				sends.push({ node: name, agentId, body });
				return "sent";
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
function register(n: Node, s: LaunchState, harness: LaunchHarness = "pi") {
	const pid = Number(
		tmux("display-message", "-p", "-t", `=${s.session}:`, "#{pane_pid}").trim(),
	);
	const controller = new AbortController();
	const caller: Caller = {
		principal: { kind: "terminal" },
		closed: controller.signal,
		emit: () => {},
	};
	n.service.attach(caller);
	n.service.setRole(caller, "extension");
	const agent = n.service.registerAgent(
		caller,
		registration({ harness, pid, cwd: s.cwd, project: "demo" }),
	);
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

	test("each harness starts with its fixed command and no flags", () => {
		for (const h of Object.keys(LAUNCH_HARNESSES) as LaunchHarness[])
			expect(harnessCommand(h)).toMatch(/^exec [a-z]+$/);
		expect(harnessCommand("claude")).toBe("exec claude");
		expect(harnessCommand("codex")).toBe("exec codex");
		expect(harnessCommand("opencode")).toBe("exec opencode");
		expect(harnessCommand("pi")).toBe("exec pi");
		expect(harnessCommand("omp")).toBe("exec omp");
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
		expect(
			tmux(
				"display-message",
				"-p",
				"-t",
				`=${s.session}:`,
				"#{pane_current_path}",
			).trim(),
		).toBe(project);
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
			expect(sends.at(-1)).toEqual({
				node: "home",
				agentId: agent.id,
				body: "fix the login bug",
			});
			// Stop and typing reach it through its pane.
			const pane = tmux(
				"display-message",
				"-p",
				"-t",
				`=${s.session}:`,
				"#{pane_id}",
			).trim();
			expect(agent.meta.tmux).toBe(pane);
			expect(home.service.app.agent(VERIFIED, agent.id).tmux).toBe(pane);
			expect(agent.name).toBe("login-fixer");
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
			expect(sends.at(-1)?.body).toBe("hello");
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
		const o = (await home.service.launches.read(VERIFIED, null, {
			op: "launch.options",
		})) as LaunchOptions;
		expect(o.machine).toBe("home");
		expect(o.home).toBe(HOME);
		expect(o.projects.some((x) => x.path === project)).toBe(true);
		expect(o.harnesses.map((h) => h.id)).toEqual([
			"claude",
			"codex",
			"opencode",
			"pi",
			"omp",
		]);
		// The login shell's PATH (the temp HOME's profile), not the daemon's.
		expect(o.harnesses.find((h) => h.id === "codex")?.installed).toBe(true);
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
			expect(sends.at(-1)).toEqual({
				node: "home",
				agentId: agent.id,
				body: "remote hello",
			});
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
