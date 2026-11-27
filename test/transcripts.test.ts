import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
	truncateSync,
	utimesSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteTranscriptReader } from "../src/federation/transcripts.ts";
import { claudeTranscript } from "../src/harnesses/claude.ts";
import { codexMissRetry } from "../src/harnesses/codex.ts";
import { driverFor, extensionHostFor } from "../src/harnesses/index.ts";
import { ompActivity } from "../src/harnesses/omp-activity.ts";
import {
	hostSessionId,
	locatePiStyle,
	piSessionFile,
	sessionFolderNames,
} from "../src/harnesses/pi-sessions.ts";
import { isOmpHost } from "../src/harnesses/simple-ident.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { RpcError } from "../src/rpc.ts";
import {
	type Caller,
	type Principal,
	PulsarService,
} from "../src/service/index.ts";
import { driverMissing, subagentMissing } from "../src/service/transcripts.ts";
import { Store } from "../src/store.ts";
import {
	dedupe,
	type ResolvedTranscript,
	TranscriptTailer,
} from "../src/transcripts/tailer.ts";
import {
	newParseState,
	TOOL_OUTPUT_CAP,
	type TranscriptEvent,
	type TranscriptPage,
} from "../src/transcripts/types.ts";
import type { Agent } from "../src/types.ts";
import { registration, restoreEnv, until } from "./helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "transcripts");
const CLAUDE = join(FIXTURES, "claude", "session.jsonl");
const CODEX = join(
	FIXTURES,
	"codex",
	"rollout-2026-11-10T11-00-00-0000bbbb-1111-4222-8333-444455556666.jsonl",
);
const CODEX_FORK = join(FIXTURES, "codex", "fork.jsonl");
const PI = join(
	FIXTURES,
	"pi",
	"2026-11-10T12-00-00-000Z_0000dddd-1111-4222-8333-444455556666.jsonl",
);
const OMP = join(
	FIXTURES,
	"omp",
	"2026-11-10T13-00-00-000Z_0000eeee-1111-4222-8333-444455556666.jsonl",
);

function support(id: string) {
	const t = (driverFor(id) as HarnessDriver).transcript;
	if (!t) throw new Error(`${id} has no transcript support`);
	return t;
}

/** Parses a whole file from its start, as one chunk, deduped by id. */
function parseFile(harness: string, file: string, skipFirstLine = false) {
	let text = readFileSync(file, "utf8");
	if (skipFirstLine) text = text.slice(text.indexOf("\n") + 1);
	const state = newParseState({ atStart: true, cwd: "/work/demo" });
	return dedupe(support(harness).parse(text, state));
}

const byId = (events: TranscriptEvent[], id: string) =>
	events.find((e) => e.id === id);
const texts = (events: TranscriptEvent[]) => events.map((e) => e.text);

/** Every event id a line yields when parsed alone with fresh, mid-file state. */
function idsLineByLine(harness: string, file: string) {
	const ids = new Set<string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line) continue;
		const state = newParseState({ atStart: false, cwd: "/work/demo" });
		for (const e of support(harness).parse(line, state)) ids.add(e.id);
	}
	return ids;
}

describe("claude transcript", () => {
	const events = parseFile("claude", CLAUDE);

	test("user prompt, thinking and text, keyed by message id and block", () => {
		expect(events[0]).toMatchObject({
			id: "u-0001",
			role: "user",
			kind: "text",
			text: "Fix the token refresh race in src/auth/session.ts",
			ts: Date.parse("2026-11-10T10:00:01.000Z"),
		});
		expect(byId(events, "msg_demo_A#0")).toMatchObject({
			kind: "thinking",
			model: "claude-fable-5-2",
		});
	});

	test("a duplicate message.id line replaces the block in place", () => {
		const raw = support("claude").parse(
			readFileSync(CLAUDE, "utf8"),
			newParseState({ atStart: true }),
		);
		expect(raw.filter((e) => e.id === "msg_demo_A#1")).toHaveLength(2);
		const block = events.filter((e) => e.id === "msg_demo_A#1");
		expect(block).toHaveLength(1);
		expect(block[0]!.text).toBe(
			"I'll read the session module first, then fix the race.",
		);
		// It keeps its first position: before the Read call.
		expect(events.indexOf(block[0]!)).toBeLessThan(
			events.findIndex((e) => e.id === "msg_demo_A#2"),
		);
	});

	test("tool calls pair with results by tool_use_id, with one-line summaries", () => {
		expect(byId(events, "msg_demo_A#2")?.tool).toMatchObject({
			name: "Read",
			callId: "toolu_demo_01",
			summary: "Read src/auth/session.ts · 4 lines",
		});
		const readResult = byId(events, "u-0002#0");
		expect(readResult).toMatchObject({ role: "tool", kind: "tool_result" });
		expect(readResult?.tool).toMatchObject({
			name: "Read",
			callId: "toolu_demo_01",
		});
		expect(readResult?.text).toContain("export async function getToken()");
		expect(byId(events, "msg_demo_B#0")?.tool?.summary).toBe(
			"Edited src/auth/session.ts +3 −1",
		);
		expect(byId(events, "msg_demo_C#0")?.tool).toMatchObject({
			summary: "Ran `bun test auth` · exit 1",
			isError: true,
		});
		expect(byId(events, "u-0004#0")?.tool?.isError).toBe(true);
	});

	test("peer, task notification, sidechain and compaction", () => {
		expect(byId(events, "u-0007")).toMatchObject({
			role: "peer",
			kind: "peer",
			from: "codex-reviewer",
			text: "I'm touching session.ts too, hold refresh() for a minute.",
		});
		expect(byId(events, "u-0008")).toMatchObject({
			role: "system",
			kind: "system",
			text: 'Background command "bun run build" completed (exit code 0)',
		});
		expect(byId(events, "msg_demo_S#0")?.sidechain).toBe("a0demo0subagent");
		expect(byId(events, "msg_demo_D#0")?.sidechain).toBeUndefined();
		expect(byId(events, "sys-0001")).toMatchObject({
			kind: "system",
			text: "Conversation compacted",
		});
	});

	test("meta, companion and bookkeeping records are skipped", () => {
		const all = texts(events).join("\n");
		expect(all).not.toContain("Base directory for this skill");
		expect(all).not.toContain("(companion context)");
		expect(all).not.toContain("(request body)");
		expect(all).not.toContain("Fix token refresh race");
		expect(all).not.toContain("This session is being continued");
		expect(events.some((e) => e.id.startsWith("att-"))).toBe(false);
	});

	test("peer messages wrapped in text (sessions before origin), slash commands", () => {
		expect(byId(events, "u-0009")).toMatchObject({
			role: "peer",
			from: "docs-writer via pulsar",
			text: "README updated for the lock change.",
		});
		expect(byId(events, "u-0010")).toMatchObject({
			role: "user",
			text: "/model fable",
		});
	});

	test("every event exists when its line is parsed alone (history pages)", () => {
		const alone = idsLineByLine("claude", CLAUDE);
		for (const e of events) expect(alone.has(e.id)).toBe(true);
	});

	test("tool output over the cap is cut and marked truncated", () => {
		const call = JSON.stringify({
			type: "assistant",
			uuid: "a-big",
			apiBlockIndex: 0,
			timestamp: "2026-11-10T10:00:00.000Z",
			message: {
				id: "msg_big",
				content: [
					{
						type: "tool_use",
						id: "toolu_big",
						name: "Bash",
						input: { command: "cat big.log" },
					},
				],
			},
		});
		const result = JSON.stringify({
			type: "user",
			uuid: "u-big",
			timestamp: "2026-11-10T10:00:01.000Z",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_big",
						is_error: false,
						content: "x".repeat(10_000),
					},
				],
			},
		});
		const out = support("claude").parse(
			`${call}\n${result}\n`,
			newParseState(),
		);
		const res = out.find((e) => e.kind === "tool_result")!;
		expect(res.text).toHaveLength(TOOL_OUTPUT_CAP);
		expect(res.tool).toMatchObject({ truncated: true, name: "Bash" });
		expect(
			out.find((e) => e.id === "msg_big#0" && e.tool?.isError === false),
		).toBeDefined();
	});
});

describe("codex transcript", () => {
	const events = parseFile("codex", CODEX);

	test("skips developer messages and the AGENTS.md / environment injection", () => {
		const all = texts(events).join("\n");
		expect(all).not.toContain("You are Codex");
		expect(all).not.toContain("AGENTS.md");
		expect(all).not.toContain("environment_context");
		expect(events[0]).toMatchObject({
			id: "msg_user_1",
			role: "user",
			text: "Add retry to the fetch helper",
			ts: 1794308401100,
		});
	});

	test("the first user message is skipped only when parsing from the start", () => {
		const line = JSON.stringify({
			timestamp: "2026-11-10T11:00:00.000Z",
			type: "response_item",
			payload: {
				type: "message",
				id: "m1",
				role: "user",
				content: [{ type: "input_text", text: "a plain first prompt" }],
			},
		});
		const parse = support("codex").parse;
		expect(parse(line, newParseState({ atStart: true }))).toHaveLength(0);
		expect(parse(line, newParseState({ atStart: false }))).toHaveLength(1);
		// Only the first: a second user message from the start is kept.
		const state = newParseState({ atStart: true });
		parse(line, state);
		expect(parse(line.replace('"m1"', '"m2"'), state)).toHaveLength(1);
	});

	test("reasoning summaries become thinking; empty ones are hidden thinking", () => {
		expect(byId(events, "rs_1")).toMatchObject({
			kind: "thinking",
			text: "Looking for the fetch helper.",
			model: "gpt-5.5",
		});
		expect(byId(events, "rs_2")).toMatchObject({
			kind: "thinking",
			subtype: "hidden",
			text: "",
		});
	});

	test("function and custom tool calls pair with their outputs by call_id", () => {
		expect(byId(events, "fc_1")?.tool).toMatchObject({
			name: "exec_command",
			callId: "call_demo_1",
			input: { cmd: "rg -n fetchJson src" },
			summary: "Ran `rg -n fetchJson src` · exit 0",
			isError: false,
		});
		expect(byId(events, "fco_1")?.text).toContain(
			"src/net.ts:12:export function fetchJson",
		);
		expect(byId(events, "ctc_1")?.tool?.summary).toBe(
			"Edited src/net.ts +2 −1",
		);
		expect(byId(events, "ctco_1")?.tool).toMatchObject({
			name: "apply_patch",
			callId: "call_demo_2",
		});
		expect(byId(events, "fc_2")?.tool).toMatchObject({
			summary: "Ran `bun test net` · exit 1",
			isError: true,
		});
	});

	test("pulsar deliveries are peer messages", () => {
		expect(byId(events, "msg_user_2")).toMatchObject({
			role: "peer",
			kind: "peer",
			from: "claude@demo",
			text: "Please hold off on src/net.ts, I'm in it.",
		});
	});

	test("assistant messages carry the turn's model", () => {
		expect(events.at(-1)).toMatchObject({
			id: "msg_asst_1",
			role: "assistant",
			kind: "text",
			text: "Done: fetchJson now retries.",
			model: "gpt-5.5",
		});
	});

	test("forked rollouts keep each copied item's own create_time", () => {
		const fork = parseFile("codex", CODEX_FORK);
		expect(fork.map((e) => e.id)).toEqual([
			"msg_user_1",
			"msg_asst_1",
			"msg_user_9",
		]);
		expect(fork[0]!.ts).toBe(1794308401100);
		expect(fork[1]!.ts).toBe(1794308408000);
		expect(fork[2]!.ts).toBe(Date.parse("2026-11-12T09:00:05.000Z"));
	});

	test("every event exists when its line is parsed alone", () => {
		const alone = idsLineByLine("codex", CODEX);
		for (const e of events) expect(alone.has(e.id)).toBe(true);
	});
});

describe("pi and omp transcripts", () => {
	test("pi: messages, tool pairing, pulsar custom_message as peer", () => {
		const events = parsePiFile();
		expect(events.map((e) => [e.id, e.role, e.kind])).toEqual([
			["usr00001", "user", "text"],
			["ast00001#0", "assistant", "thinking"],
			["ast00001#1", "assistant", "tool_call"],
			["tr000001", "tool", "tool_result"],
			["cm000001", "peer", "peer"],
			["ast00002#0", "assistant", "text"],
		]);
		expect(byId(events, "ast00001#1")?.tool).toMatchObject({
			name: "bash",
			callId: "call_pi_1",
			summary: "Ran `ls` · exit 0",
		});
		expect(byId(events, "tr000001")?.text).toBe("README.md\nsrc");
		expect(byId(events, "cm000001")).toMatchObject({
			from: "claude@demo",
			text: "Are you done with src/auth yet?",
		});
		expect(byId(events, "ast00002#0")?.model).toBe("demo-model-1");
	});

	test("omp: the title line is never an event; edits summarize", () => {
		const events = parseFile("omp", OMP, true);
		expect(texts(events).join("\n")).not.toContain("Demo: serialize");
		expect(events.map((e) => e.id)).toEqual([
			"usr000e1",
			"ast000e1#0",
			"tr0000e1",
			"ast000e2#0",
		]);
		expect(byId(events, "ast000e1#0")?.tool?.summary).toBe(
			"Edited src/auth/session.ts +1 −1",
		);
	});

	function parsePiFile() {
		return parseFile("pi", PI);
	}
});

describe("locate", () => {
	let dir: string;
	const saved = {
		claude: process.env.CLAUDE_CONFIG_DIR,
		codex: process.env.CODEX_HOME,
	};
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-locate-"));
	});
	afterEach(() => {
		restoreEnv("CLAUDE_CONFIG_DIR", saved.claude);
		restoreEnv("CODEX_HOME", saved.codex);
		rmSync(dir, { recursive: true, force: true });
	});

	test("claude: projects/<cwd slug>/<session>.jsonl", async () => {
		process.env.CLAUDE_CONFIG_DIR = dir;
		const folder = join(dir, "projects", "-work-demo");
		mkdirSync(folder, { recursive: true });
		copyFileSync(CLAUDE, join(folder, "sess-1.jsonl"));
		const ref = { harness: "claude", sessionId: "sess-1", cwd: "/work/demo" };
		expect(await support("claude").locate(ref)).toEqual({
			kind: "file",
			path: join(folder, "sess-1.jsonl"),
		});
		expect(
			await support("claude").locate({ ...ref, sessionId: "nope" }),
		).toBeNull();
		expect(
			await support("claude").locate({ ...ref, sessionId: null }),
		).toBeNull();
	});

	test("codex: the thread's rollout under sessions/YYYY/MM/DD", async () => {
		process.env.CODEX_HOME = dir;
		const day = join(dir, "sessions", "2026", "11", "10");
		mkdirSync(day, { recursive: true });
		const name =
			"rollout-2026-11-10T11-00-00-0000bbbb-1111-4222-8333-444455556666.jsonl";
		copyFileSync(CODEX, join(day, name));
		expect(
			await support("codex").locate({
				harness: "codex",
				sessionId: "0000bbbb-1111-4222-8333-444455556666",
				cwd: "/work/demo",
			}),
		).toEqual({ kind: "file", path: join(day, name) });
	});

	test("pi/omp: the session's file in the folder, else the newest", async () => {
		const folder = join(dir, ".omp", "agent", "sessions", "--work-demo--");
		mkdirSync(folder, { recursive: true });
		writeFileSync(join(folder, "2026-11-10T13-00-00-000Z_aaa.jsonl"), "");
		writeFileSync(join(folder, "2026-11-10T14-00-00-000Z_bbb.jsonl"), "");
		expect(await piSessionFile(".omp", "/work/demo", "aaa", dir)).toBe(
			join(folder, "2026-11-10T13-00-00-000Z_aaa.jsonl"),
		);
		expect(await piSessionFile(".omp", "/work/demo", null, dir)).toMatch(
			/_(aaa|bbb)\.jsonl$/,
		);
		expect(await piSessionFile(".omp", "/elsewhere", null, dir)).toBeNull();
	});

	test("claude: a session whose agent moved folders is found by id", async () => {
		process.env.CLAUDE_CONFIG_DIR = dir;
		// Claude Code names the folder for where the session started; the
		// agent later said it works in a worktree (set_identity cwd).
		const started = join(dir, "projects", "-work-demo");
		mkdirSync(started, { recursive: true });
		copyFileSync(CLAUDE, join(started, "sess-moved.jsonl"));
		expect(
			await support("claude").locate({
				harness: "claude",
				sessionId: "sess-moved",
				cwd: "/work/demo/.claude/worktrees/feature",
			}),
		).toEqual({ kind: "file", path: join(started, "sess-moved.jsonl") });
	});

	test("claude: a file written after the first miss is found at once", async () => {
		process.env.CLAUDE_CONFIG_DIR = dir;
		const folder = join(dir, "projects", "-work-late");
		mkdirSync(folder, { recursive: true });
		expect(await claudeTranscript("/work/late", "sess-late")).toBeNull();
		copyFileSync(CLAUDE, join(folder, "sess-late.jsonl"));
		// Its own folder is checked every time (no miss window there).
		expect(await claudeTranscript("/work/late", "sess-late")).toBe(
			join(folder, "sess-late.jsonl"),
		);
	});

	test("codex: a rollout written after a miss is found within the retry window", async () => {
		process.env.CODEX_HOME = dir;
		const saved = codexMissRetry.ms;
		codexMissRetry.ms = 50;
		try {
			const day = join(dir, "sessions", "2026", "11", "22");
			mkdirSync(day, { recursive: true });
			const ref = {
				harness: "codex",
				sessionId: "0000cccc-1111-4222-8333-444455556666",
				cwd: "/work/demo",
			};
			expect(await support("codex").locate(ref)).toBeNull();
			const name = `rollout-2026-11-22T01-00-00-${ref.sessionId}.jsonl`;
			copyFileSync(CODEX, join(day, name));
			// Inside the window: the miss stands (no walk on every tick).
			expect(await support("codex").locate(ref)).toBeNull();
			await Bun.sleep(60);
			expect(await support("codex").locate(ref)).toEqual({
				kind: "file",
				path: join(day, name),
			});
		} finally {
			codexMissRetry.ms = saved;
		}
	});

	test("pi/omp: the host session id picks its file, not the newest", async () => {
		const folder = join(dir, ".omp", "agent", "sessions", "-tmp");
		mkdirSync(folder, { recursive: true });
		const mine = join(folder, "2026-11-20T04-03-57-433Z_01a1f720.jsonl");
		const newer = join(folder, "2026-11-22T07-43-06-660Z_01a20235.jsonl");
		writeFileSync(mine, "");
		writeFileSync(newer, "");
		// Two omp sessions in one folder, registered by pid: each one's
		// extension reports its own session as resumeKey.
		const agent = {
			harness: "omp",
			sessionId: null,
			cwd: join(dir, "tmp"),
			meta: { resumeKey: "omp:01a1f720" },
		};
		expect(hostSessionId(agent)).toBe("01a1f720");
		expect(await locatePiStyle("omp", agent, dir)).toEqual({
			kind: "file",
			path: mine,
			headerLine: true,
		});
		// A new session (/new, resume, fork) moves the key, and the file.
		expect(
			await locatePiStyle(
				"omp",
				{ ...agent, meta: { resumeKey: "omp:01a20235" } },
				dir,
			),
		).toEqual({ kind: "file", path: newer, headerLine: true });
	});

	test("omp activity appears in app rows for the exact session without transcript details", async () => {
		const savedHome = process.env.HOME;
		process.env.HOME = dir;
		const store = new Store(":memory:");
		const service = new PulsarService({ store, scan: false, machine: "local" });
		try {
			const cwd = join(dir, "tmp");
			const folder = join(dir, ".omp", "agent", "sessions", "-tmp");
			mkdirSync(folder, { recursive: true });
			const file = join(folder, "1_ours.jsonl");
			const line = (message: unknown) =>
				`${JSON.stringify({ type: "message", message })}\n`;
			writeFileSync(
				file,
				line({
					role: "assistant",
					content: [
						{
							type: "toolCall",
							name: "bash",
							arguments: { command: "private command" },
						},
					],
				}),
			);
			writeFileSync(
				join(folder, "2_other.jsonl"),
				line({ role: "user", content: "private prompt" }),
			);
			const register = (sessionId: string) =>
				service.registry.upsert({
					...registration({ harness: "omp", sessionId, cwd, branch: null }),
					meta: {},
					registered: true,
				});
			let own = register("ours");
			const missing = register("missing");
			const row = (id: string) => service.app.agent({ kind: "terminal" }, id);
			await service.registry.refreshActivity();
			expect((await row(own.id)).activity).toBe("Requested a command");
			expect((await row(missing.id)).activity).toBeNull();
			own = register("ours");
			expect((await row(own.id)).activity).toBe("Requested a command");
			appendFileSync(
				file,
				line({
					role: "toolResult",
					toolName: "bash",
					content: "private output",
				}),
			);
			await service.registry.refreshActivity();
			expect((await row(own.id)).activity).toBe("Ran a command");
			service.registry.setIdentity(own, { activity: "Reviewing the plan" });
			await service.registry.refreshActivity();
			expect((await row(own.id)).activity).toBe("Reviewing the plan");
		} finally {
			service.stop();
			store.close();
			restoreEnv("HOME", savedHome);
		}
	});

	test("omp backs off missing session activity and retries on time or identity change", async () => {
		const savedHome = process.env.HOME;
		process.env.HOME = dir;
		try {
			const folder = join(
				dir,
				".omp",
				"agent",
				"sessions",
				"another-workspace",
			);
			mkdirSync(folder, { recursive: true });
			const agent = { harness: "omp", sessionId: "first", cwd: null };
			const prompt = `${JSON.stringify({ type: "message", message: { role: "user" } })}\n`;
			expect(await ompActivity(agent, 1_000)).toBeNull();
			writeFileSync(join(folder, "1_first.jsonl"), prompt);
			const open = async () => [join(folder, "1_first.jsonl")];
			expect(
				await locatePiStyle(
					"omp",
					{ ...agent, sessionId: "different", pid: 101 },
					dir,
					open,
					true,
				),
			).toBeNull();
			expect(
				await locatePiStyle(
					"omp",
					{ ...agent, sessionId: null, pid: 101 },
					dir,
					open,
					true,
				),
			).toMatchObject({
				kind: "file",
				path: join(folder, "1_first.jsonl"),
			});
			expect(await ompActivity(agent, 16_000)).toBeNull();
			expect(await ompActivity(agent, 61_000)).toBe("Received a prompt");
			agent.sessionId = "missing";
			expect(await ompActivity(agent, 62_000)).toBeNull();
			agent.sessionId = "first";
			expect(await ompActivity(agent, 62_001)).toBe("Received a prompt");
		} finally {
			restoreEnv("HOME", savedHome);
		}
	});

	test("pi-style readers prefer the live PID's primary file over an old resume key", async () => {
		const primary = join(dir, ".omp", "agent", "sessions", "-workspace");
		const nested = join(primary, "subagents");
		mkdirSync(nested, { recursive: true });
		const current = join(primary, "2_current.jsonl");
		const old = join(primary, "1_old.jsonl");
		const child = join(nested, "3_child.jsonl");
		for (const path of [current, old, child]) writeFileSync(path, "");
		const agent = {
			harness: "omp",
			sessionId: null,
			pid: 102,
			cwd: null,
			meta: { resumeKey: "omp:old" },
		};
		const held = async () => [current, current, child];
		expect(await locatePiStyle("omp", agent, dir, held)).toMatchObject({
			kind: "file",
			path: current,
		});
		expect(await locatePiStyle("omp", agent, dir, held, true)).toMatchObject({
			kind: "file",
			path: current,
		});
		expect(
			await locatePiStyle(
				"omp",
				{ ...agent, sessionId: "old" },
				dir,
				held,
				true,
			),
		).toMatchObject({ kind: "file", path: old });
		const ambiguous = async () => [current, old];
		expect(
			await locatePiStyle("omp", agent, dir, ambiguous, true),
		).toMatchObject({ kind: "file", path: old });
		expect(
			await locatePiStyle("omp", { ...agent, meta: {} }, dir, ambiguous, true),
		).toBeNull();
		expect(
			await locatePiStyle("omp", agent, dir, async () => [], true),
		).toMatchObject({ kind: "file", path: old });
		const noEvidence = { ...agent, cwd: join(dir, "workspace"), meta: {} };
		expect(
			await locatePiStyle("omp", noEvidence, dir, async () => []),
		).toMatchObject({ kind: "file", guess: true });
		expect(
			await locatePiStyle("omp", noEvidence, dir, async () => [], true),
		).toBeNull();
	});

	test("pi/omp: an omp session an older extension registered as pi", async () => {
		// omp as one Bun binary looked like pi to the extension: the agent is
		// `pi`, its session lives in ~/.omp (title line and all).
		const folder = join(dir, ".omp", "agent", "sessions", "-tmp");
		mkdirSync(folder, { recursive: true });
		const file = join(folder, "2026-11-20T04-03-57-433Z_01a1f720.jsonl");
		writeFileSync(file, "");
		const agent = {
			harness: "pi",
			sessionId: null,
			cwd: join(dir, "tmp"),
			meta: { resumeKey: "pi:01a1f720" },
		};
		expect(await locatePiStyle("pi", agent, dir)).toEqual({
			kind: "file",
			path: file,
			headerLine: true,
		});
		// No session id and nothing in ~/.pi: not found (never another's file).
		expect(await locatePiStyle("pi", { ...agent, meta: {} }, dir)).toBeNull();
	});

	test("pi/omp: a session in another folder than the agent's cwd, by id", async () => {
		const folder = join(dir, ".pi", "agent", "sessions", "--work-demo--");
		mkdirSync(folder, { recursive: true });
		const file = join(folder, "2026-11-10T13-00-00-000Z_ccc.jsonl");
		writeFileSync(file, "");
		expect(
			await locatePiStyle(
				"pi",
				{ harness: "pi", sessionId: "ccc", cwd: "/work/demo/sub" },
				dir,
			),
		).toEqual({ kind: "file", path: file });
	});

	test("pi/omp folder names, as the real folders are named", () => {
		const home = "/Users/me";
		// omp: home-relative (`-tmp`, `-Projects-pg_accel`); pi: the full path.
		expect(sessionFolderNames("/Users/me/tmp", home)).toEqual([
			"--Users-me-tmp--",
			"-tmp",
		]);
		expect(sessionFolderNames("/Users/me/Projects/pg_accel", home)).toEqual([
			"--Users-me-Projects-pg_accel--",
			"-Projects-pg_accel",
		]);
		expect(sessionFolderNames(home, home)).toEqual(["--Users-me--", "-"]);
		// Outside the home folder both use the full path.
		expect(sessionFolderNames("/Volumes/Silo/security-research", home)).toEqual(
			["--Volumes-Silo-security-research--"],
		);
		// A dot is tried kept and as `-`.
		expect(sessionFolderNames("/Users/me/Projects/a.io", home)).toEqual([
			"--Users-me-Projects-a.io--",
			"--Users-me-Projects-a-io--",
			"-Projects-a.io",
			"-Projects-a-io",
		]);
	});

	test("pi/omp: no session id: the file the process has open, not the newest", async () => {
		// Two omp sessions in ~/tmp, registered as pi by an older extension
		// (no resumeKey): lsof names the one this pid writes.
		const folder = join(dir, ".omp", "agent", "sessions", "-tmp");
		mkdirSync(join(folder, "2026-11-20T04-03-57-433Z_01a1f720"), {
			recursive: true,
		});
		const mine = join(folder, "2026-11-20T04-03-57-433Z_01a1f720.jsonl");
		const newer = join(folder, "2026-11-22T07-43-06-660Z_01a20235.jsonl");
		const sub = join(
			folder,
			"2026-11-20T04-03-57-433Z_01a1f720",
			"0-Task.jsonl",
		);
		writeFileSync(mine, "");
		writeFileSync(sub, "");
		writeFileSync(newer, "");
		utimesSync(mine, 1000, 1000);
		utimesSync(newer, 2000, 2000);
		const agent = {
			harness: "pi",
			sessionId: null,
			cwd: join(dir, "tmp"),
			pid: 84724,
		};
		const asked: number[] = [];
		const openFiles = async (pid: number) => {
			asked.push(pid);
			return [sub, mine, "/usr/lib/dyld", join(dir, "notes.jsonl")];
		};
		expect(await locatePiStyle("pi", agent, dir, openFiles)).toEqual({
			kind: "file",
			path: mine,
			headerLine: true,
		});
		expect(asked).toEqual([84724]);
		// lsof finds nothing (not running, or no file yet): the newest, a guess.
		expect(
			await locatePiStyle("omp", { ...agent, pid: 1 }, dir, async () => []),
		).toEqual({ kind: "file", path: newer, headerLine: true, guess: true });
	});

	test("omp marks its header line; OpenCode has no transcript in v1", () => {
		expect(driverFor("opencode")?.transcript).toBeUndefined();
		for (const id of ["claude", "codex", "pi", "omp"])
			expect(driverFor(id)?.transcript).toBeDefined();
	});
});

/** Collects live batches; `wait` resolves once `n` events have arrived. */
function collector() {
	const events: TranscriptEvent[] = [];
	return {
		events,
		fn: (batch: TranscriptEvent[]) => {
			events.push(...batch);
		},
		wait: (n: number) => until(() => events.length >= n, 2000),
	};
}

const line = (id: string, text: string) =>
	`${JSON.stringify({
		type: "message",
		id,
		timestamp: "2026-11-10T12:00:00.000Z",
		message: { role: "user", content: text },
	})}\n`;

describe("tailer", () => {
	let dir: string;
	let tailer: TranscriptTailer;
	const sources = new Map<string, ResolvedTranscript>();
	const fileSource = (path: string, harness = "pi", headerLine = false) =>
		({
			source: { kind: "file", path, ...(headerLine ? { headerLine } : {}) },
			parse: support(harness).parse,
			cwd: "/work/demo",
		}) satisfies ResolvedTranscript;

	function make(
		opts: Partial<ConstructorParameters<typeof TranscriptTailer>[0]> = {},
	) {
		tailer = new TranscriptTailer({
			resolve: (id) => sources.get(id) ?? null,
			pollMs: 20,
			...opts,
		});
		return tailer;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-tailer-"));
		sources.clear();
	});
	afterEach(() => {
		tailer?.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("the newest page of a small file is the whole transcript", async () => {
		const file = join(dir, "claude.jsonl");
		copyFileSync(CLAUDE, file);
		sources.set("c", fileSource(file, "claude"));
		const page = (await make().read("c"))!;
		expect(page.cursor).toBeNull();
		expect(page.events.map((e) => e.id)).toEqual(
			parseFile("claude", CLAUDE).map((e) => e.id),
		);
	});

	test("pages backwards with a cursor until the start", async () => {
		const file = join(dir, "claude.jsonl");
		copyFileSync(CLAUDE, file);
		sources.set("c", fileSource(file, "claude"));
		make({ pageBytes: 256, pageEvents: 3 });
		const pages: TranscriptPage[] = [];
		let cursor: string | null | undefined;
		do {
			const page: TranscriptPage = (await tailer.read("c", cursor))!;
			pages.push(page);
			cursor = page.cursor;
		} while (cursor && pages.length < 50);
		expect(pages.length).toBeGreaterThan(3);
		for (const p of pages) expect(p.events.length).toBeLessThanOrEqual(4);
		const joined = dedupe(pages.reverse().flatMap((p) => p.events));
		expect(joined.map((e) => e.id)).toEqual(
			parseFile("claude", CLAUDE).map((e) => e.id),
		);
	});

	test("a bad cursor is refused", async () => {
		const file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		sources.set("p", fileSource(file));
		make();
		await expect(tailer.read("p", "99999999")).rejects.toThrow(RangeError);
		await expect(tailer.read("p", "abc")).rejects.toThrow(RangeError);
	});

	test("a line longer than the page window is still read", async () => {
		const file = join(dir, "pi.jsonl");
		writeFileSync(
			file,
			line("a1", "first") + line("a2", "y".repeat(5000)) + line("a3", "last"),
		);
		sources.set("p", fileSource(file));
		const page = (await make({ pageBytes: 64, pageEvents: 2 }).read("p"))!;
		expect(page.events.map((e) => e.id)).toEqual(["a2", "a3"]);
		const earlier = (await tailer.read("p", page.cursor))!;
		expect(earlier.events.map((e) => e.id)).toEqual(["a1"]);
		expect(earlier.cursor).toBeNull();
	});

	test("a line longer than the largest window never stalls the cursor", async () => {
		const file = join(dir, "pi.jsonl");
		writeFileSync(
			file,
			line("b1", "first") +
				line("b2", "z".repeat(2000)) +
				line("b3", "w".repeat(2000)),
		);
		sources.set("p", fileSource(file));
		make({ pageBytes: 64, maxPageBytes: 128, pageEvents: 1 });
		const seen: string[] = [];
		let cursor: string | null | undefined;
		for (let i = 0; i < 5; i++) {
			const page: TranscriptPage = (await tailer.read("p", cursor))!;
			if (cursor) expect(Number(page.cursor ?? 0)).toBeLessThan(Number(cursor));
			seen.unshift(...page.events.map((e) => e.id));
			cursor = page.cursor;
			if (!cursor) break;
		}
		expect(seen).toEqual(["b1", "b2", "b3"]);
	});

	test("no transcript: read returns null", async () => {
		expect(await make().read("missing")).toBeNull();
	});

	test("live append: only complete lines are emitted", async () => {
		const file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		sources.set("p", fileSource(file));
		make();
		const c = collector();
		const off = tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		const next = line("live1", "hello");
		appendFileSync(file, next.slice(0, 20));
		await tailer.poke();
		await Bun.sleep(60);
		expect(c.events).toHaveLength(0);
		appendFileSync(file, next.slice(20) + line("live2", "again"));
		await c.wait(2);
		expect(c.events.map((e) => e.id)).toEqual(["live1", "live2"]);
		off();
	});

	test("results appended live find calls written before subscribing", async () => {
		const file = join(dir, "pi.jsonl");
		const lines = readFileSync(PI, "utf8").split("\n");
		// Everything up to and including the bash call; the result comes live.
		const cut = lines.findIndex((l) => l.includes('"tr000001"'));
		writeFileSync(file, `${lines.slice(0, cut).join("\n")}\n`);
		sources.set("p", fileSource(file));
		make();
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		appendFileSync(file, `${lines[cut]}\n`);
		await c.wait(2);
		expect(c.events[0]?.tool?.summary).toBe("Ran `ls` · exit 0");
		expect(c.events[1]?.tool?.name).toBe("bash");
	});

	test("a truncated file restarts from its first line after a gap", async () => {
		const file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		sources.set("p", fileSource(file));
		make();
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		truncateSync(file, 0);
		writeFileSync(file, line("n1", "new start"));
		await c.wait(2);
		expect(c.events[0]).toMatchObject({ kind: "system", text: "gap" });
		expect(c.events[1]?.id).toBe("n1");
	});

	test("one ref-counted watcher per agent, shared by subscribers", async () => {
		const file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		sources.set("p", fileSource(file));
		make();
		const a = collector();
		const b = collector();
		const offA = tailer.subscribe("p", a.fn);
		await tailer.ready("p");
		const offB = tailer.subscribe("p", b.fn);
		await tailer.ready("p");
		expect(tailer.watching).toBe(1);
		expect(tailer.subscribers("p")).toBe(2);
		appendFileSync(file, line("s1", "shared"));
		await a.wait(1);
		await b.wait(1);
		offA();
		offA();
		expect(tailer.watching).toBe(1);
		expect(tailer.subscribers("p")).toBe(1);
		offB();
		expect(tailer.watching).toBe(0);
	});

	test("a slow subscriber overflows into one gap marker, then catches up", async () => {
		const file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		sources.set("p", fileSource(file));
		make({ queueLimit: 3 });
		const batches: TranscriptEvent[][] = [];
		let release: () => void = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		tailer.subscribe("p", (batch) => {
			batches.push(batch);
			return batches.length === 1 ? held : undefined;
		});
		await tailer.ready("p");
		appendFileSync(file, line("q0", "first"));
		await until(() => batches.length === 1, 2000);
		let more = "";
		for (let i = 1; i <= 10; i++) more += line(`q${i}`, `n${i}`);
		appendFileSync(file, more);
		await tailer.poke();
		await Bun.sleep(60);
		expect(batches).toHaveLength(1);
		appendFileSync(file, line("q11", "after the gap"));
		await tailer.poke();
		release();
		await until(() => batches.flat().some((e) => e.id === "q11"), 2000);
		const after = batches.slice(1).flat();
		expect(after[0]).toMatchObject({ kind: "system", text: "gap" });
		expect(after[0]!.id).toMatch(/^gap:/);
		expect(after.map((e) => e.id)).not.toContain("q1");
	});

	test("omp: a rewritten title line is never read", async () => {
		const file = join(dir, "omp.jsonl");
		copyFileSync(OMP, file);
		sources.set("o", fileSource(file, "omp", true));
		make();
		const page = (await tailer.read("o"))!;
		expect(page.cursor).toBeNull();
		expect(page.events.map((e) => e.id)[0]).toBe("usr000e1");
		const c = collector();
		tailer.subscribe("o", c.fn);
		await tailer.ready("o");
		// Rewrite line 1 in place, same length, as a message-shaped record.
		const first = readFileSync(file, "utf8").split("\n")[0]!;
		const fake = JSON.stringify({
			type: "message",
			id: "title-x",
			message: { role: "user", content: "title" },
		});
		const padded =
			fake.slice(0, -1) +
			`,"p":"${" ".repeat(first.length - fake.length - 7)}"}`;
		expect(padded).toHaveLength(first.length);
		const fd = openSync(file, "r+");
		writeSync(fd, padded, 0, "utf8");
		closeSync(fd);
		appendFileSync(file, line("omp-live", "after"));
		await c.wait(1);
		await Bun.sleep(60);
		expect(c.events.map((e) => e.id)).toEqual(["omp-live"]);
		const again = (await tailer.read("o"))!;
		expect(again.events.map((e) => e.id)).not.toContain("title-x");
	});

	test("a transcript that appears after subscribing is read from its start", async () => {
		const file = join(dir, "later.jsonl");
		sources.set("p", fileSource(file));
		make();
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		await Bun.sleep(40);
		writeFileSync(file, line("l1", "one") + line("l2", "two"));
		await c.wait(2);
		expect(c.events.map((e) => e.id)).toEqual(["l1", "l2"]);
	});

	test("a session that moves to another file is followed after a gap", async () => {
		const first = join(dir, "first.jsonl");
		const second = join(dir, "second.jsonl");
		writeFileSync(first, line("a1", "one"));
		writeFileSync(second, line("b0", "history of the new session"));
		sources.set("p", fileSource(first));
		make({ resolveMs: 30 });
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		appendFileSync(first, line("a2", "two"));
		await c.wait(1);
		// The harness started another session (new, resume, fork).
		sources.set("p", fileSource(second));
		await until(() => c.events.some((e) => e.id.startsWith("gap:")), 2000);
		appendFileSync(first, line("a3", "old session, not followed"));
		appendFileSync(second, line("b1", "live in the new session"));
		await until(() => c.events.some((e) => e.id === "b1"), 2000);
		const ids = c.events.map((e) => (e.id.startsWith("gap:") ? "gap" : e.id));
		// Its history comes from the newest page (the gap says re-read it).
		expect(ids).toEqual(["a2", "gap", "b1"]);
		expect((await tailer.read("p"))!.events.map((e) => e.id)).toEqual([
			"b0",
			"b1",
		]);
	});

	test("a guessed file (no session id) never replaces the one followed", async () => {
		const mine = join(dir, "mine.jsonl");
		const other = join(dir, "other.jsonl");
		writeFileSync(mine, line("m1", "one"));
		writeFileSync(other, line("o1", "another session in the folder"));
		sources.set("p", fileSource(mine));
		make({ resolveMs: 20 });
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		// The other session wrote last: the folder's newest file is its.
		const guess = fileSource(other);
		sources.set("p", {
			...guess,
			source: { ...guess.source, guess: true },
		});
		await Bun.sleep(80);
		appendFileSync(mine, line("m2", "two"));
		await c.wait(1);
		expect(c.events.map((e) => e.id)).toEqual(["m2"]);
	});

	test("a lookup that misses keeps following the file", async () => {
		const file = join(dir, "kept.jsonl");
		writeFileSync(file, line("k1", "one"));
		sources.set("p", fileSource(file));
		make({ resolveMs: 20 });
		const c = collector();
		tailer.subscribe("p", c.fn);
		await tailer.ready("p");
		sources.delete("p");
		await Bun.sleep(80);
		appendFileSync(file, line("k2", "two"));
		await c.wait(1);
		expect(c.events.map((e) => e.id)).toEqual(["k2"]);
	});

	test("poll sources: pages pass through; live emits new and changed events", async () => {
		let current: TranscriptEvent[] = [
			{ id: "o1", ts: 1, role: "user", kind: "text", text: "hi" },
		];
		sources.set("oc", {
			source: {
				kind: "poll",
				intervalMs: 20,
				fetch: async (cursor) =>
					cursor
						? { events: [], cursor: null }
						: { events: current, cursor: "c1" },
			},
			parse: () => [],
		});
		make();
		expect((await tailer.read("oc"))?.cursor).toBe("c1");
		expect((await tailer.read("oc", "c1"))?.events).toEqual([]);
		const c = collector();
		tailer.subscribe("oc", c.fn);
		await tailer.ready("oc");
		await Bun.sleep(60);
		expect(c.events).toHaveLength(0);
		current = [
			{ id: "o1", ts: 1, role: "user", kind: "text", text: "hi" },
			{ id: "o2", ts: 2, role: "assistant", kind: "text", text: "partial" },
		];
		await c.wait(1);
		current = [
			current[0]!,
			{
				id: "o2",
				ts: 2,
				role: "assistant",
				kind: "text",
				text: "partial, done",
			},
		];
		await c.wait(2);
		expect(c.events.map((e) => [e.id, e.text])).toEqual([
			["o2", "partial"],
			["o2", "partial, done"],
		]);
	});
});

describe("service transcripts", () => {
	let dir: string;
	let service: PulsarService;
	let store: Store;
	let file: string;
	/** The resolver misses (a folder scan under load, a registry update with another cwd). */
	let miss = false;

	function fakeCaller(principal: Principal) {
		const controller = new AbortController();
		const events: Array<{ event: string; data: unknown }> = [];
		const caller: Caller = {
			principal,
			closed: controller.signal,
			emit: (event, data) => events.push({ event, data }),
		};
		return { caller, events, close: () => controller.abort() };
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-svc-transcripts-"));
		file = join(dir, "pi.jsonl");
		copyFileSync(PI, file);
		miss = false;
		store = new Store(":memory:");
		service = new PulsarService({
			store,
			scan: false,
			machine: "t",
			transcripts: {
				pollMs: 20,
				resolve: (agent: Agent) =>
					!miss && agent.sessionId === "with-log"
						? {
								source: { kind: "file", path: file },
								parse: support("pi").parse,
							}
						: null,
			},
		});
	});
	afterEach(() => {
		service.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const add = (sessionId: string) =>
		service.registry.upsert({
			harness: "pi",
			sessionId,
			pid: null,
			cwd: "/work/demo",
			project: "demo",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
		});

	test("page and subscribe by agent id", async () => {
		const agent = add("with-log");
		const page = await service.transcripts.page(agent.id);
		expect(page.available).toBe(true);
		expect(page.events.map((e) => e.id)).toContain("cm000001");
		const got: TranscriptEvent[] = [];
		const off = service.transcripts.subscribe(agent.id, (b) => {
			got.push(...b);
		});
		await service.transcripts.ready(agent.id);
		appendFileSync(file, line("svc1", "hello"));
		await until(() => got.length === 1, 2000);
		off();
		expect(service.transcripts.tailer.watching).toBe(0);
	});

	test("saved session links survive restart and cannot receive live messages", async () => {
		const original = add("with-log");
		const principal = { kind: "terminal" } as const;
		await service.app.agent(principal, original.id);
		service.stop();
		service = new PulsarService({
			store,
			scan: false,
			machine: "t",
			transcripts: {
				resolve: (agent) =>
					agent.sessionId === original.sessionId
						? {
								source: { kind: "file", path: file },
								parse: support("pi").parse,
							}
						: null,
			},
		});
		for (const id of [original.id, `${store.machineId()}/${original.id}`]) {
			const saved = await service.app.agent(principal, id);
			expect(saved).toMatchObject({
				id: original.id,
				archived: true,
				name: original.name,
				state: "offline",
				canStop: false,
				wake: "refuses",
				pid: null,
			});
			expect(
				(await service.transcripts.page(id)).events.map((e) => e.id),
			).toContain("cm000001");
		}
		expect(service.registry.deliveryAgent(original.id)).toBeUndefined();
		expect(service.registry.live()).toHaveLength(0);
		const sibling = add("second-session");
		add("pid:8123");
		expect(
			(await service.app.agent(principal, original.id)).openSessions,
		).toEqual([{ id: sibling.id, name: sibling.name }]);
		add("with-log");
		expect(
			(await service.app.agent(principal, original.id)).archived,
		).toBeUndefined();
	});

	test("agents without a transcript, unknown agents, bad cursors", async () => {
		const bare = add("no-log");
		// The harness keeps transcripts; this one is not found (yet).
		expect(await service.transcripts.page(bare.id)).toEqual({
			events: [],
			cursor: null,
			available: false,
			missing: "not_found",
		});
		await expect(service.transcripts.page("pi:nobody")).rejects.toMatchObject({
			code: "not_found",
		});
		const agent = add("with-log");
		await expect(
			service.transcripts.page(agent.id, "not-a-cursor"),
		).rejects.toMatchObject({ code: "bad_cursor" });
	});

	test("a lookup that misses for a moment never makes a transcript unavailable", async () => {
		const agent = add("with-log");
		const off = service.transcripts.subscribe(agent.id, () => {});
		await service.transcripts.ready(agent.id);
		const before = await service.transcripts.page(agent.id);
		miss = true;
		// The live watcher still follows the file: the page comes from it.
		const during = await service.transcripts.page(agent.id);
		expect(during.available).toBe(true);
		expect(during.events.map((e) => e.id)).toEqual(
			before.events.map((e) => e.id),
		);
		off();
		// Nobody watching and nothing found: no transcript (the app keeps the
		// events it holds; web/src/data/patch.ts).
		expect((await service.transcripts.page(agent.id)).available).toBe(false);
	});

	test("transcript.read over handle(): own transcript, operator, user; not others", async () => {
		const agent = add("with-log");
		const other = add("no-log");
		const self = fakeCaller({ kind: "agent", agentId: agent.id });
		const page = (await service.handle(self.caller, "transcript.read", {
			agent: agent.id,
		})) as TranscriptPage;
		expect(page.events.length).toBeGreaterThan(0);
		const nosy = fakeCaller({ kind: "agent", agentId: other.id });
		await expect(
			service.handle(nosy.caller, "transcript.read", { agent: agent.id }),
		).rejects.toMatchObject({ code: "forbidden" });
		const user = fakeCaller({ kind: "human", login: "me", node: "phone" });
		await service.handle(user.caller, "transcript.read", { agent: agent.id });
		const peer = fakeCaller({ kind: "peer", machineId: "m2", node: "b" });
		await expect(
			service.handle(peer.caller, "transcript.read", { agent: agent.id }),
		).rejects.toMatchObject({ code: "forbidden" });
	});

	test("follow streams transcript frames until the caller closes", async () => {
		const agent = add("with-log");
		const op = fakeCaller({ kind: "terminal" });
		await service.handle(op.caller, "transcript.read", {
			agent: agent.id,
			follow: true,
		});
		// Following again (e.g. to page earlier) adds no second subscription.
		await service.handle(op.caller, "transcript.read", {
			agent: agent.id,
			follow: true,
		});
		expect(service.transcripts.tailer.watching).toBe(1);
		expect(service.transcripts.tailer.subscribers(agent.id)).toBe(1);
		appendFileSync(file, line("f1", "followed"));
		await until(() => op.events.length === 1, 2000);
		await Bun.sleep(60);
		expect(op.events).toHaveLength(1);
		expect(op.events[0]).toMatchObject({
			event: "transcript",
			data: { agent: agent.id, events: [{ id: "f1" }] },
		});
		op.close();
		expect(service.transcripts.tailer.watching).toBe(0);
	});
});

describe("why there is no transcript", () => {
	const agent = (harness: string, sessionId: string | null) =>
		({ harness, sessionId, cwd: "/work/demo", meta: {} }) as unknown as Agent;

	test("by harness: none kept, no session yet, or not found yet", () => {
		expect(driverMissing(agent("opencode", "ses_1"))).toBe("unsupported");
		expect(driverMissing(agent("cursor", null))).toBe("unsupported");
		// A Codex app-server before it learns its thread.
		expect(driverMissing(agent("codex", null))).toBe("no_session");
		expect(driverMissing(agent("claude", null))).toBe("no_session");
		expect(driverMissing(agent("codex", "t1"))).toBe("not_found");
		// pi and omp register by pid and find the file by folder.
		expect(driverMissing(agent("pi", null))).toBe("not_found");
		expect(driverMissing(agent("omp", null))).toBe("not_found");
		expect(subagentMissing(agent("opencode", "ses_1"))).toBe("unsupported");
		expect(subagentMissing(agent("claude", "s"))).toBe("not_found");
	});

	test("a remote page: the home node's reason; an older one's bare false is a miss", async () => {
		const pages: unknown[] = [];
		const reader = new RemoteTranscriptReader({
			act: async () => ({ page: pages.shift() }),
		} as unknown as ConstructorParameters<typeof RemoteTranscriptReader>[0]);
		pages.push({ events: [], cursor: null, available: false });
		expect(await reader.page("m1/pi:pid:1", null)).toEqual({
			events: [],
			cursor: null,
			available: false,
			missing: "not_found",
		});
		pages.push({
			events: [],
			cursor: null,
			available: false,
			missing: "unsupported",
		});
		expect((await reader.page("m1/opencode:x", null)).missing).toBe(
			"unsupported",
		);
		pages.push({ events: [], cursor: null, available: false, missing: "?" });
		expect((await reader.page("m1/pi:pid:1", null)).missing).toBe("not_found");
		// A home node that does not answer: an error to retry, never "none".
		const failing = new RemoteTranscriptReader({
			act: async () => {
				throw new RpcError("unreachable", "m1 is unreachable");
			},
		} as unknown as ConstructorParameters<typeof RemoteTranscriptReader>[0]);
		await expect(failing.page("m1/pi:pid:1", null)).rejects.toMatchObject({
			code: "unreachable",
		});
		pages.push({ events: [], cursor: null, available: true });
		expect(await reader.page("m1/pi:pid:1", null)).toEqual({
			events: [],
			cursor: null,
			available: true,
		});
	});
});

describe("omp host detection", () => {
	test("omp as one Bun binary is omp, not pi", () => {
		// What the extension sees inside omp built as one Bun binary
		// (process.execPath, argv0, argv).
		const omp =
			"/Users/me/.bun/bin/omp omp bun /$bunfs/root/omp-darwin-arm64 --resume";
		expect(isOmpHost("bun /$bunfs/root/omp-darwin-arm64")).toBe(true);
		expect(extensionHostFor(omp)?.id).toBe("omp");
		expect(
			extensionHostFor("/usr/local/bin/node /x/node_modules/@oh-my-pi/cli.js")
				?.id,
		).toBe("omp");
		// pi stays pi.
		expect(
			extensionHostFor(
				"/opt/homebrew/bin/node node /opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/cli.js",
			)?.id,
		).toBe("pi");
		expect(extensionHostFor("/usr/local/bin/pi pi")?.id).toBe("pi");
		expect(isOmpHost("/usr/local/bin/compose")).toBe(false);
	});
});
