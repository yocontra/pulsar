/**
 * Fake agents for a live pulsar node: registers N agents over the daemon's
 * own socket, the way the MCP server and the pi extension do.
 *
 * - varied harness names, projects and branches;
 * - `reviewer` (extension role): replies to every message and answers Stop
 *   like the pulsar extension (busy until interrupted);
 * - `fixer` (claude): has a Claude-format transcript that grows every few
 *   seconds, with an Edit of src/auth/session.ts (for Ask and the session view).
 *
 * Self-contained (node:net only), so it runs where only the installed
 * package exists. Node 22.18+ runs it as is:
 * `PULSAR_HOME=<test state> node fake-agents.ts [N]`. It refuses to run
 * without an explicit, non-default PULSAR_HOME, and on a Mac with the real
 * HOME. Stop with Ctrl-C.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const N = Number(process.argv[2] ?? 6);

// Safety: fake agents reply to whoever messages them. Never run them on a
// real pulsar (yours, with your real agents): require an explicit test state
// folder, and on a Mac a throwaway HOME too.
const STATE = process.env.PULSAR_HOME ?? "";
const realState = join(homedir(), ".local", "state", "pulsar");
if (!STATE || resolve(STATE) === resolve(realState)) {
	console.error(
		`refusing to run: set PULSAR_HOME to a test state folder (not ${realState})`,
	);
	process.exit(2);
}
if (
	process.platform === "darwin" &&
	!resolve(homedir()).startsWith(resolve(tmpdir())) &&
	!resolve(homedir()).startsWith("/private/tmp") &&
	!resolve(homedir()).startsWith("/tmp")
) {
	console.error(
		"refusing to run on a Mac with your real HOME: set HOME to a temp folder (fake agents belong in the test container)",
	);
	process.exit(2);
}
const SOCKET = join(STATE, "bus.sock");
const PROTOCOL = 1;

type Frame = {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: string; message: string };
	event?: string;
	data?: unknown;
};

class Client {
	private sock: Socket;
	private next = 1;
	private pending = new Map<
		number,
		{ ok: (v: unknown) => void; fail: (e: Error) => void }
	>();
	private handlers = new Map<string, (data: unknown) => void>();

	constructor(path: string) {
		this.sock = connect(path);
		let buf = "";
		this.sock.setEncoding("utf8");
		this.sock.on("data", (chunk: string) => {
			buf += chunk;
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				if (!line.trim()) continue;
				const f = JSON.parse(line) as Frame;
				if (f.event) this.handlers.get(f.event)?.(f.data);
				else if (f.id !== undefined) {
					const p = this.pending.get(f.id);
					this.pending.delete(f.id);
					if (f.error)
						p?.fail(new Error(`${f.error.code}: ${f.error.message}`));
					else p?.ok(f.result);
				}
			}
		});
		this.sock.on("error", (e) => {
			console.error(`socket error: ${e.message} (${path})`);
			process.exit(1);
		});
	}

	call<T>(method: string, params: unknown = {}): Promise<T> {
		const id = this.next++;
		this.sock.write(`${JSON.stringify({ id, method, params })}\n`);
		return new Promise<T>((ok, fail) =>
			this.pending.set(id, { ok: ok as (v: unknown) => void, fail }),
		);
	}

	on(event: string, fn: (data: unknown) => void) {
		this.handlers.set(event, fn);
	}

	close() {
		this.sock.end();
	}
}

interface Spec {
	name: string;
	harness: string;
	project: string;
	branch: string;
	role?: "mcp" | "extension";
	sessionId?: string;
	cwd?: string;
}

const FIXER_SESSION = "0000aaaa-1111-4222-8333-444455556666";
const specs: Spec[] = [
	{
		name: "fixer",
		harness: "claude",
		project: "demo",
		branch: "fix-1378",
		sessionId: FIXER_SESSION,
		cwd: "/work/demo",
	},
	{
		name: "reviewer",
		harness: "pi",
		project: "demo",
		branch: "main",
		role: "extension",
	},
	{ name: "docs-writer", harness: "omp", project: "demo", branch: "docs" },
	{ name: "api-1", harness: "codex", project: "api", branch: "feat/billing" },
	{ name: "api-2", harness: "opencode", project: "api", branch: "main" },
	{ name: "infra", harness: "gemini", project: "infra", branch: "main" },
];
for (let i = specs.length; i < N; i++)
	specs.push({
		name: `extra-${i}`,
		harness: ["codex", "pi", "omp"][i % 3]!,
		project: ["api", "demo", "infra"][i % 3]!,
		branch: `task-${i}`,
	});

/** A Claude-format transcript for `fixer`, where the daemon looks for it. */
function claudeTranscript(): string {
	const config = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
	const dir = join(
		config,
		"projects",
		"/work/demo".replace(/[^a-zA-Z0-9]/g, "-"),
	);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${FIXER_SESSION}.jsonl`);
	const t = (s: number) =>
		new Date(Date.now() - 600_000 + s * 1000).toISOString();
	const lines = [
		{
			type: "user",
			uuid: "u-1",
			timestamp: t(0),
			message: {
				role: "user",
				content: "Fix the token refresh race in src/auth/session.ts",
			},
		},
		{
			type: "assistant",
			uuid: "a-1",
			timestamp: t(1),
			message: {
				id: "msg_1",
				role: "assistant",
				model: "claude-fable-5-2",
				content: [
					{
						type: "text",
						text: "Two requests refresh at once; I'll put refresh() behind a lock.",
					},
				],
			},
		},
		{
			type: "assistant",
			uuid: "a-2",
			timestamp: t(2),
			message: {
				id: "msg_2",
				role: "assistant",
				model: "claude-fable-5-2",
				content: [
					{
						type: "tool_use",
						id: "toolu_1",
						name: "Edit",
						input: {
							file_path: "/work/demo/src/auth/session.ts",
							old_string: "refresh()",
							new_string: "await lock.run(() => refresh())",
						},
					},
				],
			},
		},
		{
			type: "user",
			uuid: "u-2",
			timestamp: t(3),
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_1",
						content: "The file has been updated.",
					},
				],
			},
		},
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}

const transcript = claudeTranscript();
let tick = 0;
setInterval(() => {
	tick++;
	appendFileSync(
		transcript,
		`${JSON.stringify({
			type: "assistant",
			uuid: `live-${tick}`,
			timestamp: new Date().toISOString(),
			message: {
				id: `msg_live_${tick}`,
				role: "assistant",
				model: "claude-fable-5-2",
				content: [
					{
						type: "text",
						text: `live line ${tick}: still on the refresh race`,
					},
				],
			},
		})}\n`,
	);
}, 5000).unref();

const clients: Client[] = [];
// `FAKE_NAMES=a,b` registers only those (a second node's few agents).
const only = process.env.FAKE_NAMES?.split(",").filter(Boolean);
for (const s of only ? specs.filter((x) => only.includes(x.name)) : specs) {
	const c = new Client(SOCKET);
	clients.push(c);
	const r = await c.call<{ agent: { id: string } }>("hello", {
		protocol: PROTOCOL,
		registration: {
			harness: s.harness,
			sessionId: s.sessionId ?? `${s.name}-${process.pid}`,
			pid: null,
			cwd: s.cwd ?? `/work/${s.project}`,
			project: s.project,
			branch: s.branch,
			tags: [
				`harness:${s.harness}`,
				`project:${s.project}`,
				`branch:${s.branch}`,
				"live-test",
			],
			name: s.name,
			role: s.role ?? "mcp",
		},
	});
	console.log(`registered ${s.name} (${r.agent.id})`);
	if (s.name === "fixer") {
		await c.call("set_status", { status: "busy" });
		await c.call("set_identity", {
			activity: "fixing the refresh race (#1378)",
		});
	}
	if (s.name === "reviewer") {
		let busy = true;
		await c.call("set_status", { status: "busy" });
		c.on("push", (d) => {
			const { message } = d as { message: { id: string; body: string } };
			void c.call("reply", {
				messageId: message.id,
				body: `reviewer got: ${message.body}`,
			});
		});
		c.on("interrupt", (d) => {
			const { requestId } = d as { requestId: string };
			void c.call("interrupt_result", {
				requestId,
				result: busy ? "interrupted" : "not-running",
			});
			busy = false;
			void c.call("set_status", { status: "idle" });
		});
	}
}
console.log(
	`${only?.length ?? specs.length} fake agents on ${SOCKET}; transcript ${transcript}`,
);
const stop = () => {
	for (const c of clients) c.close();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
