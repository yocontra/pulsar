import { expect, test } from "bun:test";
import { fields } from "../src/harnesses/antigravity-proto.ts";
import { antigravityStepEvents } from "../src/harnesses/antigravity-steps.ts";
import { TOOL_OUTPUT_CAP } from "../src/transcripts/types.ts";

function varint(value: number): number[] {
	return value < 128
		? [value]
		: [(value & 127) | 128, ...varint(Math.floor(value / 128))];
}
function field(id: number, content: string | number[]): number[] {
	const bytes =
		typeof content === "string" ? [...Buffer.from(content)] : content;
	return [...varint(id * 8 + 2), ...varint(bytes.length), ...bytes];
}
const base = { id: "session#4", ts: 123 };
function read(type: number, bytes: number[]) {
	return antigravityStepEvents(type, fields(Uint8Array.from(bytes)), base);
}
function descriptor(id: string, name: string, input: unknown) {
	return [
		...field(1, id),
		...field(2, name),
		...field(3, JSON.stringify(input)),
		...field(7, [255]),
	];
}

test("native Antigravity pairs every parallel call with the corresponding result and caps output", () => {
	const one = descriptor("a", "run_command", { CommandLine: "pwd" });
	const two = descriptor("b", "read_file", { Path: "a.txt" });
	const calls = read(15, field(20, [...field(7, one), ...field(7, two)]));
	expect(calls.map((e) => e.tool)).toMatchObject([
		{ callId: "a", name: "run_command", input: { command: "pwd" } },
		{ callId: "b", name: "read_file", input: { path: "a.txt" } },
	]);
	expect(new Set(calls.map((e) => e.id)).size).toBe(2);
	const [result] = read(132, [
		32,
		3,
		...field(5, field(4, two)),
		...field(
			140,
			field(2, [
				...field(1, "x".repeat(5000)),
				...field(7, "private diagnostics"),
			]),
		),
	]);
	expect(result).toMatchObject({
		kind: "tool_result",
		tool: { name: "read_file", callId: "b", truncated: true },
	});
	expect(result?.text).toBe("x".repeat(TOOL_OUTPUT_CAP));
	const [failed] = read(132, [
		32,
		7,
		...field(5, field(4, one)),
		...field(31, field(2, "file does not exist")),
	]);
	expect(failed).toMatchObject({
		text: "file does not exist",
		tool: { callId: "a", isError: true },
	});
	for (const status of [6, 12]) {
		expect(read(132, [32, status, ...field(5, field(4, one))])).toMatchObject([
			{
				kind: "tool_result",
				tool: { callId: "a", detail: { interrupted: true } },
			},
		]);
	}
	expect(read(132, [32, 1, ...field(5, field(4, one))])).toEqual([]);
});

test("native Antigravity shows task notifications and user-facing errors and skips internal reminders", () => {
	const notification = (kind: string) =>
		field(114, [
			...field(1, "internal envelope"),
			...field(3, kind),
			...field(4, field(4, "Review complete")),
		]);
	expect(read(101, notification("task_notification"))).toMatchObject([
		{ kind: "system", subtype: "task", text: "Review complete" },
	]);
	expect(read(101, notification("work_efficiently_reminder"))).toEqual([]);
	expect(
		read(
			17,
			field(
				24,
				field(3, [
					...field(1, "Quota reached"),
					...field(3, "private diagnostics"),
				]),
			),
		),
	).toMatchObject([{ text: "Quota reached" }]);
});
