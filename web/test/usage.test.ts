import { describe, expect, test } from "bun:test";
import type { UsageReport, UsageRow } from "../src/api/types.ts";
import {
	buckets,
	byHarness,
	byModel,
	cacheHitRate,
	cacheSavings,
	compact,
	filterRows,
	money,
	percent,
	series,
	totals,
} from "../src/usage/model.ts";

const DAY = 86_400_000;
const FROM = Date.UTC(2026, 10, 13);

function row(p: Partial<UsageRow>): UsageRow {
	return {
		machine: "m1",
		harness: "claude",
		model: "claude-opus-5-5",
		t: FROM,
		input: 0,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
		output: 0,
		records: 1,
		cost: 0,
		...p,
	};
}

const report: UsageReport = {
	period: "7d",
	from: FROM,
	to: FROM + 6 * DAY + 3_600_000,
	bucket: "day",
	rows: [
		row({ input: 1e6, cost: 4 }),
		row({ t: FROM + 2 * DAY, cacheRead: 1e6, cost: 0.2 }),
		row({
			machine: "m2",
			harness: "codex",
			model: "gpt-6",
			input: 500,
			cost: null,
			records: 3,
		}),
	],
	sessions: [
		{ machine: "m1", harness: "claude", count: 2 },
		{ machine: "m2", harness: "codex", count: 1 },
	],
	machines: [
		{ id: "m1", name: "studio", error: null },
		{ id: "m2", name: "mini", error: null },
	],
	prices: [
		{
			model: "claude-opus-5-5",
			input: 4,
			output: 20,
			cacheRead: 0.2,
			cacheWrite5m: 5,
			cacheWrite1h: 8,
			source: "default",
		},
	],
	scannedAt: 1,
	scanning: false,
};

describe("usage model", () => {
	test("totals leave unpriced responses out of the cost and say which", () => {
		const all = { machine: null, harness: null };
		const t = totals(report, report.rows, all);
		expect(t.cost).toBeCloseTo(4.2, 6);
		expect(t.unpricedRecords).toBe(3);
		expect(t.unpricedModels).toEqual(["gpt-6"]);
		expect(t.sessions).toBe(3);
		const codex = { machine: null, harness: "codex" };
		expect(totals(report, filterRows(report.rows, codex), codex).sessions).toBe(
			1,
		);
		const m1 = { machine: "m1", harness: null };
		expect(filterRows(report.rows, m1)).toHaveLength(2);
	});

	test("shares per harness and model follow the metric", () => {
		const cost = byHarness(report.rows, "cost");
		expect(cost[0]!.key).toBe("claude");
		expect(cost[0]!.share).toBe(1);
		const tokens = byModel(report.rows, "tokens");
		expect(tokens.map((g) => g.key)).toEqual(["claude-opus-5-5", "gpt-6"]);
	});

	test("the chart has every bucket, empty ones at zero", () => {
		expect(buckets(report)).toHaveLength(7);
		const s = series(report, report.rows, "cost");
		const claude = s.series.find((x) => x.key === "claude")!;
		expect(claude.points).toEqual([4, 0, 0.2, 0, 0, 0, 0]);
	});

	test("cache numbers", () => {
		expect(cacheSavings(report.rows, report.prices)).toBeCloseTo(3.8, 6);
		expect(
			cacheHitRate({
				input: 1,
				cacheRead: 3,
				cacheWrite5m: 0,
				cacheWrite1h: 0,
				output: 9,
				records: 1,
			}),
		).toBe(0.75);
	});

	test("formatting", () => {
		expect(money(0)).toBe("$0");
		expect(money(0.004)).toBe("<$0.01");
		expect(money(12.345)).toBe("$12.35");
		expect(money(12345.6)).toBe("$12,346");
		expect(compact(950)).toBe("950");
		expect(compact(1500)).toBe("1.5K");
		expect(compact(2_000_000)).toBe("2M");
		expect(compact(326_464_571)).toBe("326M");
		expect(percent(0.004)).toBe("<1%");
		expect(percent(0.5)).toBe("50%");
	});
});
