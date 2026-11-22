/**
 * Fake transcripts: a deterministic history per agent plus a live generator
 * that streams new events (growing assistant text, tool calls and results,
 * peer messages, subagent sidechains) while someone has the session open.
 */
import { parsePi } from "../../src/harnesses/pi-transcript.ts";
import { formatPush, type PushMessage } from "../../src/push-frame.ts";
import { newParseState } from "../../src/transcripts/types.ts";
import type { TranscriptEvent } from "../src/api/types.ts";
import { galleryEvents } from "./blocks.ts";
import { BLOCKS, FIX, type MockAgent, OMP_BLOCKS, rng } from "./data.ts";

interface Log {
	events: TranscriptEvent[];
	seq: number;
	rand: () => number;
	/** Live generator state. */
	script: TranscriptEvent[][];
	ts: number;
}

const logs = new Map<string, Log>();

function hash(s: string) {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++)
		h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

const FILES = [
	"src/auth/session.ts",
	"src/auth/token.ts",
	"src/billing/invoice.ts",
	"src/router.ts",
	"src/cache/lru.ts",
	"test/auth.test.ts",
	"README.md",
];

const SAYS = [
	"I'll read the session module first.",
	"The refresh path runs twice when two requests see an expired token at once. I'll put it behind a lock.",
	"Tests pass. Here's what changed:\n\n- `refresh()` now runs inside `lock.run()`\n- added a regression test for **concurrent** refreshes\n- removed the stale `retry` flag\n\n| file | change |\n| --- | --- |\n| `session.ts` | +12 -3 |\n| `auth.test.ts` | +41 |",
	"Let me check who else calls `refresh()` before I change its signature.",
	"Found 4 callers. Only `middleware.ts` depends on the old return value; updating it too.",
	"CI is green on my branch. I'll push and update the PR description of #1402 (`gh pr edit #1402`).",
	"That flake is a timing issue in the test, not the code: it uses a real clock. Switching it to fake timers.",
];

function ev(
	log: Log,
	agent: MockAgent,
	e: Omit<TranscriptEvent, "id" | "ts">,
): TranscriptEvent {
	log.ts += 1000 + Math.floor(log.rand() * 20000);
	return { id: `${agent.id}#${++log.seq}`, ts: log.ts, ...e };
}

/** One realistic turn: request, reading, editing, testing, maybe a peer and a subagent. */
function turn(log: Log, agent: MockAgent, live = false): TranscriptEvent[][] {
	const r = log.rand;
	const file = FILES[Math.floor(r() * FILES.length)]!;
	const steps: TranscriptEvent[][] = [];
	const add = (e: Omit<TranscriptEvent, "id" | "ts">) =>
		steps.push([ev(log, agent, e)]);
	if (!live || r() < 0.3)
		add({
			role: "user",
			kind: "text",
			text:
				r() < 0.5
					? "Fix the token refresh race in auth/session.ts"
					: "rebase on main before pushing",
			from: "you via pulsar (studio)",
		});
	const think = r();
	if (think < 0.6)
		add({
			role: "assistant",
			kind: "thinking",
			text:
				think < 0.35
					? "The race: two callers both observe `token.expired` before either refresh finishes. A mutex around refresh would serialize them; the second caller should reuse the first result."
					: // Claude Code saves only a signature unless showThinkingSummaries is on.
						"",
			model: agent.model ?? undefined,
		});
	add({
		role: "assistant",
		kind: "text",
		text: SAYS[Math.floor(r() * SAYS.length)]!,
		model: agent.model ?? undefined,
	});
	const cid = () => `call_${Math.floor(r() * 1e9).toString(36)}`;
	const tool = (
		name: string,
		input: Record<string, unknown>,
		summary: string,
		text: string,
		extra: Partial<TranscriptEvent["tool"]> = {},
		sidechain?: string,
	) => {
		const callId = cid();
		steps.push([
			ev(log, agent, {
				role: "assistant",
				kind: "tool_call",
				text: "",
				tool: { name, callId, input },
				sidechain,
			}),
		]);
		steps.push([
			ev(log, agent, {
				role: "tool",
				kind: "tool_result",
				text,
				tool: { name, callId, summary, ...extra },
				sidechain,
			}),
		]);
	};
	tool(
		"Read",
		{ file_path: file },
		`${120 + Math.floor(r() * 300)} lines`,
		"export async function getSession() {\n  if (token.expired) refresh()\n  return token\n}\n",
	);
	if (r() < 0.7)
		tool(
			"Edit",
			{
				file_path: file,
				old_string: "  if (token.expired) refresh()\n  return token",
				new_string:
					"  if (token.expired) {\n    await lock.run(() => refresh())\n  }\n  return token",
			},
			"+3 -1",
			"The file has been updated.",
		);
	if (r() < 0.25)
		tool(
			"Write",
			{
				file_path: "test/refresh.test.ts",
				content:
					'import { test, expect } from "bun:test";\n\ntest("concurrent refresh runs once", async () => {\n  await Promise.all([getSession(), getSession()]);\n  expect(refreshCalls).toBe(1);\n});\n',
			},
			"+6",
			"File created.",
		);
	const passed = 30 + Math.floor(r() * 40);
	const failed = r() < 0.15;
	tool(
		"Bash",
		{ command: "bun test auth", description: "Run auth tests" },
		failed ? "1 failed · exit 1" : `${passed} passed · 3.1s`,
		failed
			? "✗ refresh > concurrent refresh runs once\n  expected 1, received 2\n"
			: `${passed} pass\n0 fail\nRan ${passed} tests across 4 files. [3.10s]\n`,
		failed ? { isError: true } : {},
	);
	if (r() < 0.35)
		add({
			role: "peer",
			kind: "peer",
			text: "I'm touching session.ts too, hold refresh() for 10 minutes?",
			from: "codex@apparish · m_7a1",
		});
	if (r() < 0.3) {
		const taskId = cid();
		steps.push([
			ev(log, agent, {
				role: "assistant",
				kind: "tool_call",
				text: "",
				tool: {
					name: "Task",
					callId: taskId,
					input: {
						description: "find callers",
						prompt:
							"Find every caller of refresh() and report how each uses the return value.",
					},
				},
			}),
		]);
		const n = 3 + Math.floor(r() * 5);
		for (let i = 0; i < n; i++) {
			if (i % 2 === 0)
				tool(
					"Grep",
					{ pattern: "refresh\\(", path: "src" },
					`${2 + Math.floor(r() * 6)} matches`,
					"src/middleware.ts:14: refresh()\nsrc/api.ts:88: await refresh()\n",
					{},
					taskId,
				);
			else
				steps.push([
					ev(log, agent, {
						role: "assistant",
						kind: "text",
						text: "Checking `middleware.ts`.",
						sidechain: taskId,
					}),
				]);
		}
		steps.push([
			ev(log, agent, {
				role: "tool",
				kind: "tool_result",
				text: "4 callers: middleware.ts, api.ts, worker.ts, cli.ts.",
				tool: { name: "Task", callId: taskId, summary: `${n} steps` },
			}),
		]);
	}
	if (r() < 0.1)
		add({
			role: "system",
			kind: "system",
			text: "Background task finished: lint (0 problems)",
		});
	return steps;
}

function xssHistory(log: Log, agent: MockAgent): TranscriptEvent[] {
	const out: TranscriptEvent[] = [];
	const push = (e: Omit<TranscriptEvent, "id" | "ts">) =>
		out.push(ev(log, agent, e));
	push({
		role: "user",
		kind: "text",
		text: '<img src=x onerror="window.__xss=10"> please render me as text',
		from: '<b onclick="window.__xss=11">you</b>',
	});
	push({
		role: "assistant",
		kind: "text",
		text: 'Markdown test: <script>window.__xss=12</script> and <img src=x onerror="window.__xss=13"> and [click me](javascript:window.__xss=14) and [data](data:text/html,<script>alert(1)</script>) and <a href="javascript:window.__xss=15">raw link</a>. **bold** stays bold.',
	});
	push({
		role: "assistant",
		kind: "thinking",
		text: '<iframe src="javascript:window.__xss=16"></iframe>',
	});
	push({
		role: "assistant",
		kind: "tool_call",
		text: "",
		tool: {
			name: "Bash",
			callId: "x1",
			input: { command: 'echo "<svg onload=window.__xss=17>"' },
		},
	});
	push({
		role: "tool",
		kind: "tool_result",
		text: '<svg onload="window.__xss=18"></svg>\n<style>body{display:none}</style>',
		tool: { name: "Bash", callId: "x1", summary: "<b>exit 0</b>" },
	});
	push({
		role: "assistant",
		kind: "tool_call",
		text: "",
		tool: {
			name: "Edit",
			callId: "x2",
			input: {
				file_path: "<img src=x onerror=window.__xss=19>.ts",
				old_string: "<div>old</div>",
				new_string: '<div onclick="window.__xss=20">new</div>',
			},
		},
	});
	push({
		role: "tool",
		kind: "tool_result",
		text: "ok",
		tool: { name: "Edit", callId: "x2", summary: "+1 -1" },
	});
	push({
		role: "peer",
		kind: "peer",
		text: "<script>window.__xss=21</script>peer says hi",
		from: '<img src=x onerror="window.__xss=22">',
	});
	push({ role: "system", kind: "system", text: "<marquee>system</marquee>" });
	push({
		role: "assistant",
		kind: "text",
		text: 'Docs: [the spec](https://example.com/spec?x=1). Pixels: ![px](https://evil.example/pixel.gif) and <img src="https://evil.example/p2.gif"> and [data link](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==) and <a href="vbscript:msgbox(1)">vb</a> and <form action="https://evil.example"><button>go</button></form>',
	});
	const bad = ev(log, agent, {
		role: "user",
		kind: "text",
		text: "[image]",
		from: "you via pulsar (studio)",
	});
	out.push(bad);
	bad.images = [
		{
			id: `${bad.id}#img9`,
			mediaType: "image/png",
			url: imageUrl(agent.id, `${bad.id}#img9`),
		},
	];
	return out;
}

/**
 * Messages Pulsar pushed into omp's session, framed by the daemon's own
 * `formatPush` and read back by the real pi/omp parser: the operator's
 * proven send, an unverified app send, and an agent's message.
 */
function pushedHistory(log: Log, agent: MockAgent): TranscriptEvent[] {
	const msg = (id: string, body: string): PushMessage => ({
		id,
		threadId: id,
		fromId: "user:ada@example.com",
		fromName: "user",
		to: agent.id,
		body,
		priority: "normal",
		replyTo: null,
		expectReply: false,
		createdAt: 0,
	});
	const app = {
		name: "user",
		harness: "user",
		project: null,
		machine: "studio",
	};
	const texts = [
		formatPush(msg("m_op1", "tighten the refresh lock and add a test"), app, {
			kind: "human",
			name: "Ada Lovelace",
		}),
		formatPush(msg("m_app1", "is the deploy done?"), app, {
			kind: "unverified",
		}),
		formatPush(msg("m_ag1", "rebased main, go ahead"), {
			name: "codex@apparish",
			harness: "codex",
			project: "apparish",
			machine: "studio",
		}),
	];
	const lines = texts.map((content, i) => {
		log.ts += 4000;
		return JSON.stringify({
			type: "custom_message",
			customType: "pulsar",
			content,
			display: true,
			details: { id: `push${i}`, from: "user" },
			id: `${agent.id}-push${i}`,
			timestamp: new Date(log.ts).toISOString(),
		});
	});
	return parsePi(`${lines.join("\n")}\n`, newParseState());
}

/** Image URL in the daemon's form: `/api/v1/agents/:id/transcript/images/:imageId`, encoded. */
export function imageUrl(agentId: string, imageId: string) {
	return `/api/v1/agents/${encodeURIComponent(agentId)}/transcript/images/${encodeURIComponent(imageId)}`;
}

/** Rich content for the fixture sessions: code, a table, math, mermaid, images. */
function showcase(log: Log, agent: MockAgent): TranscriptEvent[] {
	const out: TranscriptEvent[] = [];
	const push = (e: Omit<TranscriptEvent, "id" | "ts">) => {
		const x = ev(log, agent, e);
		out.push(x);
		return x;
	};
	const user = push({
		role: "user",
		kind: "text",
		text: "[image]",
		from: "you via pulsar (studio)",
	});
	user.images = [
		{
			id: `${user.id}#img1`,
			mediaType: "image/png",
			url: imageUrl(agent.id, `${user.id}#img1`),
		},
	];
	push({
		role: "user",
		kind: "text",
		text: "Here's the flaky run from CI. Can you explain the refresh flow and fix it?",
		from: "you via pulsar (studio)",
	});
	push({
		role: "assistant",
		kind: "thinking",
		text: "Two requests race on `token.expired`. Serialize with a lock; the second caller awaits the first refresh.",
	});
	push({
		role: "assistant",
		kind: "text",
		text: [
			"The refresh path races. Here's the flow today:",
			"",
			"```mermaid",
			"sequenceDiagram",
			"  participant A as request A",
			"  participant S as session.ts",
			"  participant B as request B",
			"  A->>S: token.expired?",
			"  B->>S: token.expired?",
			"  S-->>A: refresh()",
			"  S-->>B: refresh() (again)",
			"```",
			"",
			"And the fixed path:",
			"",
			"```mermaid",
			"flowchart LR",
			"  A[request A] --> L{lock free?}",
			"  B[request B] --> L",
			"  L -- yes --> R[refresh once]",
			"  L -- no --> W[await the same refresh]",
			"  R --> T((token))",
			"  W --> T",
			"```",
			"",
			"Where the time goes:",
			"",
			"```mermaid",
			"pie title refresh time",
			'  "network" : 70',
			'  "lock wait" : 30',
			"```",
			"",
			"Inline math: the retry count grows as $n^2$; the plan costs $5 and $6 per seat.",
			"",
			"```mermaid",
			"mindmap",
			"  root((refresh))",
			"    lock",
			"    retry",
			"```",
			"",
			"And a language Shiki isn't bundled with:",
			"",
			"```cobol",
			"IDENTIFICATION DIVISION.",
			"```",
			"",
			"The fix puts `refresh()` behind a lock:",
			"",
			"```ts",
			"export async function getSession(): Promise<Token> {",
			"  if (token.expired) {",
			"    await lock.run(() => refresh());",
			"  }",
			"  return token;",
			"}",
			"```",
			"",
			"| case | before | after |",
			"| --- | --- | --- |",
			"| 2 concurrent requests | 2 refreshes | 1 refresh |",
			"| 10 concurrent requests | 10 refreshes | 1 refresh |",
			"",
			"Expected refreshes drop from n to 1. With retry backoff the wait is",
			"",
			"$$t = \\sum_{k=0}^{r} 2^k \\cdot 50\\,\\text{ms}$$",
		].join("\n"),
	});
	const cid = "call_showcase";
	push({
		role: "assistant",
		kind: "tool_call",
		text: "",
		tool: {
			name: "Bash",
			callId: cid,
			input: { command: "bun test auth --reporter=dots" },
		},
	});
	const res = push({
		role: "tool",
		kind: "tool_result",
		text: "[image]\n41 pass\n0 fail",
		tool: { name: "Bash", callId: cid, summary: "41 passed · 2.8s" },
	});
	res.images = [
		{
			id: `${res.id}#img1`,
			mediaType: "image/png",
			url: imageUrl(agent.id, `${res.id}#img1`),
		},
	];
	// Every tool-card shape the design system draws.
	const call = (
		name: string,
		input: Record<string, unknown>,
		summary: string,
		text: string,
		extra: Record<string, unknown> = {},
	) => {
		const id = `call_sc_${out.length}`;
		push({
			role: "assistant",
			kind: "tool_call",
			text: "",
			tool: { name, callId: id, input },
		});
		push({
			role: "tool",
			kind: "tool_result",
			text,
			tool: { name, callId: id, summary, ...extra },
		});
	};
	push({
		role: "assistant",
		kind: "text",
		text: "Before I push, a wider check: who else calls `refresh()`, and does the full suite pass?",
	});
	call(
		"Grep",
		{ pattern: "refresh\\(", path: "src", output_mode: "content" },
		"4 matches",
		"src/middleware.ts:14:  if (expired) refresh()\nsrc/api.ts:88:  await refresh()\nsrc/auth/session.ts:12:    await lock.run(() => refresh())\nsrc/auth/token.ts:40:export async function refresh() {",
	);
	call(
		"TodoWrite",
		{
			todos: [
				{ content: "Put refresh() behind a lock", status: "completed" },
				{
					content: "Regression test for concurrent refreshes",
					status: "completed",
				},
				{ content: "Update middleware.ts caller", status: "in_progress" },
				{ content: "Push and update the PR description", status: "pending" },
			],
		},
		"",
		"Todos updated.",
	);
	call(
		"Bash",
		{
			command:
				'git diff --stat origin/main...HEAD && BUN_ENV=test bun test --bail 2>&1 | tee /tmp/run.log | grep -E "(pass|fail)"',
			description: "Diff stat against main, then the full suite",
		},
		"1 failed · exit 1",
		" src/auth/session.ts      |  6 ++++--\n test/refresh.test.ts     | 14 ++++++++++++++\n 2 files changed, 18 insertions(+), 2 deletions(-)\n\n✗ middleware > refreshes an expired token\n  expected 200, received 401\n  at test/middleware.test.ts:31:18\n\n312 pass\n1 fail",
		{ isError: true },
	);
	call(
		"Write",
		{
			file_path: "src/middleware.ts",
			content:
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a code sample inside the fixture
				'import { getSession } from "./auth/session";\n\nexport async function auth(req: Request): Promise<Response | null> {\n  const token = await getSession();\n  if (!token) return new Response("unauthorized", { status: 401 });\n  req.headers.set("authorization", `Bearer ${token.value}`);\n  return null;\n}\n',
		},
		"+8",
		"File created.",
	);
	push({
		role: "peer",
		kind: "peer",
		text: "Heads up: I'm rebasing `main` in ~5 min. Push before then and I'll pick up your lock change.",
		// Never from the session's own agent (the codex README shot).
		from: `${agent === FIX.codex ? "apparish-auth" : "codex@apparish"} · m_7a1`,
	});
	return out;
}

export function logFor(agent: MockAgent): Log {
	let log = logs.get(agent.id);
	if (log) return log;
	const rand = rng(hash(agent.id));
	log = {
		events: [],
		seq: 0,
		rand,
		script: [],
		ts: agent.lastActive - 6 * 3_600_000,
	};
	const big = agent.fixed && agent.machine === "studio";
	if (agent === FIX.xss) log.events.push(...xssHistory(log, agent));
	else if (agent === BLOCKS || agent === OMP_BLOCKS) {
		const all = galleryEvents((imageId) => imageUrl(agent.id, imageId));
		const events =
			agent === OMP_BLOCKS ? all.filter((e) => e.id.startsWith("omp:")) : all;
		for (const e of events) {
			log.ts += 2000;
			log.events.push({ ...e, ts: log.ts });
		}
	} else {
		const target = big ? 360 : 40 + Math.floor(rand() * 60);
		while (log.events.length < target)
			for (const s of turn(log, agent)) log.events.push(...s);
		if (agent.fixed && agent.machine === "studio")
			log.events.push(...showcase(log, agent));
		if (agent === FIX.omp) log.events.push(...pushedHistory(log, agent));
	}
	logs.set(agent.id, log);
	return log;
}

/**
 * Advance an open session by one step. Assistant text streams in pieces:
 * live events that share an id, each replacing the last (like the daemon's
 * re-sent blocks).
 */
export function step(agent: MockAgent): TranscriptEvent[] {
	// The gallery holds still for screenshots.
	if (agent === BLOCKS) return [];
	const log = logFor(agent);
	if (log.script.length === 0) {
		const steps = turn(log, agent, true);
		for (const s of steps) {
			const e = s[0]!;
			if (e.kind === "text" && e.role === "assistant" && e.text.length > 24) {
				const words = e.text.split(" ");
				const pieces: TranscriptEvent[][] = [];
				for (let i = 6; i < words.length; i += 6)
					pieces.push([{ ...e, text: words.slice(0, i).join(" ") }]);
				pieces.push([{ ...e }]);
				log.script.push(...pieces);
			} else log.script.push(s);
		}
	}
	const next = log.script.shift() ?? [];
	const out: TranscriptEvent[] = [];
	for (const e of next) {
		e.ts = Date.now();
		upsert(log, e);
		out.push(e);
		// Like the daemon: a finished tool call is re-sent under its own id with
		// the result folded into `tool.summary`.
		if (e.kind === "tool_result" && e.tool?.callId) {
			const call = log.events.find(
				(x) => x.kind === "tool_call" && x.tool?.callId === e.tool?.callId,
			);
			if (call?.tool) {
				const folded: TranscriptEvent = {
					...call,
					tool: {
						...call.tool,
						summary: e.tool.summary,
						isError: e.tool.isError,
					},
				};
				upsert(log, folded);
				out.push(folded);
			}
		}
	}
	return out;
}

function upsert(log: Log, e: TranscriptEvent) {
	const i = log.events.findIndex((x) => x.id === e.id);
	if (i >= 0) log.events[i] = e;
	else log.events.push(e);
}

export function page(agent: MockAgent, cursor: string | null, limit = 150) {
	const log = logFor(agent);
	// The gallery is one page: every block renders without "load earlier".
	if (agent === BLOCKS) limit = Math.max(limit, log.events.length);
	const end = cursor ? Math.max(0, Number(cursor)) : log.events.length;
	const start = Math.max(0, end - limit);
	// `{events, cursor, available}`: the newest page first; cursor null at the start.
	return {
		events: log.events.slice(start, end),
		cursor: start > 0 ? String(start) : null,
		available: true,
	};
}

/** The event that carries an image id, if the log still has it. */
export function findImage(
	agent: MockAgent,
	imageId: string,
): TranscriptEvent | null {
	return (
		logFor(agent).events.find(
			(e) =>
				e.images?.some((i) => i.id === imageId) ||
				e.documents?.some((d) => d.id === imageId),
		) ?? null
	);
}

/** Mock only: appends one line to an agent's transcript now (the realtime tests). */
export function appendLine(
	agent: MockAgent,
	text: string,
	role: TranscriptEvent["role"] = "assistant",
	extra: Partial<TranscriptEvent> = {},
): TranscriptEvent {
	const log = logFor(agent);
	const e: TranscriptEvent = {
		id: `${agent.id}#rt${++log.seq}`,
		ts: Date.now(),
		role,
		kind: "text",
		text,
		...extra,
	};
	upsert(log, e);
	return e;
}

/**
 * The operator's send as the agent's transcript records it (the daemon's
 * push frame, parsed): a user turn tagged with its Pulsar message id, so
 * the bubble can show its delivery state.
 */
export function appendOperatorTurn(
	agent: MockAgent,
	text: string,
	messageId: string,
	machine = "studio",
): TranscriptEvent {
	const log = logFor(agent);
	const e: TranscriptEvent = {
		id: `${agent.id}#op${++log.seq}`,
		ts: Date.now(),
		role: "user",
		kind: "text",
		text,
		from: "You",
		pulsar: { sender: "operator", messageId, machine },
	};
	upsert(log, e);
	return e;
}
