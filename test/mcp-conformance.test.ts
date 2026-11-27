/**
 * MCP protocol conformance of `pulsar mcp`.
 *
 * 1. Differential: a scripted JSON-RPC session (every method, every tool with
 *    good and bad arguments, batches, junk lines, out-of-order requests,
 *    cancellation, large lines, server notifications) is compared with what
 *    the SDK-based server (pulsar before ddfb7b4..) answered, recorded in
 *    test/fixtures/mcp-baseline.json. Re-record from an old build with
 *
 *      PULSAR_MCP_BASELINE=/path/to/old/dist PULSAR_MCP_RECORD=1 \
 *        bun test test/mcp-conformance.test.ts
 *
 *    Deliberate differences are listed in INTENDED with the reason.
 * 2. The real SDK client: connect, negotiate, list and call every tool,
 *    instructions, ping, cancellation, `_meta` (progress token, OpenCode
 *    session), stdin EOF.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Daemon } from "../src/daemon.ts";
import { agentClient, registration, startDaemon } from "./helpers.ts";
import { runtimeBinary } from "./mem-harness.ts";

/** The real node (a version-manager shim needs the real HOME, which servers here don't get). */
const NODE = runtimeBinary("node");

setDefaultTimeout(120_000);

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-baseline.json");
const BASELINE = process.env.PULSAR_MCP_BASELINE;
const RECORD = process.env.PULSAR_MCP_RECORD === "1" && !!BASELINE;
const CLI = BASELINE
	? join(BASELINE, "cli.js")
	: join(import.meta.dir, "..", "src", "cli.ts");

let daemon: Daemon;
let home: string;
let cleanup: () => void;
let work: string;

beforeAll(async () => {
	({ daemon, home, cleanup } = await startDaemon());
	work = join(home, "work");
	mkdirSync(work, { recursive: true });
});

afterAll(async () => {
	await daemon.stop();
	cleanup();
});

function serverEnv(harness: string, session: string) {
	return {
		...(process.env as Record<string, string>),
		// A private HOME: the server must not read a real session's records
		// (it may run under a real Claude Code, which it finds as its parent).
		HOME: home,
		CLAUDE_CONFIG_DIR: join(home, ".claude"),
		PULSAR_HOME: home,
		PULSAR_HARNESS: harness,
		PULSAR_SESSION_ID: session,
		PULSAR_NO_SCAN: "1",
	};
}

type Msg = Record<string, unknown> & { id?: unknown; method?: string };

/** The server over raw stdio: every message it writes, in order. */
class Raw {
	readonly child: ChildProcess;
	readonly seen: Msg[] = [];
	private buf = "";
	constructor(harness = "copilot", session = "conf") {
		this.child = spawn(NODE, [CLI, "mcp"], {
			cwd: work,
			env: serverEnv(harness, session),
			stdio: ["pipe", "pipe", "ignore"],
		});
		this.child.stdin?.on("error", () => {});
		this.child.stdout?.setEncoding("utf8");
		this.child.stdout?.on("data", (c: string) => {
			this.buf += c;
			let nl = this.buf.indexOf("\n");
			while (nl !== -1) {
				const line = this.buf.slice(0, nl);
				this.buf = this.buf.slice(nl + 1);
				if (line.trim()) this.seen.push(JSON.parse(line) as Msg);
				nl = this.buf.indexOf("\n");
			}
		});
	}
	write(line: string) {
		this.child.stdin?.write(`${line}\n`);
	}
	/** Waits for responses to `ids` (or `ms` when none are expected). */
	async waitFor(ids: unknown[], ms = 1500): Promise<void> {
		const end = Date.now() + (ids.length ? 30_000 : ms);
		while (Date.now() < end) {
			if (ids.length && ids.every((id) => this.seen.some((m) => m.id === id)))
				return;
			await Bun.sleep(20);
		}
	}
	close() {
		this.child.kill();
	}
}

const req = (id: unknown, method: string, params?: unknown) =>
	JSON.stringify({
		jsonrpc: "2.0",
		id,
		method,
		...(params === undefined ? {} : { params }),
	});
const note = (method: string, params?: unknown) =>
	JSON.stringify({
		jsonrpc: "2.0",
		method,
		...(params === undefined ? {} : { params }),
	});
const call = (id: unknown, name: string, args?: unknown, extra = {}) =>
	req(id, "tools/call", {
		name,
		...(args === undefined ? {} : { arguments: args }),
		...extra,
	});

/** One step: lines to send, ids whose responses to record, how long to wait otherwise. */
interface Step {
	name: string;
	lines: string[];
	expect: unknown[];
	/** Records nothing but which ids answered, in arrival order. */
	orderOnly?: boolean;
	ms?: number;
}

let nextId = 1;
const s = (
	name: string,
	build: (id: number) => string,
	opts: Partial<Step> = {},
): Step => {
	const id = nextId++;
	return { name, lines: [build(id)], expect: [id], ...opts };
};

const BAD_ARGS: Array<[string, unknown]> = [
	["list_agents", { selector: 1 }],
	["list_agents", { include_gone: "yes" }],
	["who", {}],
	["who", { question: "" }],
	["who", { question: 5 }],
	["send", {}],
	["send", { to: "a" }],
	["send", { to: "", body: "b" }],
	["send", { to: "a", body: "b", priority: "high" }],
	["send", { to: "a", body: "b", expect_reply: 1 }],
	["reply", { message_id: "", body: "x" }],
	["reply", { message_id: "m", body: "x", priority: 3 }],
	["inbox", { limit: 0 }],
	["inbox", { limit: 101 }],
	["inbox", { limit: 2.5 }],
	["inbox", { limit: "3" }],
	["inbox", { mark_read: "no" }],
	["ask", { to: "a", body: "b", timeout_seconds: 4 }],
	["ask", { to: "a", body: "b", timeout_seconds: 100000 }],
	["ask", { to: "a", body: "b", timeout_seconds: 7.5 }],
	["wait", { for: 3 }],
	["wait", { timeout_seconds: 0 }],
	["wait", { timeout_seconds: 99999 }],
	["set_identity", { tags_add: "x" }],
	["set_identity", { tags_add: [1] }],
	["set_identity", { inbound: "maybe" }],
	["set_identity", { activity: null }],
	["history", { limit: 0 }],
	["history", { limit: 201 }],
	["history", { message_id: 7 }],
	["send", []],
	["send", "x"],
	["send", null],
	["send", undefined],
	["nope", {}],
];

function script(selfId: string): Step[] {
	nextId = 1;
	const init = (v: unknown) => (id: number) =>
		req(id, "initialize", {
			...(v === undefined ? {} : { protocolVersion: v }),
			capabilities: {},
			clientInfo: { name: "conformance", version: "0" },
		});
	return [
		...[
			"2025-11-25",
			"2025-06-18",
			"2025-03-26",
			"2024-11-05",
			"2024-10-07",
			"2099-01-01",
			"x",
		].map((v) => s(`initialize ${v}`, init(v))),
		{
			name: "initialized",
			lines: [note("notifications/initialized")],
			expect: [],
			ms: 300,
		},
		s("tools/list", (id) => req(id, "tools/list")),
		s("tools/list with cursor", (id) => req(id, "tools/list", { cursor: "x" })),
		s("resources/list", (id) => req(id, "resources/list")),
		s("resources/templates/list", (id) => req(id, "resources/templates/list")),
		s("resources/read inbox", (id) =>
			req(id, "resources/read", { uri: "pulsar://inbox" }),
		),
		s("resources/read unknown", (id) =>
			req(id, "resources/read", { uri: "pulsar://nope" }),
		),
		s("resources/subscribe", (id) =>
			req(id, "resources/subscribe", { uri: "pulsar://inbox" }),
		),
		s("resources/unsubscribe", (id) =>
			req(id, "resources/unsubscribe", { uri: "pulsar://inbox" }),
		),
		s("prompts/list", (id) => req(id, "prompts/list")),
		s("completion/complete", (id) =>
			req(id, "completion/complete", {
				ref: { type: "ref/resource", uri: "pulsar://inbox" },
				argument: { name: "a", value: "" },
			}),
		),
		s("ping", (id) => req(id, "ping", {})),
		s("ping without params", (id) => req(id, "ping")),
		s("unknown method", (id) => req(id, "foo/bar", {})),
		s("logging/setLevel debug", (id) =>
			req(id, "logging/setLevel", { level: "debug" }),
		),
		s("string id", () => req("abc", "ping"), { expect: ["abc"] }),
		// Good calls.
		s("whoami", (id) => call(id, "whoami", {})),
		s("whoami without arguments", (id) => call(id, "whoami")),
		s("whoami with extra arguments", (id) => call(id, "whoami", { zzz: 1 })),
		s("whoami with _meta", (id) =>
			call(id, "whoami", {}, { _meta: { progressToken: 7 } }),
		),
		s("list_agents", (id) => call(id, "list_agents", {})),
		s("list_agents selector", (id) =>
			call(id, "list_agents", { selector: "harness=pi" }),
		),
		s("who", (id) => call(id, "who", { question: "who is on work" })),
		s("send", (id) => call(id, "send", { to: selfId, body: "hello" })),
		s("send to nobody", (id) =>
			call(id, "send", { to: "nobody-here", body: "x" }),
		),
		s("reply unknown", (id) =>
			call(id, "reply", { message_id: "m_nope", body: "x" }),
		),
		s("inbox", (id) => call(id, "inbox", { limit: 5, mark_read: false })),
		s("history", (id) => call(id, "history", { query: "zzz-none" })),
		s("set_identity", (id) =>
			call(id, "set_identity", {
				activity: "testing",
				tags_add: ["role:test"],
			}),
		),
		s("wait", (id) => call(id, "wait", { timeout_seconds: 1 })),
		s("ask nobody", (id) =>
			call(id, "ask", { to: "nobody-here", body: "q", timeout_seconds: 5 }),
		),
		// Bad calls.
		...BAD_ARGS.map(([tool, args]) =>
			s(`bad ${tool} ${JSON.stringify(args) ?? "(no arguments)"}`, (id) =>
				call(id, tool, args),
			),
		),
		s("tools/call without name", (id) =>
			req(id, "tools/call", { arguments: {} }),
		),
		// Robustness.
		{
			name: "junk lines are ignored",
			lines: [
				"{not json",
				JSON.stringify([
					JSON.parse(req(9001, "ping")),
					JSON.parse(req(9002, "ping")),
				]),
				JSON.stringify({ id: 9003, method: "ping" }),
				JSON.stringify({ jsonrpc: "2.0", id: 9004, result: {} }),
				JSON.stringify({ jsonrpc: "2.0", id: null, method: "ping" }),
				note("notifications/whatever", {}),
			],
			expect: [],
			ms: 1500,
		},
		{
			name: "out of order",
			lines: [call(9100, "wait", { timeout_seconds: 2 }), req(9101, "ping")],
			expect: [9100, 9101],
			orderOnly: true,
		},
		{
			name: "cancelled requests get no response",
			lines: [
				call(9200, "wait", { timeout_seconds: 2 }),
				note("notifications/cancelled", { requestId: 9200, reason: "test" }),
				note("notifications/cancelled", { requestId: 424242 }),
			],
			expect: [],
			ms: 4000,
		},
		s("large request (1 MB)", (id) =>
			call(id, "send", { to: selfId, body: "y".repeat(1024 * 1024) }),
		),
		{
			name: "line over 10 MB",
			lines: [call(9300, "whoami", { pad: "z".repeat(11 * 1024 * 1024) })],
			expect: [],
			ms: 3000,
		},
		s("ping after the long line", (id) => req(id, "ping")),
	];
}

/** Strips what differs from run to run: paths, machine, ids, times. */
function normalize(v: unknown, selfId: string): unknown {
	const text = JSON.stringify(v)
		.replaceAll(home, "<home>")
		.replaceAll(selfId, "<self>")
		.replace(/machine:[^,"\\]+/g, "machine:<m>")
		// "(<id>) studio/work [idle]": the machine before the project.
		.replace(/\) [a-z0-9][a-z0-9._-]*\/(?=\S+ \[)/g, ") <m>/")
		.replace(/\bm_[A-Za-z0-9_-]+/g, "<msg>")
		.replace(/\b\d+(\.\d+)?\s?(ms|s|m|h|d)\b/g, "<t>");
	return JSON.parse(text);
}

async function runScript(): Promise<Record<string, unknown>> {
	const raw = new Raw("copilot", "conf");
	const { client: peer } = await agentClient(
		registration({ sessionId: "conf-peer", cwd: work, project: "work" }),
	);
	const out: Record<string, unknown> = {};
	try {
		// The server registers itself at start; learn its id first.
		raw.write(
			req(0, "initialize", {
				protocolVersion: "2025-06-18",
				capabilities: {},
				clientInfo: { name: "c", version: "0" },
			}),
		);
		raw.write(call(-1, "whoami", {}));
		await raw.waitFor([-1]);
		const who = raw.seen.find((m) => m.id === -1) as {
			result: { content: { text: string }[] };
		};
		const selfId = /\(([^)]+)\)/.exec(who.result.content[0]!.text)![1]!;
		raw.seen.length = 0;
		const notifications = async () => {
			// Server notifications: an incoming message, then with logging at error.
			const from = raw.seen.length;
			await peer.call("send", { to: selfId, body: "incoming one" });
			await Bun.sleep(800);
			raw.write(req(9400, "logging/setLevel", { level: "error" }));
			await raw.waitFor([9400]);
			await peer.call("send", { to: selfId, body: "incoming two" });
			await Bun.sleep(800);
			raw.write(req(9401, "logging/setLevel", { level: "debug" }));
			await raw.waitFor([9401]);
			out.notifications = normalize(
				raw.seen.slice(from).filter((m) => m.id === undefined),
				selfId,
			);
		};
		for (const step of script(selfId)) {
			// Before the long line: the SDK server stopped reading after it.
			if (step.name === "line over 10 MB") await notifications();
			const from = raw.seen.length;
			for (const line of step.lines) raw.write(line);
			await raw.waitFor(step.expect, step.ms);
			const got = raw.seen.slice(from).filter((m) => m.id !== undefined);
			out[step.name] = step.orderOnly
				? got.map((m) => m.id)
				: normalize(got, selfId);
		}
	} finally {
		peer.close();
		raw.close();
	}
	return out;
}

/**
 * Where the new server deliberately answers differently, and why. Each
 * entry rewrites the recorded baseline step.
 */
type Recorded = Array<Record<string, unknown>>;
const INTENDED: Record<string, (old: Recorded, got: Recorded) => Recorded> = {
	// The SDK server advertised `resources.subscribe` but had no handler.
	"resources/subscribe": (old) =>
		old.map((m) => ({ jsonrpc: "2.0", id: m.id, result: {} })),
	"resources/unsubscribe": (old) =>
		old.map((m) => ({ jsonrpc: "2.0", id: m.id, result: {} })),
	// The SDK transport stopped reading stdin after a line over its 10 MB
	// buffer (a deaf server); the line is now dropped and serving goes on.
	"ping after the long line": (old, got) =>
		old.length === 0 && got.length === 1 && got[0]?.result ? got : old,
	// Durable delivery (docs/delivery.md) added the ack, done and nack tools
	// and one instructions line.
	...Object.fromEntries(
		[
			"2025-11-25",
			"2025-06-18",
			"2025-03-26",
			"2024-11-05",
			"2024-10-07",
			"2099-01-01",
			"x",
		].map((v) => [`initialize ${v}`, withNewInstructions]),
	),
	// The tools were consolidated to six (list_agents, send, respond, wait,
	// inbox, set_identity); the 1.x names stay callable but are not listed.
	"tools/list": withToolSet,
	"tools/list with cursor": withToolSet,
	// set_identity returns the whole identity (what whoami printed).
	set_identity: (old, got) => {
		const t = (
			got[0] as { result?: { content?: { text: string }[] } } | undefined
		)?.result?.content?.[0]?.text;
		return t?.startsWith("You are ") && t.includes("activity: testing")
			? got
			: old;
	},
};

const LISTED = [
	"list_agents",
	"send",
	"respond",
	"inbox",
	"wait",
	"set_identity",
];
/** Tools whose definition did not change: they must match the recording. */
const UNCHANGED = new Set(["wait"]);

type Result = { result?: Record<string, unknown> };

/** The recorded answers with the new instructions text. */
function withNewInstructions(old: Recorded, got: Recorded): Recorded {
	const text = (got[0] as Result | undefined)?.result?.instructions;
	return old.map((m) => {
		const r = (m as Result).result;
		return r && "instructions" in r
			? { ...m, result: { ...r, instructions: text } }
			: m;
	});
}

/** The listed tools: exactly LISTED, with unchanged ones as recorded. */
function withToolSet(old: Recorded, got: Recorded): Recorded {
	const listed = ((got[0] as Result | undefined)?.result?.tools ??
		[]) as Array<{ name: string }>;
	if (listed.map((t) => t.name).join() !== LISTED.join()) return old;
	return old.map((m) => {
		const r = (m as Result).result;
		const tools = r?.tools as Array<{ name: string }> | undefined;
		if (!r || !tools) return m;
		const recorded = new Map(tools.map((t) => [t.name, t]));
		const merged = listed.map((t) =>
			UNCHANGED.has(t.name) ? (recorded.get(t.name) ?? t) : t,
		);
		return { ...m, result: { ...r, tools: merged } };
	});
}

describe("differential: same answers as the SDK server", () => {
	test(
		RECORD ? "records the baseline" : "matches the recorded baseline",
		async () => {
			const got = await runScript();
			if (RECORD) {
				writeFileSync(FIXTURE, `${JSON.stringify(got, null, "\t")}\n`);
				return;
			}
			const want = JSON.parse(readFileSync(FIXTURE, "utf8")) as Record<
				string,
				unknown
			>;
			for (const [k, fix] of Object.entries(INTENDED))
				want[k] = fix(want[k] as Recorded, got[k] as Recorded);
			// Key order inside messages is not part of the protocol.
			const sorted = (x: unknown): unknown =>
				Array.isArray(x)
					? x.map(sorted)
					: x && typeof x === "object"
						? Object.fromEntries(
								Object.keys(x)
									.sort()
									.map((k) => [k, sorted((x as Record<string, unknown>)[k])]),
							)
						: x;
			expect(Object.keys(got).sort()).toEqual(Object.keys(want).sort());
			for (const key of Object.keys(want))
				expect({ step: key, got: sorted(got[key]) }).toEqual({
					step: key,
					got: sorted(want[key]),
				});
		},
	);
});

describe.skipIf(RECORD)("the SDK client", () => {
	async function client(harness = "copilot", session = "sdk") {
		const transport = new StdioClientTransport({
			command: NODE,
			args: [CLI, "mcp"],
			cwd: work,
			env: serverEnv(harness, session),
			stderr: "ignore",
		});
		const c = new Client({ name: "conformance", version: "0" });
		await c.connect(transport);
		return { c, transport };
	}

	test("connects, negotiates, lists and calls every tool", async () => {
		const { c } = await client();
		try {
			expect(c.getServerVersion()?.name).toBe("pulsar");
			expect(c.getInstructions()).toContain("Pulsar connects you");
			expect(c.getServerCapabilities()).toEqual({
				resources: { subscribe: true, listChanged: true },
				logging: {},
				tools: { listChanged: true },
			});
			await c.ping();
			const tools = (await c.listTools()).tools;
			expect(tools.map((t) => t.name).sort()).toEqual(
				[
					"inbox",
					"list_agents",
					"respond",
					"send",
					"set_identity",
					"wait",
				].sort(),
			);
			const args: Record<string, Record<string, unknown>> = {
				inbox: {},
				list_agents: {},
				respond: { message_id: "m_x", state: "working" },
				send: { to: "nobody-here", body: "x" },
				set_identity: { activity: "sdk" },
				wait: { timeout_seconds: 1 },
			};
			for (const t of tools) {
				const r = (await c.callTool({
					name: t.name,
					arguments: args[t.name],
				})) as {
					content: { type: string; text: string }[];
				};
				expect(r.content[0]?.type).toBe("text");
				expect(r.content[0]?.text.length).toBeGreaterThan(0);
			}
			const bad = (await c.callTool({
				name: "inbox",
				arguments: { limit: 0 },
			})) as {
				isError?: boolean;
				content: { text: string }[];
			};
			expect(bad.isError).toBe(true);
			expect(bad.content[0]?.text).toContain("Input validation error");
			await expect(
				c.request({ method: "prompts/list" } as never, {} as never),
			).rejects.toThrow(/Method not found/);
			const read = await c.readResource({ uri: "pulsar://inbox" });
			expect(read.contents[0]?.uri).toBe("pulsar://inbox");
		} finally {
			await c.close();
		}
	});

	test("cancellation and progress tokens", async () => {
		const { c } = await client("copilot", "sdk-cancel");
		try {
			const ac = new AbortController();
			const pending = c.callTool(
				{ name: "wait", arguments: { timeout_seconds: 3 } },
				undefined,
				{ signal: ac.signal },
			);
			setTimeout(() => ac.abort("stop"), 200);
			await expect(pending).rejects.toThrow();
			// Still serving, and a progress token in _meta is accepted.
			const r = (await c.callTool(
				{ name: "whoami", arguments: {} },
				undefined,
				{
					onprogress: () => {},
				},
			)) as { content: { text: string }[] };
			expect(r.content[0]?.text).toContain("You are");
		} finally {
			await c.close();
		}
	});

	test("OpenCode names the session in _meta", async () => {
		const { c } = await client("opencode", "");
		try {
			const r = (await c.callTool({
				name: "whoami",
				arguments: {},
				_meta: { "ai.opencode/sessionID": "ses_conformance" },
			})) as { content: { text: string }[] };
			expect(r.content[0]?.text).toContain("opencode:ses_conformance");
		} finally {
			await c.close();
		}
	});

	test("a length-prefixed client receives a parse error so it can retry with newline framing", async () => {
		const peer = new Raw();
		try {
			const body = req(1, "ping");
			peer.child.stdin?.write("Content-Len");
			peer.write(`gth: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
			await peer.waitFor([null]);
			expect(peer.seen).toEqual([
				{
					jsonrpc: "2.0",
					id: null,
					error: {
						code: -32700,
						message: "MCP stdio requires newline-delimited JSON.",
					},
				},
			]);
		} finally {
			peer.close();
		}
	});

	test("exits when stdin closes", async () => {
		const child = spawn(NODE, [CLI, "mcp"], {
			cwd: work,
			env: serverEnv("copilot", "eof"),
			stdio: ["pipe", "ignore", "ignore"],
		});
		await Bun.sleep(500);
		const t0 = Date.now();
		child.stdin?.end();
		const code = await new Promise((r) => child.once("exit", r));
		expect(code).toBe(0);
		expect(Date.now() - t0).toBeLessThan(5000);
	});
});
