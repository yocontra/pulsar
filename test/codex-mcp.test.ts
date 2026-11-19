import { describe, expect, test } from "bun:test";
import { parseCodex } from "../src/harnesses/codex-transcript.ts";
import { newParseState } from "../src/transcripts/types.ts";

/** A rollout line: Codex records MCP calls only as `item_completed` events. */
const mcpItem = (item: object, ts = "2026-11-18T05:38:16.130Z") =>
	JSON.stringify({
		timestamp: ts,
		type: "event_msg",
		payload: {
			type: "item_completed",
			thread_id: "t1",
			turn_id: "u1",
			item: { type: "McpToolCall", ...item },
		},
	});

const parse = (...lines: string[]) =>
	parseCodex(lines.join("\n"), newParseState({ atStart: false }));

describe("Codex MCP tool calls", () => {
	test("an McpToolCall item becomes a call and its result", () => {
		const evs = parse(
			mcpItem({
				id: "exec-1",
				server: "pulsar",
				tool: "set_identity",
				arguments: { activity: "Reviewing", tags_add: ["pr:12"] },
				status: "completed",
				result: {
					content: [{ type: "text", text: "You are codex@demo (codex:1)" }],
				},
			}),
		);
		expect(evs.map((e) => e.kind)).toEqual(["tool_call", "tool_result"]);
		expect(evs[0]!.tool).toMatchObject({
			name: "mcp__pulsar__set_identity",
			callId: "exec-1",
			input: { activity: "Reviewing", tags_add: ["pr:12"] },
		});
		expect(evs[1]!.text).toBe("You are codex@demo (codex:1)");
		expect(evs[1]!.tool?.isError).toBeFalsy();
	});

	test("JSON-string arguments are parsed", () => {
		const [call] = parse(
			mcpItem({
				id: "exec-2",
				server: "linear",
				tool: "create_issue",
				arguments: '{"title":"x"}',
				status: "completed",
				result: { content: [] },
			}),
		);
		expect(call!.tool?.input).toEqual({ title: "x" });
	});

	test("status failed is an error, with the error text", () => {
		const evs = parse(
			mcpItem({
				id: "exec-3",
				server: "pulsar",
				tool: "send",
				arguments: { to: "ghost", body: "hi" },
				status: "failed",
				error: "tool call timed out",
			}),
		);
		expect(evs[1]!.tool?.isError).toBe(true);
		expect(evs[1]!.text).toBe("tool call timed out");
		const e2 = parse(
			mcpItem({
				id: "exec-4",
				server: "pulsar",
				tool: "send",
				arguments: {},
				status: "completed",
				result: {
					content: [{ type: "text", text: "pulsar: no agent" }],
					isError: true,
				},
			}),
		);
		expect(e2[1]!.tool?.isError).toBe(true);
	});

	test("the same call as a response_item too is shown once", () => {
		const fn = JSON.stringify({
			timestamp: "2026-11-18T05:38:15.000Z",
			type: "response_item",
			payload: {
				type: "function_call",
				name: "mcp__pulsar__wait",
				call_id: "exec-5",
				arguments: "{}",
			},
		});
		const out = JSON.stringify({
			timestamp: "2026-11-18T05:38:17.000Z",
			type: "response_item",
			payload: {
				type: "function_call_output",
				call_id: "exec-5",
				output: "Nothing happened within 60s.",
			},
		});
		const item = mcpItem({
			id: "exec-5",
			server: "pulsar",
			tool: "wait",
			arguments: {},
			status: "completed",
			result: {
				content: [{ type: "text", text: "Nothing happened within 60s." }],
			},
		});
		for (const order of [
			[fn, item, out],
			[item, fn, out],
			[fn, out, item],
		]) {
			const evs = parse(...order);
			// A call re-sent with its result folded in keeps its id (it replaces).
			const calls = new Set(
				evs.filter((e) => e.kind === "tool_call").map((e) => e.id),
			);
			expect(calls.size).toBe(1);
			expect(evs.filter((e) => e.kind === "tool_result")).toHaveLength(1);
		}
	});

	test("other item types are ignored", () => {
		expect(
			parse(
				JSON.stringify({
					timestamp: "2026-11-18T05:38:16.130Z",
					type: "event_msg",
					payload: {
						type: "item_completed",
						item: { type: "AgentMessage", id: "a" },
					},
				}),
			),
		).toEqual([]);
	});
});
