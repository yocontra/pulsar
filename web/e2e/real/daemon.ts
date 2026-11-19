/**
 * A real pulsar daemon for the `@real` end-to-end suite: HTTP in dev mode
 * (PULSAR_DEV_IDENTITY-style, 127.0.0.1) serving the built app from
 * dist/web, with fake agents registered over the daemon's own socket.
 *
 * Everything lives in a fresh temp HOME and PULSAR_HOME, scanners off, so
 * the user's daemon, agents and ~/.claude are never touched.
 *
 * - `fixer`: a Claude session whose transcript is the repo's Claude fixture;
 *   `POST /append` on the control port appends records so it streams live.
 * - `reviewer`: an extension-role pi agent; it replies to every message and
 *   answers Stop like the pulsar extension (busy until interrupted).
 * - `differ`: an agent whose folder is a temp git repo with uncommitted
 *   work; `POST /edit?path=&text=` on the control port changes a file.
 * - a few more agents across two projects; one needs the user.
 *
 *   bun web/e2e/real/daemon.ts   # app on PULSAR_REAL_PORT (47392), control on +1
 */
import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SAMPLE_PDF, SCREENSHOT } from "../../mock/images.ts";

const PORT = Number(process.env.PULSAR_REAL_PORT ?? 47392);
export const LOGIN = "you@example.com";
const FIXTURE = resolve(
	import.meta.dir,
	"../../../test/fixtures/transcripts/claude/session.jsonl",
);
const SESSION = "0000aaaa-1111-4222-8333-444455556666";
const CWD = "/work/demo";

const root = mkdtempSync(join(tmpdir(), "pulsar-real-e2e-"));
const home = join(root, "home");
process.env.HOME = home;
process.env.PULSAR_HOME = join(root, "state");
process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
delete process.env.XDG_STATE_HOME;
mkdirSync(process.env.PULSAR_HOME, { recursive: true });
const projectDir = join(
	home,
	".claude",
	"projects",
	CWD.replace(/[^a-zA-Z0-9]/g, "-"),
);
mkdirSync(projectDir, { recursive: true });
const transcript = join(projectDir, `${SESSION}.jsonl`);
copyFileSync(FIXTURE, transcript);
// A finished subagent of fixer's session, as Claude Code writes it
// (docs/subagents.md): its own log and a meta file.
const subagents = join(projectDir, SESSION, "subagents");
mkdirSync(subagents, { recursive: true });
const subRecord = (o: object) =>
	`${JSON.stringify({ isSidechain: true, agentId: "a0demo0subagent", timestamp: "2026-11-10T10:00:10.000Z", ...o })}\n`;
writeFileSync(
	join(subagents, "agent-a0demo0subagent.jsonl"),
	subRecord({
		type: "user",
		uuid: "sub-u1",
		message: { role: "user", content: "List every caller of refresh()." },
	}) +
		subRecord({
			type: "assistant",
			uuid: "sub-a1",
			message: {
				id: "msg_sub_1",
				role: "assistant",
				content: [{ type: "text", text: "Found 3 callers of refresh()." }],
			},
		}),
);
writeFileSync(
	join(subagents, "agent-a0demo0subagent.meta.json"),
	JSON.stringify({
		agentType: "Explore",
		description: "Find refresh callers",
		toolUseId: "toolu_demo_task",
		finished: true,
	}),
);

// Imported after the env is set: paths resolve from PULSAR_HOME and HOME.
const { Daemon } = await import("../../../src/daemon.ts");
const { DaemonClient } = await import("../../../src/client.ts");
const { PROTOCOL_VERSION } = await import("../../../src/types.ts");
const { HttpTransport } = await import("../../../src/transport/http.ts");
const { StaticIdentity } = await import("../../../src/http/identity.ts");
type Registration = import("../../../src/types.ts").Registration;
type DeliveredMessage = import("../../../src/types.ts").DeliveredMessage;

const daemon = new Daemon({
	scan: false,
	machine: "studio",
	remote: { mode: "dev", login: LOGIN, port: PORT },
	// Never a real Touch ID prompt from the test daemon (docs/presence.md).
	presence: { native: null },
});
if (!(await daemon.start())) throw new Error("daemon did not start");

async function agent(reg: Partial<Registration> & { name: string }) {
	const client = new DaemonClient();
	await client.connect(false);
	const project = reg.project ?? "demo";
	const harness = reg.harness ?? "pi";
	const r = await client.call<{ agent: { id: string } }>("hello", {
		protocol: PROTOCOL_VERSION,
		registration: {
			harness,
			sessionId: `${reg.name}-session`,
			pid: null,
			cwd: `/work/${project}`,
			project,
			branch: "main",
			tags: [`harness:${harness}`, `project:${project}`, "branch:main"],
			role: "mcp",
			...reg,
		} satisfies Registration,
	});
	return { client, id: r.agent.id };
}

const fixer = await agent({
	name: "fixer",
	harness: "claude",
	sessionId: SESSION,
	cwd: CWD,
	model: "claude-fable-5-2",
});
const reviewer = await agent({ name: "reviewer", role: "extension" });
/** The text of each push the reviewer got, by message id (`GET /push?id=`). */
const pushTexts = new Map<string, string>();
/** Every body the reviewer was pushed, in order (`GET /pushes?body=`). */
const pushBodies: string[] = [];
reviewer.client.on("push", (d) => {
	const { message, text } = d as { message: DeliveredMessage; text: string };
	pushTexts.set(message.id, text);
	pushBodies.push(message.body);
	void reviewer.client.call("reply", {
		messageId: message.id,
		body: `reviewer got: ${message.body}`,
	});
});
// A fake pi host behind the extension protocol: busy until interrupted.
let reviewerBusy = true;
await reviewer.client.call("set_status", { status: "busy" });
reviewer.client.on("interrupt", (d) => {
	const { requestId } = d as { requestId: string };
	const result = reviewerBusy ? "interrupted" : "not-running";
	reviewerBusy = false;
	void reviewer.client.call("interrupt_result", { requestId, result });
	void reviewer.client.call("set_status", { status: "idle" });
});
// A worktree with uncommitted work (the diff viewer), in the temp root.
const repo = join(root, "repo");
mkdirSync(join(repo, "src"), { recursive: true });
const git = (...args: string[]) =>
	execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
		cwd: repo,
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_AUTHOR_NAME: "e2e",
			GIT_AUTHOR_EMAIL: "e2e@example.com",
			GIT_COMMITTER_NAME: "e2e",
			GIT_COMMITTER_EMAIL: "e2e@example.com",
		},
	});
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "src", "lock.ts"), "export const locked = false;\n");
writeFileSync(join(repo, "README.md"), "# demo\n");
git("add", "-A");
git("commit", "-q", "-m", "init");
git("checkout", "-q", "-b", "fix-lock");
writeFileSync(join(repo, "src", "lock.ts"), "export const locked = true;\n");
writeFileSync(join(repo, "NOTES.md"), "- lock first\n");
const differ = await agent({ name: "differ", cwd: repo, branch: "fix-lock" });

const others = [
	await agent({ name: "docs-writer" }),
	await agent({ name: "api-1", project: "api" }),
	await agent({ name: "api-2", project: "api" }),
	await agent({ name: "api-3", project: "api", harness: "codex" }),
];
// Benchmarks only (web/scripts/listperf.ts): a long Claude session copied
// from PULSAR_REAL_BIG_TRANSCRIPT, to time opening a big chat.
const bigLog = process.env.PULSAR_REAL_BIG_TRANSCRIPT;
const bigchat = bigLog
	? await (async () => {
			const session = "0000bbbb-1111-4222-8333-444455556666";
			const cwd = "/work/big";
			const dir = join(
				home,
				".claude",
				"projects",
				cwd.replace(/[^a-zA-Z0-9]/g, "-"),
			);
			mkdirSync(dir, { recursive: true });
			copyFileSync(bigLog, join(dir, `${session}.jsonl`));
			return agent({
				name: "bigchat",
				harness: "claude",
				sessionId: session,
				cwd,
				project: "big",
			});
		})()
	: null;
await fixer.client.call("set_status", { status: "busy" });
await fixer.client.call("set_identity", {
	activity: "fixing the refresh race",
});
// The big chat waits on the user too, so both layouts list it on the home screen.
if (bigchat)
	daemon.service.registry.setNeedsYou(bigchat.id, {
		reason: "asked",
		detail: "Ready for review?",
	});
daemon.service.registry.setNeedsYou(others[0]!.id, {
	reason: "asked",
	detail: "Which README section should the lock note go in?",
});

let n = 0;
/** Appends one assistant record to the fixer's transcript (a live event). */
function append(text: string) {
	n++;
	const record = {
		type: "assistant",
		uuid: `live-${n}`,
		parentUuid: null,
		isSidechain: false,
		timestamp: new Date().toISOString(),
		message: {
			id: `msg_live_${n}`,
			role: "assistant",
			model: "claude-fable-5-2",
			content: [{ type: "text", text }],
		},
	};
	appendFileSync(transcript, `${JSON.stringify(record)}\n`);
	return record.uuid;
}

/** Appends a Read of a PDF and a tool screenshot to the fixer's transcript. */
function appendMedia() {
	n++;
	const ts = new Date().toISOString();
	const call = `toolu_media_${n}`;
	const shot = `toolu_shot_${n}`;
	const records = [
		{
			type: "assistant",
			uuid: `media-a-${n}`,
			timestamp: ts,
			message: {
				id: `msg_media_${n}`,
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: call,
						name: "Read",
						input: { file_path: "/work/demo/docs/refresh-flow.pdf" },
					},
					{
						type: "tool_use",
						id: shot,
						name: "mcp__browser__screenshot",
						input: { url: "http://localhost:3000" },
					},
				],
			},
		},
		{
			type: "user",
			uuid: `media-u-${n}`,
			timestamp: ts,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: call,
						content: [
							{ type: "text", text: "PDF file read" },
							{
								type: "document",
								source: {
									type: "base64",
									media_type: "application/pdf",
									data: Buffer.from(SAMPLE_PDF).toString("base64"),
								},
							},
						],
					},
					{
						type: "tool_result",
						tool_use_id: shot,
						content: [
							{
								type: "image",
								source: {
									type: "base64",
									media_type: "image/png",
									data: Buffer.from(SCREENSHOT).toString("base64"),
								},
							},
						],
					},
				],
			},
		},
	];
	appendFileSync(
		transcript,
		records.map((r) => `${JSON.stringify(r)}\n`).join(""),
	);
}

/**
 * `POST /presence?login=…[&as=terminal]`: a fresh connection runs `pulsar
 * pool owner <login>` (a presence check: the app's confirm card,
 * docs/presence.md), as a new agent "asker" or as a terminal (no agent).
 * `GET /presence` reports how it ended. `DELETE /presence` hangs up, which
 * takes a pending card down, so one test's card never leaks into the next.
 */
let presence: {
	state: "pending" | "done" | "error";
	result: unknown;
	agent: string;
} | null = null;
let asker: { close: () => void } | null = null;
let askers = 0;

async function ask(login: string, asTerminal: boolean) {
	asker?.close();
	let client: InstanceType<typeof DaemonClient>;
	let id = "cli:operator";
	if (asTerminal) {
		client = new DaemonClient();
		await client.connect(false);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			registration: { role: "cli" },
		});
	} else {
		const a = await agent({
			name: "asker",
			sessionId: `asker-${++askers}`,
			project: "api",
		});
		client = a.client;
		id = a.id;
	}
	asker = client;
	const mine = { state: "pending" as const, result: null, agent: id };
	presence = mine;
	client.call("pool.change", { verb: "owner", target: login }, 0).then(
		(r) => {
			if (presence?.agent === id)
				presence = { state: "done", result: r, agent: id };
		},
		(e: { code?: string; message?: string }) => {
			if (presence?.agent === id)
				presence = {
					state: "error",
					result: { code: e.code, message: e.message },
					agent: id,
				};
		},
	);
}

const control = createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://x");
	if (url.pathname === "/presence") {
		if (req.method === "POST")
			await ask(
				url.searchParams.get("login") ?? "live@example.com",
				url.searchParams.get("as") === "terminal",
			);
		if (req.method === "DELETE") {
			asker?.close();
			asker = null;
			presence = null;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(presence ?? {}));
		return;
	}
	if (req.method === "POST" && url.pathname === "/append-media") {
		appendMedia();
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ agent: fixer.id }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/append") {
		const id = append(url.searchParams.get("text") ?? "live update");
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ id, agent: fixer.id }));
		return;
	}
	if (req.method === "POST" && url.pathname === "/edit") {
		const path = url.searchParams.get("path") ?? "NOTES.md";
		if (path.includes("..") || path.startsWith("/")) {
			res.writeHead(400).end();
			return;
		}
		appendFileSync(
			join(repo, path),
			`${url.searchParams.get("text") ?? "edit"}\n`,
		);
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ agent: differ.id }));
		return;
	}
	if (url.pathname === "/pushes") {
		// How many pushes carrying this text the reviewer got (a send sent once).
		const body = url.searchParams.get("body") ?? "";
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				count: pushBodies.filter((b) => b.includes(body)).length,
			}),
		);
		return;
	}
	if (url.pathname === "/push") {
		// The exact text the daemon pushed; with `replay`, also written to the
		// fixer's transcript as Claude records a Pulsar push (a peer message).
		const id = url.searchParams.get("id") ?? "";
		const text = pushTexts.get(id) ?? null;
		if (text && req.method === "POST") {
			const record = {
				type: "user",
				uuid: `push-${id}`,
				timestamp: new Date().toISOString(),
				isMeta: true,
				origin: {
					kind: "peer",
					from: "unknown",
					name: "user via Pulsar",
					body: text,
				},
				message: {
					role: "user",
					content: `Another Claude session sent a message:\n<cross-session-message from-name="user via Pulsar">\n${text}\n</cross-session-message>`,
				},
			};
			appendFileSync(transcript, `${JSON.stringify(record)}\n`);
		}
		res.writeHead(text ? 200 : 404, { "content-type": "application/json" });
		res.end(JSON.stringify({ text, agent: fixer.id }));
		return;
	}
	if (url.pathname === "/agents") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				fixer: fixer.id,
				reviewer: reviewer.id,
				differ: differ.id,
				others: others.map((o) => o.id),
				...(bigchat ? { bigchat: bigchat.id } : {}),
			}),
		);
		return;
	}
	res.writeHead(404).end();
});
control.listen(
	Number(process.env.PULSAR_REAL_CONTROL_PORT ?? PORT + 1),
	"127.0.0.1",
);
// TLS too (the TLS e2e and the benchmark): the same daemon behind HTTPS with
// a throwaway self-signed certificate for localhost, HTTP/2 like a real
// node's server (PULSAR_REAL_TLS_H1=1: HTTP/1.1 only, the baseline).
// PULSAR_REAL_TLS_HOSTS adds Host values (a latency proxy's port).
const tlsPort = Number(process.env.PULSAR_REAL_TLS_PORT ?? 0);
let tlsApp: InstanceType<typeof HttpTransport> | null = null;
if (tlsPort) {
	const cert = join(root, "tls-cert.pem");
	const key = join(root, "tls-key.pem");
	execFileSync(
		"openssl",
		[
			"req",
			"-x509",
			"-newkey",
			"ec",
			"-pkeyopt",
			"ec_paramgen_curve:P-256",
			"-nodes",
			"-days",
			"1",
			"-subj",
			"/CN=localhost",
			"-addext",
			"subjectAltName=DNS:localhost",
			"-keyout",
			key,
			"-out",
			cert,
		],
		{ stdio: "ignore" },
	);
	tlsApp = new HttpTransport(daemon.service, {
		identity: new StaticIdentity(LOGIN, "localhost"),
		owner: LOGIN,
		hosts: ["127.0.0.1"],
		port: tlsPort,
		tls: { cert, key },
		publicName: "localhost",
		testing: {
			loopbackTls: true,
			http1: process.env.PULSAR_REAL_TLS_H1 === "1",
			extraHosts: (process.env.PULSAR_REAL_TLS_HOSTS ?? "")
				.split(",")
				.filter(Boolean),
		},
	});
	await tlsApp.listen();
}
console.log(
	`real daemon: app http://127.0.0.1:${PORT}/ control :${PORT + 1}${tlsPort ? ` tls https://localhost:${tlsPort}/` : ""}`,
);

const stop = async () => {
	control.close();
	for (const c of [fixer, reviewer, ...others]) c.client.close();
	asker?.close();
	await tlsApp?.close();
	await daemon.stop();
	rmSync(root, { recursive: true, force: true });
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
