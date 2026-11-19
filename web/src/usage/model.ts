/**
 * The usage page's numbers, from one `GET /usage` report: filters, totals,
 * per-harness shares, chart series and the Model/Day breakdowns. Pure, so
 * the page and its tests share it.
 */
import { priceFor } from "../../../src/usage/prices.ts";
import type {
	UsagePrice,
	UsageReport,
	UsageRow,
	UsageTokens,
} from "../api/types.ts";

export type Metric = "cost" | "tokens";

export interface Filters {
	/** A machine id, or null for every machine. */
	machine: string | null;
	/** A harness id, or null for every harness. */
	harness: string | null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ZERO: UsageTokens = {
	input: 0,
	cacheRead: 0,
	cacheWrite5m: 0,
	cacheWrite1h: 0,
	output: 0,
	records: 0,
};

/** Every token the models read or wrote. */
export const processed = (t: UsageTokens) =>
	t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h + t.output;

export function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
	return {
		input: a.input + b.input,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
		cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
		output: a.output + b.output,
		records: a.records + b.records,
	};
}

export function filterRows(rows: UsageRow[], f: Filters): UsageRow[] {
	return rows.filter(
		(r) =>
			(!f.machine || r.machine === f.machine) &&
			(!f.harness || r.harness === f.harness),
	);
}

export interface Totals {
	tokens: UsageTokens;
	/** Priced rows only. */
	cost: number;
	/** Model responses with no price (left out of `cost`). */
	unpricedRecords: number;
	unpricedModels: string[];
	sessions: number;
}

export function totals(
	report: UsageReport,
	rows: UsageRow[],
	f: Filters,
): Totals {
	let tokens = ZERO;
	let cost = 0;
	let unpricedRecords = 0;
	const unpriced = new Set<string>();
	for (const r of rows) {
		tokens = addTokens(tokens, r);
		if (r.cost === null) {
			unpricedRecords += r.records;
			unpriced.add(r.model);
		} else cost += r.cost;
	}
	const sessions = report.sessions
		.filter(
			(s) =>
				(!f.machine || s.machine === f.machine) &&
				(!f.harness || s.harness === f.harness),
		)
		.reduce((n, s) => n + s.count, 0);
	return {
		tokens,
		cost,
		unpricedRecords,
		unpricedModels: [...unpriced].sort(),
		sessions,
	};
}

export const value = (m: Metric, cost: number, t: UsageTokens) =>
	m === "cost" ? cost : processed(t);

export interface Group {
	key: string;
	tokens: UsageTokens;
	cost: number;
	/** Share of the whole for the metric (0..1). */
	share: number;
}

function groupBy(
	rows: UsageRow[],
	key: (r: UsageRow) => string,
	metric: Metric,
): Group[] {
	const m = new Map<string, { tokens: UsageTokens; cost: number }>();
	for (const r of rows) {
		const k = key(r);
		const g = m.get(k) ?? { tokens: ZERO, cost: 0 };
		m.set(k, { tokens: addTokens(g.tokens, r), cost: g.cost + (r.cost ?? 0) });
	}
	const all = [...m.values()].reduce(
		(n, g) => n + value(metric, g.cost, g.tokens),
		0,
	);
	return [...m]
		.map(([k, g]) => ({
			key: k,
			...g,
			share: all > 0 ? value(metric, g.cost, g.tokens) / all : 0,
		}))
		.sort(
			(a, b) =>
				value(metric, b.cost, b.tokens) - value(metric, a.cost, a.tokens) ||
				a.key.localeCompare(b.key),
		);
}

export const byHarness = (rows: UsageRow[], metric: Metric) =>
	groupBy(rows, (r) => r.harness, metric);
export const byModel = (rows: UsageRow[], metric: Metric) =>
	groupBy(rows, (r) => r.model, metric);

/** One bucket per hour (24h) or local day, oldest first, with nothing missing. */
export function buckets(report: UsageReport): number[] {
	const step = report.bucket === "hour" ? HOUR : DAY;
	const out: number[] = [];
	for (let t = report.from; t <= report.to && out.length < 400; t += step)
		out.push(t);
	return out;
}

export interface Series {
	key: string;
	points: number[];
}

/** The chart: one series per `key(row)` over every bucket. */
export function series(
	report: UsageReport,
	rows: UsageRow[],
	metric: Metric,
	key: (r: UsageRow) => string = (r) => r.harness,
): { buckets: number[]; series: Series[] } {
	const bs = buckets(report);
	const index = new Map(bs.map((t, i) => [t, i]));
	const m = new Map<string, number[]>();
	for (const r of rows) {
		const i = index.get(r.t);
		if (i === undefined) continue;
		const k = key(r);
		let pts = m.get(k);
		if (!pts) {
			pts = bs.map(() => 0);
			m.set(k, pts);
		}
		pts[i]! += metric === "cost" ? (r.cost ?? 0) : processed(r);
	}
	const list = [...m].map(([k, points]) => ({ key: k, points }));
	list.sort(
		(a, b) =>
			b.points.reduce((x, y) => x + y, 0) - a.points.reduce((x, y) => x + y, 0),
	);
	return { buckets: bs, series: list };
}

/** Rows per bucket, newest first (the Day breakdown). */
export function byBucket(rows: UsageRow[], metric: Metric) {
	return groupBy(rows, (r) => String(r.t), metric).sort(
		(a, b) => Number(b.key) - Number(a.key),
	);
}

function priceTableOf(prices: UsagePrice[]) {
	return new Map(prices.map((p) => [p.model, p]));
}

export function priceOf(model: string, prices: UsagePrice[]) {
	return priceFor(model, priceTableOf(prices)) as UsagePrice | null;
}

/** Cost by token kind (priced rows), for the share bar. */
export function costByType(rows: UsageRow[], prices: UsagePrice[]) {
	const table = priceTableOf(prices);
	const out = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
	for (const r of rows) {
		const p = priceFor(r.model, table);
		if (!p) continue;
		out.input += (r.input * p.input) / 1e6;
		out.cacheRead += (r.cacheRead * p.cacheRead) / 1e6;
		out.cacheWrite +=
			(r.cacheWrite5m * p.cacheWrite5m + r.cacheWrite1h * p.cacheWrite1h) / 1e6;
		out.output += (r.output * p.output) / 1e6;
	}
	return out;
}

/** What cache reads saved against paying full input price for them. */
export function cacheSavings(rows: UsageRow[], prices: UsagePrice[]) {
	const table = priceTableOf(prices);
	let saved = 0;
	for (const r of rows) {
		const p = priceFor(r.model, table);
		if (p) saved += (r.cacheRead * (p.input - p.cacheRead)) / 1e6;
	}
	return Math.max(0, saved);
}

/** Cached share of all input (0..1). */
export function cacheHitRate(t: UsageTokens) {
	const input = t.input + t.cacheRead + t.cacheWrite5m + t.cacheWrite1h;
	return input > 0 ? t.cacheRead / input : 0;
}

// --- Formatting ---

export function money(n: number): string {
	if (n === 0) return "$0";
	if (n < 0.01) return "<$0.01";
	if (n < 1000) return `$${n.toFixed(2)}`;
	return `$${Math.round(n).toLocaleString("en-US")}`;
}

export function compact(n: number): string {
	if (n < 1000) return String(Math.round(n));
	const units: [number, string][] = [
		[1e12, "T"],
		[1e9, "B"],
		[1e6, "M"],
		[1e3, "K"],
	];
	for (const [d, u] of units)
		if (n >= d) {
			const v = n / d;
			return `${v >= 100 ? Math.round(v) : v.toFixed(1).replace(/\.0$/, "")}${u}`;
		}
	return String(n);
}

export const percent = (x: number) =>
	`${x > 0 && x < 0.01 ? "<1" : Math.round(x * 100)}%`;

export function bucketLabel(t: number, bucket: "hour" | "day"): string {
	const d = new Date(t);
	return bucket === "hour"
		? d.toLocaleTimeString(undefined, { hour: "numeric" })
		: d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Minutes east of UTC, as `GET /usage?tz=` takes it. */
export const localTz = () => -new Date().getTimezoneOffset();
