/**
 * Plan usage limits, as the harnesses write them in their session files.
 *
 * - Codex: every `token_count` event carries `rate_limits` with each
 *   window's `used_percent`, length and reset time. The only harness that
 *   reports a percentage.
 * - Claude Code: only the hard stop. When the plan's limit is reached it
 *   writes a placeholder assistant line with `apiError: "usage_limit_reached"`
 *   and `quotaLimits` (`status: "rejected"`, `resetsAt`, `rateLimitType`).
 * - pi and omp: only the hard stop, as an assistant error with status 429,
 *   "usage limit" in the message and `retry-after-ms`. The message text
 *   (it can hold an account URL) is never kept.
 *
 * Each node keeps the latest reading per harness, account and window in
 * `meta` (written with the scanner's offsets), shows them on the Usage
 * page, and warns once per window per threshold (`check`).
 */
import type { LimitSettings, LimitState, LimitWarning } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { UsageHarness } from "./parse.ts";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const fin = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

function time(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Pre-filter markers: a line without one has no limit reading. */
export const LIMIT_MARKERS: Record<UsageHarness, string[]> = {
	claude: ['"usage_limit_reached"', '"quotaLimits"'],
	codex: ['"rate_limits"'],
	pi: ['"errorStatus":429'],
	omp: ['"errorStatus":429'],
};

/** "Weekly", "5-hour": a window's name from its length in minutes. */
export function windowLabel(minutes: number | null): string {
	if (!minutes) return "Usage";
	if (minutes === 7 * 24 * 60) return "Weekly";
	if (minutes === 24 * 60) return "Daily";
	if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
	if (minutes % 60 === 0) return `${minutes / 60}-hour`;
	return `${minutes}-minute`;
}

/** Claude Code's `rateLimitType` ("five_hour", "seven_day_opus", …). */
function claudeWindow(type: string): { minutes: number | null; label: string } {
	const base: Record<string, number> = {
		five_hour: 300,
		seven_day: 7 * 24 * 60,
	};
	for (const [k, minutes] of Object.entries(base)) {
		if (type === k) return { minutes, label: windowLabel(minutes) };
		if (type.startsWith(`${k}_`)) {
			const rest = type.slice(k.length + 1).replace(/_/g, " ");
			return { minutes, label: `${windowLabel(minutes)} (${rest})` };
		}
	}
	return { minutes: null, label: type.replace(/_/g, " ") || "Usage" };
}

/**
 * The limit readings in one parsed session line (empty for most lines).
 * `line` is the raw text, for the cheap marker check.
 */
export function limitsOf(
	harness: UsageHarness,
	d: Json,
	line?: string,
): LimitState[] {
	if (
		line !== undefined &&
		!LIMIT_MARKERS[harness].some((m) => line.includes(m))
	)
		return [];
	switch (harness) {
		case "codex":
			return codexLimits(d);
		case "claude":
			return claudeLimit(d);
		default:
			return piLimit(harness, d);
	}
}

function codexLimits(d: Json): LimitState[] {
	const p = obj(d.payload);
	const rl = obj(p?.rate_limits);
	const at = time(d.timestamp);
	if (p?.type !== "token_count" || !rl || at === null) return [];
	const account = str(rl.limit_id) ?? "codex";
	const plan = str(rl.plan_type);
	const reachedType = str(rl.rate_limit_reached_type);
	const out: LimitState[] = [];
	for (const slot of ["primary", "secondary"] as const) {
		const w = obj(rl[slot]);
		const used = fin(w?.used_percent);
		if (!w || used === null) continue;
		const minutes = fin(w.window_minutes);
		const resetsAt = fin(w.resets_at);
		// Older builds sent seconds until the reset instead.
		const resetsIn = fin(w.resets_in_seconds);
		const pct = Math.max(0, Math.min(100, used));
		out.push({
			harness: "codex",
			account,
			window: minutes ? `m${Math.round(minutes)}` : slot,
			label: windowLabel(minutes ? Math.round(minutes) : null),
			usedPercent: pct,
			reached: pct >= 100,
			resetsAt:
				resetsAt !== null
					? resetsAt * 1000
					: resetsIn !== null
						? at + resetsIn * 1000
						: null,
			at,
			plan,
		});
	}
	// Codex names which limit stopped it; the fullest window is that one.
	if (reachedType && out.length) {
		const top = out.reduce((a, b) =>
			(b.usedPercent ?? 0) > (a.usedPercent ?? 0) ? b : a,
		);
		top.reached = true;
		top.usedPercent = 100;
	}
	return out;
}

function claudeLimit(d: Json): LimitState[] {
	const q =
		obj(d.quotaLimits) ?? obj(obj(d.apiErrorParams)?.rate_limit_info) ?? null;
	const at = time(d.timestamp);
	// A plain 429 (busy servers) is not the plan's limit: it needs the reason.
	if (
		at === null ||
		!(d.apiError === "usage_limit_reached" || q?.status === "rejected")
	)
		return [];
	const type = str(q?.rateLimitType) ?? "";
	const { label } = claudeWindow(type);
	const resets = fin(q?.resetsAt);
	return [
		{
			harness: "claude",
			account: "",
			window: type || "usage",
			label,
			usedPercent: 100,
			reached: true,
			resetsAt: resets !== null ? resets * 1000 : null,
			at,
			plan: null,
		},
	];
}

function piLimit(harness: UsageHarness, d: Json): LimitState[] {
	if (d.type !== "message") return [];
	const m = obj(d.message);
	if (m?.role !== "assistant" || m.errorStatus !== 429) return [];
	const msg = str(m.errorMessage) ?? "";
	if (!/usage limit/i.test(msg)) return [];
	const at = time(m.completedAt) ?? time(d.timestamp) ?? time(m.timestamp);
	if (at === null) return [];
	const retry = /retry-after-ms=(\d+)/.exec(msg);
	const period = /\((daily|weekly|monthly|hourly)\b/i.exec(msg)?.[1];
	const window = period ? period.toLowerCase() : "usage";
	return [
		{
			harness,
			account: str(m.provider) ?? "",
			window,
			label: period ? period[0]!.toUpperCase() + window.slice(1) : "Usage",
			usedPercent: 100,
			reached: true,
			resetsAt: retry ? at + Number(retry[1]) : null,
			at,
			plan: null,
		},
	];
}

/** Harness, account and window: one tracked limit. */
export const limitKey = (
	s: Pick<LimitState, "harness" | "account" | "window">,
) => `${s.harness}\0${s.account}\0${s.window}`;

/** Keeps the newer reading of each limit in `into`. */
export function mergeLimits(
	into: Map<string, LimitState>,
	states: Iterable<LimitState>,
) {
	for (const s of states) {
		const k = limitKey(s);
		const prev = into.get(k);
		if (!prev || s.at >= prev.at) into.set(k, s);
	}
}

/** A reading without a reset time is shown this long. */
const NO_RESET_MS = DAY;
/** Only a reading this recent warns (old session files replay on a new database). */
const WARN_RECENT_MS = 6 * HOUR;
/** Codex's reset time moves by a second between events: same window within this. */
const SAME_WINDOW_MS = 30 * MIN;

/** Still current: its window has not reset. */
export function current(s: LimitState, now: number): boolean {
	return s.resetsAt !== null ? s.resetsAt > now : now - s.at < NO_RESET_MS;
}

/** A peer's limit readings, checked (never trust a frame's shape). */
export function cleanLimits(v: unknown): LimitState[] {
	if (!Array.isArray(v)) return [];
	const text = (x: unknown, max: number) => String(x ?? "").slice(0, max);
	const out: LimitState[] = [];
	for (const r of v.slice(0, 50)) {
		const o = obj(r);
		const at = fin(o?.at);
		if (!o || at === null) continue;
		const used = fin(o.usedPercent);
		const resetsAt = fin(o.resetsAt);
		out.push({
			harness: text(o.harness, 40),
			account: text(o.account, 80),
			window: text(o.window, 60),
			label: text(o.label, 60),
			usedPercent: used === null ? null : Math.max(0, Math.min(100, used)),
			reached: o.reached === true,
			resetsAt,
			at,
			plan: typeof o.plan === "string" ? text(o.plan, 40) : null,
		});
	}
	return out;
}

const STATE_KEY = "usage.limits";
const SETTINGS_KEY = "usage.limitSettings";
const WARNED_KEY = "usage.limitWarned";
const ANSWERED_KEY = "usage.limitAnswered";

export const DEFAULT_LIMIT_SETTINGS: LimitSettings = {
	enabled: true,
	thresholds: [80, 95],
};

/** What has been warned about: the level reached in one window. */
interface Warned {
	base: string;
	resetsAt: number | null;
	/** Highest threshold warned (101: the hard limit). */
	level: number;
	at: number;
}

/** Harness and account of a model answer (`saveLimits`' `answered`). */
export const answeredKey = (harness: string, account: string) =>
	`${harness}\0${account}`;

/**
 * Saves a commit's readings and the newest model answer per harness and
 * account (call inside the scanner's transaction). A hard stop is a moment,
 * not a state: an answer after it means the agent works again (extra
 * usage, another model), so it no longer shows as reached.
 */
export function saveLimits(
	store: Store,
	states: Iterable<LimitState>,
	answered: Map<string, number> = new Map(),
) {
	const all = new Map<string, LimitState>();
	mergeLimits(all, readStates(store));
	let changed = false;
	for (const s of states) {
		const prev = all.get(limitKey(s));
		if (!prev || s.at >= prev.at) {
			all.set(limitKey(s), s);
			changed = true;
		}
	}
	if (changed) store.metaSet(STATE_KEY, JSON.stringify([...all.values()]));
	if (!answered.size) return;
	const ok = readAnswered(store);
	let moved = false;
	for (const [k, t] of answered)
		if (t > (ok[k] ?? 0)) {
			ok[k] = t;
			moved = true;
		}
	if (moved) store.metaSet(ANSWERED_KEY, JSON.stringify(ok));
}

function readAnswered(store: Store): Record<string, number> {
	try {
		const v = obj(JSON.parse(store.metaGet(ANSWERED_KEY) ?? "{}"));
		const out: Record<string, number> = {};
		for (const [k, t] of Object.entries(v ?? {}))
			if (typeof t === "number" && Number.isFinite(t)) out[k] = t;
		return out;
	} catch {
		return {};
	}
}

function readStates(store: Store): LimitState[] {
	try {
		return cleanLimits(JSON.parse(store.metaGet(STATE_KEY) ?? "[]"));
	} catch {
		return [];
	}
}

/**
 * This node's limits and warnings: readings from the scanner, the
 * operator's thresholds, and which warnings were sent (all in `meta`, so a
 * restart does not warn again).
 */
export class Limits {
	private readonly store: Store;

	constructor(store: Store) {
		this.store = store;
	}

	/**
	 * This machine's current readings, newest first. A hard stop the harness
	 * answered after (for its account) is over.
	 */
	local(now = Date.now()): LimitState[] {
		const ok = readAnswered(this.store);
		return readStates(this.store)
			.filter(
				(s) =>
					current(s, now) &&
					!(
						s.reached &&
						s.harness !== "codex" &&
						(ok[answeredKey(s.harness, s.account)] ?? 0) > s.at
					),
			)
			.sort((a, b) => b.at - a.at);
	}

	/** Current readings of one harness (the session header). */
	forHarness(harness: string, now = Date.now()): LimitState[] {
		return this.local(now).filter((s) => s.harness === harness);
	}

	settings(): LimitSettings {
		try {
			const v = obj(JSON.parse(this.store.metaGet(SETTINGS_KEY) ?? "null"));
			if (!v) return DEFAULT_LIMIT_SETTINGS;
			return {
				enabled: v.enabled !== false,
				thresholds:
					cleanThresholds(v.thresholds) ?? DEFAULT_LIMIT_SETTINGS.thresholds,
			};
		} catch {
			return DEFAULT_LIMIT_SETTINGS;
		}
	}

	setSettings(change: Partial<LimitSettings>): LimitSettings {
		const next = { ...this.settings() };
		if (change.enabled !== undefined) next.enabled = change.enabled === true;
		if (change.thresholds !== undefined) {
			const t = cleanThresholds(change.thresholds);
			if (!t)
				throw new RpcError(
					"bad_request",
					"thresholds: 1 to 3 whole percents from 1 to 99",
				);
			next.thresholds = t;
		}
		this.store.metaSet(SETTINGS_KEY, JSON.stringify(next));
		return next;
	}

	private warned(): Warned[] {
		try {
			const v = JSON.parse(this.store.metaGet(WARNED_KEY) ?? "[]");
			return Array.isArray(v) ? (v as Warned[]) : [];
		} catch {
			return [];
		}
	}

	/**
	 * Warnings due for these readings (this machine's and the peers'):
	 * a limit that passed a threshold or was reached, once per window per
	 * level. A jump past two thresholds is one warning; lowering a
	 * threshold does not repeat one. A new window (another reset time)
	 * starts over. The same account on two machines has the same window, so
	 * it warns once.
	 */
	check(states: LimitState[], now = Date.now()): LimitWarning[] {
		const settings = this.settings();
		const saved = this.warned();
		const warned = saved.filter((w) =>
			w.resetsAt !== null ? w.resetsAt > now : now - w.at < NO_RESET_MS,
		);
		const out: LimitWarning[] = [];
		if (settings.enabled)
			for (const s of [...states].sort((a, b) => b.at - a.at)) {
				if (!current(s, now) || now - s.at > WARN_RECENT_MS) continue;
				const level = s.reached
					? 101
					: Math.max(
							0,
							...settings.thresholds.filter((t) => (s.usedPercent ?? 0) >= t),
						);
				if (level === 0) continue;
				const base = limitKey(s);
				const w = warned.find(
					(x) =>
						x.base === base &&
						(x.resetsAt === null || s.resetsAt === null
							? x.resetsAt === s.resetsAt && now - x.at < NO_RESET_MS
							: Math.abs(x.resetsAt - s.resetsAt) < SAME_WINDOW_MS),
				);
				if (w && w.level >= level) continue;
				if (w) {
					w.level = level;
					w.at = now;
				} else warned.push({ base, resetsAt: s.resetsAt, level, at: now });
				out.push({
					harness: s.harness,
					label: s.label,
					level: s.reached ? 100 : level,
					reached: s.reached,
					usedPercent: s.usedPercent,
					resetsAt: s.resetsAt,
				});
			}
		if (out.length || warned.length !== saved.length)
			this.store.metaSet(WARNED_KEY, JSON.stringify(warned.slice(-200)));
		return out;
	}
}

/** 1 to 3 whole percents from 1 to 99, sorted, no repeats; null when bad. */
function cleanThresholds(v: unknown): number[] | null {
	if (!Array.isArray(v) || v.length < 1 || v.length > 3) return null;
	const out = new Set<number>();
	for (const x of v) {
		if (typeof x !== "number" || !Number.isInteger(x) || x < 1 || x > 99)
			return null;
		out.add(x);
	}
	return [...out].sort((a, b) => a - b);
}
