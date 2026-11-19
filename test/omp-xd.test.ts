import { describe, expect, test } from "bun:test";
import { parsePi } from "../src/harnesses/pi-transcript.ts";
import { callLine, describeCall } from "../src/transcripts/describe.ts";
import {
	newParseState,
	type TranscriptEvent,
} from "../src/transcripts/types.ts";

// Synthetic omp session lines: invented servers, tools and values.
const TS = "2026-11-10T13:00:00.000Z";
let n = 0;
const line = (message: Record<string, unknown>) =>
	JSON.stringify({
		type: "message",
		id: `rec${++n}`,
		timestamp: TS,
		message,
	});
const call = (id: string, name: string, args: Record<string, unknown>) =>
	line({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
	});
const result = (
	id: string,
	text: string,
	details?: Record<string, unknown>,
	isError = false,
) =>
	line({
		role: "toolResult",
		toolCallId: id,
		toolName: "write",
		content: [{ type: "text", text }],
		isError,
		...(details ? { details } : {}),
	});
const mcpDetails = (
	device: string,
	server: string,
	tool: string,
	args: Record<string, unknown>,
) => ({
	xdev: {
		tool: device,
		mode: "execute",
		args,
		tier: "write",
		inner: { serverName: server, mcpToolName: tool, provider: "mcp" },
	},
});

function parse(...lines: string[]) {
	const state = newParseState({ atStart: true, cwd: "/work/demo" });
	return parsePi(`${lines.join("\n")}\n`, state);
}
/** The last version of each call (a result re-emits its call in place). */
function calls(events: TranscriptEvent[]) {
	const out = new Map<string, TranscriptEvent>();
	for (const e of events) if (e.kind === "tool_call") out.set(e.id, e);
	return [...out.values()];
}

describe("omp xd:// device writes", () => {
	test("an MCP write reads as the MCP call, split by the result", () => {
		const args = { folder: "Archive", item: 42, done: true };
		const events = parse(
			call("c1", "write", {
				i: "Mark it done",
				path: "xd://mcp__demo_mail_mark_done",
				content: JSON.stringify({ ...args, i: "habit" }),
			}),
			result(
				"c1",
				'{"ok":true}',
				mcpDetails("mcp__demo_mail_mark_done", "demo-mail", "mark_done", args),
			),
		);
		const first = events.find((e) => e.kind === "tool_call")!;
		// While it runs, the device name stays whole: the split isn't known yet.
		expect(first.tool?.name).toBe("mcp__demo_mail_mark_done");
		expect(first.tool?.input).toEqual(args);
		const [done] = calls(events);
		expect(done!.tool).toMatchObject({
			name: "mcp__demo-mail__mark_done",
			input: args,
			done: true,
		});
		expect(done!.tool?.summary).toStartWith("Called demo-mail.mark_done");
		const res = events.find((e) => e.kind === "tool_result")!;
		expect(res.tool?.name).toBe("mcp__demo-mail__mark_done");
		expect(res.text).toBe('{"ok":true}');
		for (const e of events) {
			expect(e.tool?.summary ?? "").not.toContain("Wrote");
			expect(e.tool?.summary ?? "").not.toContain("xd://");
		}
	});

	test("server names with underscores split by the result, and later calls learn it", () => {
		const events = parse(
			call("a", "write", {
				path: "xd://mcp__my_db_tools_run_query",
				content: '{"sql":"select 1"}',
			}),
			result(
				"a",
				"1",
				mcpDetails("mcp__my_db_tools_run_query", "my_db_tools", "run_query", {
					sql: "select 1",
				}),
			),
			call("b", "write", {
				path: "xd://mcp__my_db_tools_run_query",
				content: '{"sql":"select 2"}',
			}),
		);
		const [a, b] = calls(events);
		expect(a!.tool?.name).toBe("mcp__my_db_tools__run_query");
		// Still running, but an earlier result told where the server ends.
		expect(b!.tool?.name).toBe("mcp__my_db_tools__run_query");
		expect(b!.tool?.done).toBeUndefined();
		expect(b!.tool?.summary).toStartWith("Called my_db_tools.run_query");
	});

	test("a pending MCP write never reads as a file write", () => {
		const [c] = calls(
			parse(
				call("p", "write", {
					path: "xd://mcp__demo_mail_mark_done",
					content: '{"item":"seven"}',
				}),
			),
		);
		expect(c!.tool?.name).toBe("mcp__demo_mail_mark_done");
		expect(c!.tool?.summary).toBe("Called demo_mail_mark_done · seven");
	});

	test("a failed MCP write before validation keeps the unsplit name", () => {
		const events = parse(
			call("f", "write", {
				path: "xd://mcp__demo_mail_mark_done",
				content: "not json",
			}),
			result(
				"f",
				"expects a JSON args object",
				{ xdev: { tool: "mcp__demo_mail_mark_done", mode: "execute" } },
				true,
			),
		);
		const [c] = calls(events);
		expect(c!.tool).toMatchObject({
			name: "mcp__demo_mail_mark_done",
			input: { content: "not json" },
			isError: true,
		});
	});

	test("other devices become their own tool; docs writes and reads are docs lookups", () => {
		const events = parse(
			call("d1", "write", {
				path: "xd://bash",
				content: '{"command":"ls -la"}',
			}),
			call("d2", "write", { path: "xd://propose", content: "# Plan\nstep" }),
			call("d3", "write", {
				path: "xd://mcp__demo_mail_mark_done",
				content: "?",
			}),
			call("d4", "read", { path: "xd://mcp__demo_mail_mark_done" }),
			call("d5", "read", { path: "xd://eval/dsm" }),
			call("d6", "read", { path: "xd://" }),
		);
		const [bash, propose, help, docs, topic, root] = calls(events);
		expect(bash!.tool).toMatchObject({
			name: "bash",
			input: { command: "ls -la" },
			summary: "Ran `ls -la`",
		});
		expect(propose!.tool).toMatchObject({
			name: "propose",
			input: { content: "# Plan\nstep" },
		});
		expect(help!.tool?.name).toBe("read");
		expect(help!.tool?.summary).toBe("Read docs for demo_mail_mark_done");
		expect(docs!.tool?.summary).toBe("Read docs for demo_mail_mark_done");
		expect(topic!.tool?.summary).toBe("Read docs for eval/dsm");
		expect(root!.tool?.summary).toBe("Read docs for all tools");
	});

	test("ordinary writes and non-xd paths are untouched", () => {
		const [w] = calls(
			parse(call("w", "write", { path: "/work/demo/a.txt", content: "hi\n" })),
		);
		expect(w!.tool).toMatchObject({
			name: "write",
			summary: "Wrote a.txt (1 line)",
		});
	});
});

describe("describeCall: omp MCP names", () => {
	test("canonical names show server.tool; minted names show the tool alone", () => {
		expect(
			callLine(describeCall("mcp__demo-mail__mark_done", { item: "x" })),
		).toBe("Called demo-mail.mark_done · x");
		expect(callLine(describeCall("mcp__demo_mail_mark_done", {}))).toBe(
			"Called demo_mail_mark_done",
		);
	});
});
