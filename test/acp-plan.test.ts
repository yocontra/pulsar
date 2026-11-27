import { expect, test } from "bun:test";
import { AcpPlans } from "../src/harnesses/acp-plan.ts";
import {
	buildItems,
	mergeHistory,
	mergeLive,
} from "../web/src/session/items.ts";

test("a named plan changes format, clears, and stays cleared across history paging", () => {
	const plans = new AcpPlans();
	const items = {
		sessionUpdate: "plan_update",
		plan: {
			type: "items",
			planId: "work",
			entries: [{ content: "Review", status: "in_progress", priority: "high" }],
		},
	} as const;
	const first = {
		...plans.apply("root", {
			...items,
			plan: { ...items.plan, entries: [...items.plan.entries] },
		})!,
		ts: 1,
	};
	expect(first.checklist).toEqual([
		{ text: "Review", status: "active", priority: "high" },
	]);
	const markdown = {
		...plans.apply("root", {
			sessionUpdate: "plan_update",
			plan: {
				type: "markdown",
				planId: "work",
				content: "# Next",
				path: "/private/file",
			},
		})!,
		ts: 2,
	};
	expect(markdown.id).toBe(first.id);
	expect(markdown.text).toBe("# Next");
	const remove = { sessionUpdate: "plan_removed", planId: "work" } as const;
	const cleared = { ...plans.apply("root", remove)!, ts: 3 };
	expect(plans.apply("root", remove)).toBeNull();
	const live = mergeLive([first], [markdown, cleared]).events;
	expect(buildItems(mergeHistory(live, [first]))).toEqual([]);
	expect(plans.apply("child", remove)?.id).not.toBe(first.id);
});

test("repeated legacy plan reports share one row and stay separate from named plans", () => {
	const plans = new AcpPlans();
	const plan = {
		sessionUpdate: "plan",
		entries: [{ content: "Save", priority: "medium", status: "completed" }],
	} as const;
	const update = { ...plan, entries: [...plan.entries] };
	const row = plans.apply("root", update)!;
	expect(plans.apply("root", update)).toBeNull();
	expect(new AcpPlans().apply("root", update)?.id).toBe(row.id);
	expect(
		plans.apply("root", {
			sessionUpdate: "plan_update",
			plan: { type: "items", planId: "default", entries: update.entries },
		})?.id,
	).not.toBe(row.id);
	expect(
		plans.apply("root", { sessionUpdate: "plan", entries: [] })?.checklist,
	).toEqual([]);
});
