import { expect, describe as group, test } from "bun:test";
import { describe, sentence } from "../src/builder/describe.ts";
import { parse } from "../src/lib/selector.ts";

const label = (key: string, v: string) =>
	key === "harness" ? ({ claude: "Claude Code", codex: "Codex" }[v] ?? v) : v;
const say = (s: string) => sentence(parse(s).query, label);

group("broadcast audience in words", () => {
	test("everyone, and all agents once anything narrows it", () => {
		expect(say("*")).toBe("everyone");
		expect(say("project=apparish")).toBe("all agents in apparish");
	});

	test("OR within a key, AND across keys, harness as the subject", () => {
		expect(say("machine=studio|desk harness=claude project=apparish")).toBe(
			"Claude Code agents in apparish on studio or desk",
		);
		expect(say("harness=claude|codex|pi")).toBe(
			"Claude Code, Codex or pi agents",
		);
		expect(say("status=busy|idle")).toBe("all agents that are working or idle");
	});

	test("free text, unknown keys and raw terms stay verbatim", () => {
		expect(say("~auth tag=release")).toBe(
			"all agents with tag=release matching “auth”",
		);
		const q = parse("machine=a machine=b").query;
		const { tokens } = describe(q, label);
		// A second term for one key is ANDed by the daemon: shown as written.
		expect(tokens.map((t) => t.value)).toEqual(["a", "machine=b"]);
		expect(tokens[1]!.code).toBe(true);
	});
});
