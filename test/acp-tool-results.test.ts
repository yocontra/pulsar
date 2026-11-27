import { expect, test } from "bun:test";
import { AcpToolResults } from "../src/harnesses/acp-tool-results.ts";

for (const child of [false, true]) {
	test(`ACP ${child ? "child" : "parent"} updates retain the call identity and late file arguments`, () => {
		const tools = new AcpToolResults(1000);
		const first = tools.apply(
			{
				sessionUpdate: "tool_call",
				toolCallId: "read",
				title: "Reading",
				kind: "read",
				name: "read_file",
				locations: [{ path: "a.ts" }],
			},
			"antigravity",
			child,
		);
		const next = tools.apply(
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "read",
				rawInput: { StartLine: 3, EndLine: 6 },
			},
			"antigravity",
			child,
		);
		expect(first[0]?.tool?.input).toEqual({ path: "a.ts" });
		expect(next[0]).toMatchObject({
			id: first[0]?.id,
			tool: { input: { path: "a.ts", offset: 3, limit: 4 } },
		});
		const result = tools.apply(
			{
				sessionUpdate: "tool_call_update",
				toolCallId: "read",
				status: "completed",
			},
			"antigravity",
			child,
		);
		expect(result).toHaveLength(1);
		expect(result[0]?.tool?.name).toBe("read_file");
	});
}

test("ACP execute results carry output and the numeric exit code on a later status update", () => {
	const tools = new AcpToolResults(1000);
	tools.apply(
		{
			sessionUpdate: "tool_call",
			toolCallId: "s",
			kind: "execute",
			title: "Shell",
			name: "run_command",
			rawInput: { CommandLine: "pwd" },
		},
		"antigravity",
	);
	tools.apply(
		{
			sessionUpdate: "tool_call_update",
			toolCallId: "s",
			rawOutput: { output: "permission denied", exit_code: 1 },
		},
		"antigravity",
	);
	expect(
		tools.apply(
			{ sessionUpdate: "tool_call_update", toolCallId: "s", status: "failed" },
			"antigravity",
		),
	).toMatchObject([
		{
			text: "permission denied",
			tool: { detail: { exitCode: 1 }, isError: true },
		},
	]);
});

test("ACP limits retained arguments and keeps another provider's argument spelling", () => {
	const tools = new AcpToolResults(50, 1);
	const large = tools.apply(
		{
			sessionUpdate: "tool_call",
			toolCallId: "a",
			name: "write_file",
			title: "Write",
			rawInput: { Content: "a".repeat(100) },
		},
		"omp",
	);
	expect(large[0]?.tool).toMatchObject({ truncated: true });
	expect(large[0]?.tool?.input).toBeUndefined();
	const small = tools.apply(
		{
			sessionUpdate: "tool_call",
			toolCallId: "b",
			name: "write_file",
			title: "Write",
			rawInput: { Content: "a" },
		},
		"omp",
	);
	expect(small[0]?.tool?.input).toEqual({ Content: "a" });
	expect(tools.has("a")).toBe(false);
});
