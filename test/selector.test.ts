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
		model: null,
		activity: null,
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
		const { newer } = await import("../src/util.ts");
		expect(newer("1.0.1", "1.0.0")).toBe(true);
		expect(newer("0.2.0", "1.0.0")).toBe(false);
		expect(newer("1.0.0", "1.0.0-rc.1")).toBe(true);
		expect(newer("1.0.0-rc.1", "1.0.0")).toBe(false);
		expect(newer("1.0.0", "1.0.0")).toBe(false);
	});
});

describe("release metadata", () => {
	test("plugin, marketplace and server.json versions match package.json", async () => {
		const { readFileSync } = await import("node:fs");
		const read = (p: string) =>
			JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url), "utf8"));
		const version = read("package.json").version;
		expect(read(".claude-plugin/plugin.json").version).toBe(version);
		expect(read(".claude-plugin/marketplace.json").plugins[0].version).toBe(
			version,
		);
		expect(read("server.json").version).toBe(version);
		expect(read("server.json").packages[0].version).toBe(version);
	});
});

describe("finding agents by model, PR, issue and activity", () => {
	const author = agent({
		name: "codex@apparish",
		model: "gpt-5.5",
		branch: "fix-1378",
		activity: "fixing issue #1378",
		tags: [
			"harness:codex",
			"project:apparish",
			"branch:fix-1378",
			"pr:1402",
			"role:author",
			"issue:1378",
			"model:gpt-5.5",
		],
	});
	const reviewer = agent({
		name: "reviewer-7",
		model: "claude-fable-5-2",
		activity: "reviewing PR #1402",
		tags: [
			"harness:claude",
			"project:apparish",
			"pr:1402",
			"role:reviewer",
			"model:claude-fable-5-2",
		],
	});
	const pick = (sel: string) =>
		[author, reviewer]
			.filter((a) => matches(a, parseSelector(sel)))
			.map((a) => a.name);

	test("model=fable finds every Fable agent", () => {
		expect(pick("model=fable")).toEqual(["reviewer-7"]);
		expect(pick("model=gpt-5*")).toEqual(["codex@apparish"]);
	});
	test("message your reviewer / message the PR author", () => {
		expect(pick("pr=1402 role=reviewer")).toEqual(["reviewer-7"]);
		expect(pick("pr=1402 role=author")).toEqual(["codex@apparish"]);
		expect(pick("branch=fix-1378")).toEqual(["codex@apparish"]);
	});
	test("~text and #number match anywhere", () => {
		expect(pick("~1402")).toEqual(["codex@apparish", "reviewer-7"]);
		expect(pick("#1378")).toEqual(["codex@apparish"]);
		expect(pick("activity=reviewing")).toEqual(["reviewer-7"]);
		expect(pick("~fable")).toEqual(["reviewer-7"]);
	});
});
