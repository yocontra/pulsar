import { expect, test } from "bun:test";
import { describeCall } from "../src/transcripts/describe.ts";
import {
	ENCRYPTED_MESSAGE,
	messageContent,
	readableToolInput,
	readableToolText,
} from "../src/transcripts/tool-text.ts";

test("encrypted tool fields and JSON results keep their surrounding readable content", () => {
	const sealed = Buffer.concat([Buffer.from([128]), Buffer.alloc(72)]).toString(
		"base64url",
	);
	const input = {
		tasks: [{ name: "runtime_debt", message: sealed }],
		choices: ["literal"],
	};
	expect(readableToolInput(input)).toEqual({
		...input,
		tasks: [{ name: "runtime_debt", message: ENCRYPTED_MESSAGE }],
	});
	expect(JSON.parse(readableToolText(JSON.stringify(input)))).toEqual(
		readableToolInput(input),
	);
	expect(input.tasks[0]?.message).toBe(sealed);
	expect(
		describeCall("spawn_agent", { task_name: "runtime_debt", message: sealed })
			.target?.text,
	).toBe("runtime_debt");
	expect(
		describeCall("spawn_agent", { message: sealed }).target,
	).toBeUndefined();
	expect(
		messageContent(Buffer.from("Review is ready.").toString("base64")).text,
	).toBe("Review is ready.");
	const literal = {
		filename: "settings.json",
		contents: "aGVsbG8=",
		id: "gAAAA123",
	};
	expect(readableToolInput(literal)).toBe(literal);
});
