import { describe, expect, test } from "bun:test";
import type { CommandEntry } from "../src/api/types.ts";
import {
	commandLine,
	rankCommands,
	runsInOneTap,
	slashToken,
} from "../src/lib/slash.ts";

const c = (name: string, extra: Partial<CommandEntry> = {}): CommandEntry => ({
	name,
	description: "",
	source: "builtin",
	...extra,
});

describe("slash commands in the composer", () => {
	test("a command line is one line: / and a name, then arguments", () => {
		expect(commandLine(" /compact keep notes ")).toBe("/compact keep notes");
		expect(commandLine("/gh:review 12")).toBe("/gh:review 12");
		expect(commandLine("/etc/hosts is a file")).toBeNull();
		expect(commandLine("/compact\nmore")).toBeNull();
		expect(commandLine("compact")).toBeNull();
		expect(commandLine("/")).toBeNull();
	});

	test("the / token the caret is in", () => {
		expect(slashToken("/comp", 5)).toEqual({ q: "comp", end: 5 });
		expect(slashToken("/comp args", 9)).toBeNull();
		expect(slashToken("hi /comp", 8)).toBeNull();
	});

	test("ranking: prefix, after a plugin prefix, letters in order; dialogs last; recent first", () => {
		const list = [
			c("compact"),
			c("context"),
			c("gh:review", { source: "plugin", skill: true }),
			c("review"),
			c("config", { dialog: true }),
			c("color", { dialog: true, args: "<color>" }),
		];
		expect(rankCommands(list, "rev").map((x) => x.name)).toEqual([
			"review",
			"gh:review",
		]);
		expect(rankCommands(list, "cmp").map((x) => x.name)).toEqual(["compact"]);
		expect(
			rankCommands(list, "co")
				.map((x) => x.name)
				.at(-1),
		).toBe("config");
		expect(rankCommands(list, "", ["review"])[0]!.name).toBe("review");
	});

	test("one tap runs only what keeps the session and needs nothing typed", () => {
		expect(runsInOneTap(c("recap"))).toBe(true);
		for (const n of ["exit", "clear", "restart", "background", "logout"])
			expect(runsInOneTap(c(n))).toBe(false);
		expect(runsInOneTap(c("rename", { args: "<name>" }))).toBe(false);
		expect(runsInOneTap(c("config", { dialog: true }))).toBe(false);
		expect(runsInOneTap(c("tidy", { skill: true }))).toBe(false);
	});
});
