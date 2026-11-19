/**
 * Mock token usage (`GET /usage`, `GET /agents/:id/usage`, `PUT /usage/prices`):
 * steady made-up tokens for a few machines, priced with the daemon's own
 * price code, so the page's numbers behave like the real ones.
 */
import type {
	AgentUsage,
	UsagePeriod,
	UsagePrice,
	UsageReport,
	UsageRow,
} from "../../src/http/wire.ts";
import { range } from "../../src/usage/index.ts";
import {
	costOf,
	normalizeModel,
	PRICE_FIELDS,
	type Price,
	priceFor,
	priceTable,
} from "../../src/usage/prices.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Who uses what: machine, harness, model and a daily scale. */
const SOURCES = [
	{ machine: "studio", harness: "claude", model: "claude-opus-5-5", scale: 9 },
	{ machine: "studio", harness: "codex", model: "gpt-6.2-sol", scale: 5 },
	{ machine: "mbp-a", harness: "claude", model: "claude-sonnet-5-5", scale: 4 },
	{ machine: "desk", harness: "pi", model: "claude-haiku-5-5", scale: 2 },
];
/** Machines asked; mbp-b is asleep, as in the mock pool. */
const MACHINES = [
	{ id: "studio", name: "studio", error: null },
	{ id: "mbp-a", name: "mbp-a", error: null },
	{ id: "mbp-b", name: "mbp-b", error: "mbp-b is asleep" },
	{ id: "desk", name: "desk", error: null },
];

let custom: Record<string, Price> = {};
let empty = false;

/** Test isolation (`POST /__mock/usage`): no usage at all, or back to defaults. */
export function mockUsage(o: { empty?: boolean; reset?: boolean }) {
	if (o.reset) {
		custom = {};
		empty = false;
	}
	if (typeof o.empty === "boolean") empty = o.empty;
	return { ok: true };
}

/** A repeatable wave: busier on weekdays and in working hours. */
function amount(seed: number, t: number, hourly: boolean) {
	const d = new Date(t);
	const day = d.getUTCDay();
	const weekday = day === 0 || day === 6 ? 0.4 : 1;
	const wave = 0.6 + 0.4 * Math.sin(t / DAY + seed);
	if (!hourly) return weekday * wave;
	const h = d.getUTCHours();
	return (weekday * wave * (h >= 14 && h <= 23 ? 1 : 0.15)) / 10;
}

export function prices(): UsagePrice[] {
	return [...priceTable(custom)]
		.map(([model, p]) => ({
			model,
			...p,
			source: (custom[model] ? "custom" : "default") as UsagePrice["source"],
		}))
		.sort((a, b) => a.model.localeCompare(b.model));
}

export function setPrice(model: string, price: Partial<Price> | null) {
	const key = normalizeModel(model);
	if (price === null) delete custom[key];
	else {
		const p = {} as Price;
		for (const f of PRICE_FIELDS) {
			const v = price[f];
			if (typeof v !== "number" || !(v >= 0 && v <= 10_000))
				throw new Error(`${f}: dollars per million tokens, 0 to 10000`);
			p[f] = v;
		}
		custom[key] = p;
	}
	return { prices: prices() };
}

export function usageReport(
	period: UsagePeriod,
	tz: number,
	now = Date.now(),
): UsageReport {
	const { from, bucket } = range(period, now, tz);
	const step = bucket === "hour" ? HOUR : DAY;
	const table = priceTable(custom);
	const rows: UsageRow[] = [];
	if (!empty)
		for (const [i, s] of SOURCES.entries())
			for (let t = from; t <= now; t += step) {
				const k = amount(i, t, bucket === "hour") * s.scale;
				if (k <= 0.01) continue;
				const tokens = {
					input: Math.round(k * 40_000),
					cacheRead: Math.round(k * 9_000_000),
					cacheWrite5m: Math.round(k * 300_000),
					cacheWrite1h: Math.round(k * 60_000),
					output: Math.round(k * 120_000),
					records: Math.max(1, Math.round(k * 300)),
				};
				const p = priceFor(s.model, table);
				rows.push({
					machine: s.machine,
					harness: s.harness,
					model: s.model,
					t,
					...tokens,
					cost: p ? costOf(tokens, p) : null,
				});
			}
	return {
		period,
		from,
		to: now,
		bucket,
		rows,
		sessions: empty
			? []
			: SOURCES.map((s, i) => ({
					machine: s.machine,
					harness: s.harness,
					count: 3 + i * 2,
				})),
		machines: MACHINES,
		prices: prices(),
		scannedAt: now - 20_000,
		scanning: false,
	};
}

/** One agent's session: Codex agents report a context window. */
export function agentUsage(a: {
	id: string;
	harness: string;
	model: string | null;
}): AgentUsage {
	const n = [...a.id].reduce((x, c) => x + c.charCodeAt(0), 0);
	const tokens = {
		input: 2_000 + (n % 50) * 100,
		cacheRead: 400_000 + (n % 90) * 20_000,
		cacheWrite5m: 30_000,
		cacheWrite1h: 0,
		output: 8_000 + (n % 30) * 500,
		records: 20 + (n % 40),
	};
	const model = a.model ?? "claude-opus-5-5";
	const p = priceFor(model, priceTable(custom));
	const codex = a.harness.includes("codex");
	return {
		agent: a.id,
		tokens,
		cost: p ? costOf(tokens, p) : null,
		context: codex
			? { used: 120_000 + (n % 200) * 1000, window: 400_000 }
			: { used: 90_000, window: null },
		model,
	};
}
