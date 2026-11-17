import { describe, expect, test } from "bun:test";
import { matches, parseSelector } from "../src/selector.ts";
import type { PublicAgent } from "../src/types.ts";

function agent(over: Partial<PublicAgent>): PublicAgent {
	return {
		id: "claude:1",
		name: "claude@apparish",
		harness: "claude",
		sessionId: "1",
		pid: 1,
		cwd: "/x/apparish",
		project: "apparish",
		branch: "main",
		tags: ["harness:claude", "project:apparish", "branch:main"],
		status: "idle",
		summary: null,
		inbound: "accept",
		registered: true,
		reach: "push",
		lastSeen: 0,
		createdAt: 0,
		...over,
	};
}

describe("parseSelector", () => {
	test("empty and * mean everyone", () => {
		expect(parseSelector("")).toEqual({ kind: "all" });
		expect(parseSelector(" * ")).toEqual({ kind: "all" });
	});
	test("a bare word is a name", () => {
		expect(parseSelector("@codex@api")).toEqual({
			kind: "name",
			value: "codex@api",
		});
	});
	test("key=value terms", () => {
		expect(parseSelector("project=apparish harness=codex")).toEqual({
			kind: "terms",
			terms: [
				{ key: "project", value: "apparish" },
				{ key: "harness", value: "codex" },
			],
		});
	});
});

describe("matches", () => {
	const a = agent({
		tags: ["harness:claude", "project:apparish", "workstream:auth"],
	});
	test("fields", () => {
		expect(matches(a, parseSelector("project=apparish"))).toBe(true);
		expect(matches(a, parseSelector("project=other"))).toBe(false);
		expect(matches(a, parseSelector("harness=claude status=idle"))).toBe(true);
		expect(matches(a, parseSelector("harness=claude status=busy"))).toBe(false);
	});
	test("unknown keys match self-tags", () => {
		expect(matches(a, parseSelector("workstream=auth"))).toBe(true);
		expect(matches(a, parseSelector("workstream=billing"))).toBe(false);
	});
	test("prefix match and case", () => {
		expect(matches(a, parseSelector("project=APP*"))).toBe(true);
	});
	test("name, id and bare tag", () => {
		expect(matches(a, parseSelector("claude@apparish"))).toBe(true);
		expect(matches(a, parseSelector("claude:1"))).toBe(true);
		expect(
			matches(agent({ tags: ["reviewer"] }), parseSelector("reviewer")),
		).toBe(true);
	});
	test("* matches all", () => {
		expect(matches(a, parseSelector("*"))).toBe(true);
	});
});

describe("doctor version compare", () => {
	test("semver ordering", async () => {
		const { newer } = await import("../src/setup/doctor.ts");
		expect(newer("1.0.1", "1.0.0")).toBe(true);
		expect(newer("0.2.0", "1.0.0")).toBe(false);
		expect(newer("1.0.0", "1.0.0-rc.1")).toBe(true);
		expect(newer("1.0.0-rc.1", "1.0.0")).toBe(false);
		expect(newer("1.0.0", "1.0.0")).toBe(false);
	});
});
