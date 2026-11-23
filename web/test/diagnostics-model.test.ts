/**
 * The Diagnostics page's order and fixes (web/src/features/diagnostics/
 * model.ts): problems before notes before passed checks, and which code
 * spans in a fix are commands to copy.
 */
import { describe, expect, test } from "bun:test";
import type { DiagCheck } from "../src/api/types.ts";
import {
	attention,
	fixParts,
	passed,
} from "../src/features/diagnostics/model.ts";

const c = (level: DiagCheck["level"], text: string): DiagCheck => ({
	group: "mesh",
	level,
	text,
	fix: null,
});

describe("attention and passed", () => {
	const checks = [
		c("ok", "a"),
		c("note", "b"),
		c("bad", "c"),
		c("note", "d"),
		c("bad", "e"),
		c("ok", "f"),
	];
	test("problems first, then notes, each in doctor's order", () => {
		expect(attention(checks).map((x) => x.text)).toEqual(["c", "e", "b", "d"]);
	});
	test("the passed checks, in doctor's order", () => {
		expect(passed(checks).map((x) => x.text)).toEqual(["a", "f"]);
	});
	test("does not reorder the report", () => {
		attention(checks);
		expect(checks.map((x) => x.text).join("")).toBe("abcdef");
	});
});

describe("fixParts", () => {
	test("a code span after run is a command", () => {
		expect(fixParts("run `pulsar mesh on` again")).toEqual([
			{ code: false, command: false, text: "run " },
			{ code: true, command: true, text: "pulsar mesh on" },
			{ code: false, command: false, text: " again" },
		]);
		expect(
			fixParts("re-run `pulsar setup`").filter((p) => p.command),
		).toHaveLength(1);
	});
	test("other code spans and plain fixes have no command", () => {
		expect(
			fixParts("each report is a `client load error` line in daemon.log").some(
				(p) => p.command,
			),
		).toBe(false);
		expect(fixParts("restart the machine")).toEqual([
			{ code: false, command: false, text: "restart the machine" },
		]);
	});
});
