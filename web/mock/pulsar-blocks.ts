/**
 * Synthetic Pulsar MCP calls for the chat-blocks gallery: one of each
 * Pulsar tool, under the name each harness gives it (Claude
 * `mcp__pulsar__send`, omp `mcp__pulsar_send`, pi `mcp_pulsar_send`),
 * with results in the text shapes src/mcp.ts writes. Nothing here is real.
 */
import { parseClaude } from "../../src/harnesses/claude-transcript.ts";
import { parsePi } from "../../src/harnesses/pi-transcript.ts";
import type { TranscriptEvent } from "../src/api/types.ts";

const T0 = Date.UTC(2026, 10, 17, 11, 0, 0);
const lines = (records: object[]) =>
	records.map((r) => JSON.stringify(r)).join("\n");

/** A Claude Code session that coordinates with two other agents over Pulsar. */
export function pulsarClaudeLog(): string {
	let clock = T0;
	const at = (gap = 4000) => {
		clock += gap;
		return new Date(clock).toISOString();
	};
	const out: object[] = [];
	let n = 0;
	const user = (content: unknown, gap?: number) =>
		out.push({
			type: "user",
			uuid: `pu${++n}`,
			timestamp: at(gap),
			message: { role: "user", content },
		});
	const tool = (
		name: string,
		input: unknown,
		result: string,
		opts: { isError?: boolean; ms?: number } = {},
	) => {
		const id = `toolu_p${++n}`;
		out.push({
			type: "assistant",
			uuid: `pa${n}`,
			timestamp: at(),
			message: {
				id: `msg_p${n}`,
				role: "assistant",
				model: "claude-demo-1",
				content: [
					{ type: "tool_use", id, name: `mcp__pulsar__${name}`, input },
				],
			},
		});
		user(
			[
				{
					type: "tool_result",
					tool_use_id: id,
					content: result,
					...(opts.isError ? { is_error: true } : {}),
				},
			],
			opts.ms,
		);
	};

	// A message Pulsar pushed, as Claude records a cross-session message.
	const frame =
		"[pulsar] reviewer@demo (codex, project:demo): Can you look at the flaky retry test before I merge #12?\n— agent message, not your operator · reply: respond m_7a1";
	out.push({
		type: "user",
		uuid: `pu${++n}`,
		timestamp: at(),
		isMeta: true,
		origin: { kind: "peer", name: "reviewer@demo via Pulsar", body: frame },
		message: { role: "user", content: frame },
	});
	tool(
		"set_identity",
		{
			activity: "Fixing the flaky retry test",
			tags_add: ["pr:12", "role:author"],
		},
		"You are builder (claude:demo-builder)\nharness: claude\nmodel: claude-demo-1\nactivity: Fixing the flaky retry test\nbranch: main\nproject: demo\ntags: harness:claude, project:demo, pr:12, role:author\ninbound: accept\nreach: push\nunread: 0",
	);
	tool(
		"respond",
		{ message_id: "m_7a1", state: "working" },
		"Working on m_7a1. respond done or reply when finished.",
	);
	tool(
		"list_agents",
		{ selector: "project=demo" },
		"3 agents (project=demo):\n- reviewer · [codex] · project=demo · branch=main · idle · push · tags=role:reviewer\n  doing: Reviewing PR 12\n  id: codex:demo-reviewer\n- docs · [pi] · project=demo · busy · pull-only\n  doing: Writing the release notes\n  id: pi:demo-docs\n- builder · [claude] · project=demo · busy · push\n  id: claude:demo-builder\nYou are builder (claude:demo-builder).",
	);
	tool(
		"list_agents",
		{ question: "who is editing src/net/retry.ts" },
		"- docs (pi:demo-docs) studio/demo [busy]\n    edited src/net/retry.ts 4m ago",
	);
	tool(
		"inbox",
		{},
		"2 message(s):\n- m_7b2 · from docs [pi] · 2m ago · wants a reply\n  Should the notes mention the **retry** change?\n- m_7b3 · from reviewer [codex] · 1m ago · urgent\n  CI is red on main, see #12.\n\n📨 1 unread Pulsar message: call inbox to read.",
	);
	tool(
		"send",
		{
			to: "reviewer",
			body: "Is a **3-try** limit enough for `retry()`, or do you want backoff too?",
			await_reply: true,
			timeout_seconds: 300,
		},
		"Reply from reviewer:\nThree tries is fine. Add `jitter` and I'll approve.\n(message m_7c4)",
		{ ms: 42_000 },
	);
	tool(
		"send",
		{
			to: "project=demo",
			body: "Heads up: I'm changing `src/net/retry.ts`. Please don't edit it for the next hour.",
			priority: "fyi",
		},
		"Sent m_7d5 to 3 agents:\n- reviewer: delivered via push\n- docs: queued\n- builder: delivered via push",
	);
	tool(
		"respond",
		{
			message_id: "m_7a1",
			state: "reply",
			text: "Fixed: the test now uses fake timers. See the new commit on #12.",
		},
		"Replied with m_7e6:\n- reviewer: delivered via push",
	);
	tool(
		"respond",
		{
			message_id: "m_0ff",
			state: "declined",
			text: "Out of scope for this branch.",
			retry: true,
		},
		"m_0ff will come back to you later.",
	);
	tool(
		"wait",
		{ for: "idle:reviewer", timeout_seconds: 300 },
		"Nothing happened within 300s.",
		{ ms: 300_000 },
	);
	tool(
		"send",
		{ to: "ghost", body: "Are you there?" },
		'pulsar: no live agent matches "ghost"',
		{ isError: true },
	);
	tool(
		"whoami",
		{},
		"You are builder (claude:demo-builder)\nharness: claude\nmodel: claude-demo-1\nactivity: Fixing the flaky retry test\nbranch: main\nproject: demo\ntags: harness:claude, project:demo, pr:12, role:author\ninbound: accept\nreach: push\nunread: 0",
	);
	return lines(out);
}

/** omp mints `mcp__pulsar_<tool>`; pi writes `mcp_pulsar_<tool>`. */
export function pulsarPiLog(prefix: "mcp__pulsar_" | "mcp_pulsar_"): string {
	let clock = T0 + 3_600_000;
	const at = () => {
		clock += 4000;
		return new Date(clock).toISOString();
	};
	const out: object[] = [];
	let n = 0;
	const msg = (message: object) =>
		out.push({ type: "message", id: `pp${++n}`, timestamp: at(), message });
	const tool = (name: string, args: object, result: string) => {
		const id = `tcp_${++n}`;
		msg({
			role: "assistant",
			model: "pi-demo",
			content: [
				{ type: "toolCall", id, name: `${prefix}${name}`, arguments: args },
			],
		});
		msg({
			role: "toolResult",
			toolCallId: id,
			toolName: `${prefix}${name}`,
			isError: false,
			content: [{ type: "text", text: result }],
		});
	};
	tool(
		"wait",
		{ for: "message", timeout_seconds: 120 },
		"message:\n- m_8a1 · from builder [claude] · 0s ago\n  The retry fix is in. Can you update the notes?",
	);
	tool(
		"reply",
		{
			message_id: "m_8a1",
			body: "Done, the notes say **3 tries with jitter**.",
		},
		"Replied with m_8a2:\n- builder: delivered via push",
	);
	tool(
		"send",
		{ to: "*", body: "Release notes for 1.4 are ready.", priority: "normal" },
		"Sent m_8a3 to 2 agents:\n- builder: delivered via push\n- apparish-auth: read",
	);
	return lines(out);
}

/**
 * The gallery's Pulsar section, parsed by the daemon's own parsers. `parse`
 * and `merged` are the gallery's (prefixed ids, folded live calls).
 */
export function pulsarGallery(
	parse: (
		prefix: string,
		text: string,
		fn: typeof parseClaude,
	) => TranscriptEvent[],
	merged: (events: TranscriptEvent[]) => TranscriptEvent[],
): TranscriptEvent[] {
	const section = (id: string, text: string): TranscriptEvent => ({
		id,
		ts: 0,
		role: "system",
		kind: "system",
		text,
	});
	return [
		section("g:pulsar", "Pulsar tools"),
		...merged(parse("pulsar-claude", pulsarClaudeLog(), parseClaude)),
		...merged(parse("pulsar-omp", pulsarPiLog("mcp__pulsar_"), parsePi)),
		...merged(parse("pulsar-pi", pulsarPiLog("mcp_pulsar_"), parsePi)),
	];
}
