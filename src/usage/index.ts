import type {
	AgentUsage,
	LimitState,
	LimitWarning,
	UsageCostSource,
	UsageLimits,
	UsagePeriod,
	UsagePrice,
	UsageReport,
	UsageRow,
	UsageTokenSource,
	UsageTokens,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";
import { type AcpUsage, loadAcpUsage } from "./acp.ts";
import { cleanLimits, current, Limits } from "./limits.ts";
import {
	costOf,
	isLocalModel,
	normalizeModel,
	PRICE_FIELDS,
	type Price,
	priceFor,
	priceTable,
} from "./prices.ts";
import { type ScanTuning, type UsageRoots, UsageScanner } from "./scan.ts";

export const USAGE_PERIODS: readonly UsagePeriod[] = [
	"24h",
	"7d",
	"30d",
	"90d",
];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PERIOD_MS: Record<UsagePeriod, number> = {
	"24h": DAY,
	"7d": 7 * DAY,
	"30d": 30 * DAY,
	"90d": 90 * DAY,
};
/** The `meta` key holding the operator's price edits. */
const PRICES_KEY = "usage.prices";
/** Harnesses whose session files are read (agents of others have no usage). */
const USAGE_HARNESSES = new Set(["claude", "codex", "pi", "omp"]);

/** One machine's usage, unpriced: what a peer sends (`act: usage.rows`). */
export interface LocalUsage {
	rows: (UsageTokens & { harness: string; model: string; t: number })[];
	sessions: { harness: string; count: number }[];
	scannedAt: number | null;
	/** Plan limits this machine's harnesses reported (absent from older nodes). */
	limits?: LimitState[];
}

/** One agent's usage on its home node, unpriced (`act: usage.agent`). */
export interface LocalAgentUsage {
	tokens: UsageTokens;
	/** Tokens per model, so the asking node prices them. */
	models: (UsageTokens & { model: string })[];
	context: { used: number; window: number | null } | null;
	model: string | null;
	/** Optional cumulative ACP amount in USD. */
	reportedCost?: NonNullable<AcpUsage["cost"]>;
	/** Its harness's plan limits on its machine. */
	limits?: LimitState[];
}

/** What federation gives the usage page: each peer's answer or why not. */
export interface PoolUsage {
	usage(
		period: UsagePeriod,
		tzMinutes: number,
		as?: Principal,
	): Promise<
		{
			machineId: string;
			name: string;
			usage: LocalUsage | null;
			error: string | null;
		}[]
	>;
	agentUsage(address: string, as?: Principal): Promise<LocalAgentUsage>;
}

type Row = Record<string, string | number | null>;

const ZERO: UsageTokens = {
	input: 0,
	cacheRead: 0,
	cacheWrite5m: 0,
	cacheWrite1h: 0,
	output: 0,
	records: 0,
};

function tokens(r: Row): UsageTokens {
	return {
		input: Number(r.input) || 0,
		cacheRead: Number(r.cache_read) || 0,
		cacheWrite5m: Number(r.cache_write_5m) || 0,
		cacheWrite1h: Number(r.cache_write_1h) || 0,
		output: Number(r.output) || 0,
		records: Number(r.records) || 0,
	};
}

function addTokens(a: UsageTokens, b: UsageTokens): UsageTokens {
	return {
		input: a.input + b.input,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
		cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
		output: a.output + b.output,
		records: a.records + b.records,
	};
}

/** Clean numbers from a peer (never trust a frame's shape). */
function cleanTokens(v: unknown): UsageTokens {
	const o = (v ?? {}) as Record<string, unknown>;
	const n = (k: string) => {
		const x = Number(o[k]);
		return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
	};
	return {
		input: n("input"),
		cacheRead: n("cacheRead"),
		cacheWrite5m: n("cacheWrite5m"),
		cacheWrite1h: n("cacheWrite1h"),
		output: n("output"),
		records: n("records"),
	};
}

const text = (v: unknown, max = 200) => String(v ?? "").slice(0, max);

/** A peer's `usage.rows` answer, checked. */
export function cleanLocalUsage(v: unknown): LocalUsage | null {
	const o = v as Partial<LocalUsage> | null;
	if (!o || !Array.isArray(o.rows) || !Array.isArray(o.sessions)) return null;
	return {
		rows: o.rows.slice(0, 50_000).map((r) => ({
			...cleanTokens(r),
			harness: text(r?.harness, 40),
			model: text(r?.model),
			t: Number(r?.t) || 0,
		})),
		sessions: o.sessions.slice(0, 100).map((s) => ({
			harness: text(s?.harness, 40),
			count: Math.max(0, Math.floor(Number(s?.count) || 0)),
		})),
		scannedAt: Number(o.scannedAt) || null,
		limits: cleanLimits(o.limits),
	};
}

/** A peer's `usage.agent` answer, checked. */
export function cleanAgentUsage(v: unknown): LocalAgentUsage {
	const o = (v ?? {}) as Partial<LocalAgentUsage>;
	const c = o.context as LocalAgentUsage["context"] | undefined;
	const cost = o.reportedCost;
	return {
		tokens: cleanTokens(o.tokens),
		models: Array.isArray(o.models)
			? o.models
					.slice(0, 100)
					.map((m) => ({ ...cleanTokens(m), model: text(m?.model) }))
			: [],
		context:
			c && Number.isSafeInteger(c.used) && c.used >= 0
				? {
						used: c.used,
						window:
							c.window && Number.isSafeInteger(c.window) && c.window > 0
								? c.window
								: null,
					}
				: null,
		model: typeof o.model === "string" ? text(o.model) : null,
		...(cost &&
		typeof cost.amount === "number" &&
		Number.isFinite(cost.amount) &&
		cost.amount >= 0 &&
		(cost.source === "reported" || cost.source === "estimated")
			? { reportedCost: { amount: cost.amount, source: cost.source } }
			: {}),
		limits: cleanLimits(o.limits),
	};
}

export interface UsageOptions {
	/** Session folders to read (tests point them at fixtures). */
	roots?: () => UsageRoots;
	/** Read sizes and a commit hook (tests). */
	tuning?: ScanTuning;
}

/**
 * Token usage and its API estimate: this node's scanner, the price table
 * (defaults plus the operator's edits, kept in `meta`), and pool reports
 * that sum every machine's tokens and price them here.
 */
export class Usage {
	private readonly store: Store;
	readonly scanner: UsageScanner;
	readonly limits: Limits;
	/** Each peer's limits from its last answer (warnings cover the pool). */
	private readonly peerLimits = new Map<string, LimitState[]>();

	constructor(store: Store, opts: UsageOptions = {}) {
		this.store = store;
		this.scanner = new UsageScanner(store, opts.roots, opts.tuning);
		this.limits = new Limits(store);
	}

	// --- Limits ---

	/** Remembers what peers said about their limits. */
	private notePeers(
		answers: { machineId: string; usage: LocalUsage | null }[],
	) {
		for (const a of answers)
			if (a.usage?.limits) this.peerLimits.set(a.machineId, a.usage.limits);
	}

	/** `GET /usage/limits`: this machine's readings, the peers' last ones, and the settings. */
	limitsView(self: string, now = Date.now()): UsageLimits {
		const limits: UsageLimits["limits"] = this.limits
			.local(now)
			.map((l) => ({ ...l, machine: self }));
		for (const [machine, list] of this.peerLimits)
			for (const l of list) if (current(l, now)) limits.push({ ...l, machine });
		return { limits, settings: this.limits.settings() };
	}

	/**
	 * Asks the peers for their limits (a small `usage.rows` read), then
	 * returns the warnings due for the whole pool. A peer that does not
	 * answer keeps its last readings.
	 */
	async limitWarnings(
		pool: PoolUsage | null,
		now = Date.now(),
	): Promise<LimitWarning[]> {
		if (pool) this.notePeers(await pool.usage("24h", 0));
		const all = [...this.limits.local(now)];
		for (const l of this.peerLimits.values()) all.push(...l);
		return this.limits.check(all, now);
	}

	// --- Prices ---

	private custom(): Record<string, Price | null> {
		try {
			const v = JSON.parse(this.store.metaGet(PRICES_KEY) ?? "{}");
			return v && typeof v === "object" ? v : {};
		} catch {
			return {};
		}
	}

	prices(): UsagePrice[] {
		const custom = this.custom();
		return [...priceTable(custom)]
			.map(([model, p]) => ({
				model,
				...p,
				source: (custom[model] ? "custom" : "default") as "default" | "custom",
			}))
			.sort((a, b) => a.model.localeCompare(b.model));
	}

	/**
	 * Sets a model's price (dollars per million tokens), or with null drops
	 * the operator's edit (a default comes back).
	 */
	setPrice(model: string, price: Partial<Price> | null): UsagePrice[] {
		const key = normalizeModel(model);
		if (!key || key.length > 200)
			throw new RpcError("bad_request", "model: 1 to 200 characters");
		const custom = this.custom();
		if (price === null) delete custom[key];
		else {
			const p = {} as Price;
			for (const f of PRICE_FIELDS) {
				const v = price[f];
				if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000)
					throw new RpcError(
						"bad_request",
						`${f}: dollars per million tokens, 0 to 10000`,
					);
				p[f] = v;
			}
			custom[key] = p;
		}
		this.store.metaSet(PRICES_KEY, JSON.stringify(custom));
		return this.prices();
	}

	// --- This machine ---

	/**
	 * This machine's tokens in the period: per hour for 24h, per local day
	 * (`tzMinutes` east of UTC) otherwise, by harness and model.
	 */
	local(period: UsagePeriod, tzMinutes: number, now = Date.now()): LocalUsage {
		const { from, bucket } = range(period, now, tzMinutes);
		const off = tzMinutes * 60_000;
		const t =
			bucket === "hour"
				? "hour"
				: `((hour + ${off}) / ${DAY}) * ${DAY} - ${off}`;
		const rows = this.store.db
			.prepare(
				`SELECT ${t} AS t, harness, model,
	SUM(input) AS input, SUM(cache_read) AS cache_read,
	SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,
	SUM(output) AS output, SUM(records) AS records
FROM usage_hourly WHERE hour >= ? GROUP BY 1, harness, model ORDER BY 1`,
			)
			.all(from) as Row[];
		const sessions = this.store.db
			.prepare(
				`SELECT harness, COUNT(DISTINCT session) AS count FROM usage_hourly
WHERE hour >= ? GROUP BY harness`,
			)
			.all(from) as Row[];
		return {
			rows: rows.map((r) => ({
				...tokens(r),
				harness: String(r.harness),
				model: String(r.model),
				t: Number(r.t),
			})),
			sessions: sessions.map((s) => ({
				harness: String(s.harness),
				count: Number(s.count),
			})),
			scannedAt: this.scanner.scannedAt,
			limits: this.limits.local(now),
		};
	}

	/** One local agent's session: tokens per model and its latest context. */
	async localAgent(agent: Agent): Promise<LocalAgentUsage> {
		const none: LocalAgentUsage = {
			tokens: ZERO,
			models: [],
			context: null,
			model: null,
		};
		if (!agent.sessionId) return none;
		const acp =
			agent.meta?.acp === "1"
				? await loadAcpUsage({
						harness: agent.harness,
						sessionId: agent.sessionId,
					})
				: null;
		const acpFields = {
			...(acp?.context ? { context: acp.context } : {}),
			...(acp?.cost ? { reportedCost: acp.cost } : {}),
		};
		if (!USAGE_HARNESSES.has(agent.harness)) return { ...none, ...acpFields };
		const models = (
			this.store.db
				.prepare(
					`SELECT model, SUM(input) AS input, SUM(cache_read) AS cache_read,
	SUM(cache_write_5m) AS cache_write_5m, SUM(cache_write_1h) AS cache_write_1h,
	SUM(output) AS output, SUM(records) AS records
FROM usage_hourly WHERE harness = ? AND session = ? GROUP BY model`,
				)
				.all(agent.harness, agent.sessionId) as Row[]
		).map((r) => ({ ...tokens(r), model: String(r.model) }));
		// The session's own file (not a subagent's): the newest line read.
		const file = this.store.db
			.prepare(
				`SELECT model, context_used, context_window FROM usage_files
WHERE harness = ? AND session = ? AND context_used IS NOT NULL
ORDER BY (path LIKE '%' || ? || '.jsonl') DESC, last_at DESC LIMIT 1`,
			)
			.get(agent.harness, agent.sessionId, agent.sessionId) as Row | undefined;
		return {
			tokens: models.reduce<UsageTokens>(addTokens, ZERO),
			models,
			context: file
				? {
						used: Number(file.context_used) || 0,
						window: Number(file.context_window) || null,
					}
				: null,
			model: file?.model ? String(file.model) : null,
			limits: this.limits.forHarness(agent.harness),
			...acpFields,
		};
	}

	// --- Priced, for the app ---

	/** Dollars for tokens of one model; null when the model has no price. */
	private pricer() {
		const table = priceTable(this.custom());
		const cache = new Map<string, Price | null>();
		return (model: string, t: UsageTokens): number | null => {
			let p = cache.get(model);
			if (p === undefined) {
				p = priceFor(model, table);
				cache.set(model, p);
			}
			return p ? costOf(t, p) : null;
		};
	}

	/**
	 * The pool's usage: this machine's rows and every peer's (asked in
	 * parallel), priced with this node's table. A peer that does not answer
	 * is listed with its error; the rest still count.
	 */
	async report(
		period: UsagePeriod,
		tzMinutes: number,
		self: { id: string; name: string },
		pool: PoolUsage | null,
		as?: Principal,
		now = Date.now(),
	): Promise<UsageReport> {
		const { from, bucket } = range(period, now, tzMinutes);
		const price = this.pricer();
		const machines: UsageReport["machines"] = [
			{ id: self.id, name: self.name, error: null },
		];
		const parts: { machine: string; usage: LocalUsage }[] = [
			{ machine: self.id, usage: this.local(period, tzMinutes, now) },
		];
		if (pool) {
			const answers = await pool.usage(period, tzMinutes, as);
			this.notePeers(answers);
			for (const p of answers) {
				machines.push({ id: p.machineId, name: p.name, error: p.error });
				if (p.usage) parts.push({ machine: p.machineId, usage: p.usage });
			}
		}
		const limits: NonNullable<UsageReport["limits"]> = [];
		for (const { machine, usage } of parts)
			for (const l of usage.limits ?? [])
				if (current(l, now)) limits.push({ ...l, machine });
		const rows: UsageRow[] = [];
		const sessions: UsageReport["sessions"] = [];
		for (const { machine, usage } of parts) {
			for (const r of usage.rows) {
				const cost = price(r.model, r);
				const local = isLocalModel(r.model);
				rows.push({
					...r,
					machine,
					cost,
					tokenSource: local ? "local" : "reported",
					costSource: local
						? "local"
						: cost === null
							? "unavailable"
							: "estimated",
				});
			}
			for (const s of usage.sessions) sessions.push({ machine, ...s });
		}
		return {
			period,
			from,
			to: now,
			bucket,
			rows,
			sessions,
			machines,
			prices: this.prices(),
			scannedAt: this.scanner.scannedAt,
			scanning: this.scanner.scanning,
			limits,
			limitSettings: this.limits.settings(),
		};
	}

	/** An agent's usage, priced here (a remote one's tokens come from its home node). */
	priceAgent(address: string, u: LocalAgentUsage): AgentUsage {
		const price = this.pricer();
		let cost = 0;
		const tokenSources = new Set<UsageTokenSource>();
		const costSources = new Set<UsageCostSource>();
		for (const m of u.models) {
			const c = price(m.model, m);
			const local = isLocalModel(m.model);
			tokenSources.add(local ? "local" : "reported");
			costSources.add(
				local ? "local" : c === null ? "unavailable" : "estimated",
			);
			cost += c ?? 0;
		}
		if (!tokenSources.size)
			tokenSources.add(u.tokens.records > 0 ? "reported" : "unavailable");
		if (!costSources.size) costSources.add("unavailable");
		if (u.reportedCost && !costSources.has("local")) {
			cost = u.reportedCost.amount;
			costSources.clear();
			costSources.add(u.reportedCost.source);
		}
		return {
			agent: address,
			tokens: u.tokens,
			cost: costSources.has("unavailable") ? null : cost,
			tokenSources: [...tokenSources],
			costSources: [...costSources],
			context: u.context,
			model: u.model,
			limits: (u.limits ?? []).filter((l) => current(l, Date.now())),
		};
	}
}

/** The period's start and bucket size. */
export function range(
	period: UsagePeriod,
	now: number,
	tzMinutes: number,
): { from: number; bucket: "hour" | "day" } {
	if (period === "24h")
		return {
			from: Math.floor((now - DAY) / HOUR) * HOUR + HOUR,
			bucket: "hour",
		};
	// Whole local days: today and the N-1 before it.
	const off = tzMinutes * 60_000;
	const today = Math.floor((now + off) / DAY) * DAY - off;
	return { from: today - (PERIOD_MS[period] - DAY), bucket: "day" };
}
