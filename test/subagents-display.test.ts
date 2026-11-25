import { describe, expect, test } from "bun:test";
import { cleanCounts } from "../src/federation/subagents.ts";
import type { SubagentRow, SubagentState } from "../src/http/wire.ts";
import {
	orderSubagents,
	setShowInactive,
	showInactive,
	subagentRole,
	subagentStateText,
	subagentsLabel,
	visibleSubagents,
} from "../web/src/lib/subagents.ts";

/**
 * "Show finished subagents" (web/src/lib/subagents.ts): off by default, the
 * sidebar and the phone's agent page list only running subagents,
 * and the disclosure counts what it lists.
 */

const NOW = 1_800_000_000_000;

function row(
	key: string,
	state: SubagentState,
	o: Partial<SubagentRow> = {},
): SubagentRow {
	return {
		id: `claude:p/sub:${key}`,
		parentId: "claude:p",
		name: key,
		harness: "claude",
		kind: "task",
		color: null,
		agentType: null,
		description: null,
		state,
		startedAt: NOW - 60_000,
		updatedAt: NOW - 30_000,
		finishedAt: state === "done" ? NOW - 3 * 60_000 : null,
		callId: null,
		parentSubId: null,
		hasTranscript: true,
		messaging: { mode: "parent", note: "" },
		...o,
	};
}

describe("visibleSubagents", () => {
	const rows = [row("a", "running"), row("b", "done"), row("c", "idle")];

	test("hides idle and finished ones unless shown", () => {
		expect(visibleSubagents(rows, false).map((r) => r.name)).toEqual(["a"]);
		expect(visibleSubagents(rows, true)).toBe(rows);
	});

	test("a running child of a hidden finished one lists at the top level", () => {
		const list = [
			row("parent", "done"),
			row("kid", "running", { parentSubId: "claude:p/sub:parent" }),
		];
		expect(orderSubagents(visibleSubagents(list, false))).toEqual([
			{ sub: list[1]!, level: 0 },
		]);
		expect(
			orderSubagents(visibleSubagents(list, true)).map((x) => x.level),
		).toEqual([0, 1]);
	});
});

describe("subagentsLabel", () => {
	test("shown: every subagent, with the running count", () => {
		expect(subagentsLabel({ total: 4, running: 1, done: 2 }, true)).toBe(
			"4 subagents · 1 running",
		);
		expect(subagentsLabel({ total: 1, running: 0, done: 1 }, true)).toBe(
			"1 subagent",
		);
	});

	test("hidden: counts what is listed", () => {
		expect(subagentsLabel({ total: 5, running: 2, done: 3 }, false)).toBe(
			"2 running subagents",
		);
		expect(subagentsLabel({ total: 2, running: 1, done: 1 }, false)).toBe(
			"1 running subagent",
		);
		expect(subagentsLabel({ total: 3, running: 0, done: 2 }, false)).toBeNull();
		expect(subagentsLabel({ total: 4, running: 1, done: 2 }, false)).toBe(
			"1 running subagent",
		);
	});

	test("nothing to show: no disclosure", () => {
		expect(subagentsLabel({ total: 3, running: 0, done: 3 }, false)).toBeNull();
		expect(subagentsLabel(undefined, true)).toBeNull();
		expect(subagentsLabel({ total: 0, running: 0 }, true)).toBeNull();
	});

	test("counts from an older daemon (no `done`) count running ones only", () => {
		expect(subagentsLabel({ total: 3, running: 1 }, false)).toBe(
			"1 running subagent",
		);
		expect(subagentsLabel({ total: 3, running: 0 }, false)).toBeNull();
		expect(subagentsLabel({ total: 3, running: 0 }, true)).toBe("3 subagents");
	});
});

describe("the setting", () => {
	test("off by default; set and cleared per device", () => {
		expect(showInactive.value).toBe(false);
		setShowInactive(true);
		expect(showInactive.value).toBe(true);
		setShowInactive(false);
		expect(showInactive.value).toBe(false);
	});
});

test("list subtitles show distinct roles only", () => {
	expect(
		subagentRole(row("reviewer", "idle", { agentType: " Reviewer " })),
	).toBeNull();
	expect(
		subagentRole(row("reviewer", "running", { agentType: "Explore" })),
	).toBe("Explore");
});

describe("state words", () => {
	test("finished says when", () => {
		expect(subagentStateText(row("a", "done"), NOW)).toBe("Finished 3m ago");
		expect(subagentStateText(row("a", "idle"), NOW)).toBe("Idle");
		expect(subagentStateText(row("a", "running"), NOW)).toBe("Running");
	});
});

describe("cleanCounts (a peer's counts)", () => {
	test("keeps a bounded `done`, and leaves it absent for older peers", () => {
		expect(cleanCounts({ total: 3, running: 1, done: 2 })).toEqual({
			total: 3,
			running: 1,
			done: 2,
		});
		expect(cleanCounts({ total: 3, running: 1, done: 99 })).toEqual({
			total: 3,
			running: 1,
			done: 2,
		});
		expect(cleanCounts({ total: 3, running: 1 })).toEqual({
			total: 3,
			running: 1,
		});
		expect(cleanCounts({ total: 3, running: 1, done: "x" })).toEqual({
			total: 3,
			running: 1,
			done: 0,
		});
	});
});
