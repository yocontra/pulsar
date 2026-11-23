/**
 * The usage page body, shared by the desktop layer and the phone page:
 * filters (machine, harness), period and Cost/Tokens toggles, the total
 * with its per-harness rows, the chart, totals, cost by type and the
 * Model/Day breakdown. Numbers come from one `GET /usage` report.
 */
import { InfoIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
	UsagePeriod,
	UsageReport,
	UsageRow,
	UsageTokens,
} from "../api/types.ts";
import { AgentAvatar, harnessName, plural } from "../ds/index.ts";
import Limits from "../features/limits/Limits.tsx";
import { useUsage } from "./data.ts";
import { ModelSheet, PricesSheet } from "./ModelSheet.tsx";
import {
	bucketLabel,
	byBucket,
	byHarness,
	byModel,
	cacheSavings,
	compact,
	costByType,
	type Filters,
	filterRows,
	type Metric,
	money,
	percent,
	processed,
	series,
	totals,
	value,
} from "./model.ts";
import { seriesColor, UsageChart } from "./UsageChart.tsx";
import "./usage.css";

export const PERIODS: { value: UsagePeriod; label: string }[] = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
];
export const METRICS: { value: Metric; label: string; key: string }[] = [
	{ value: "cost", label: "Cost", key: "C" },
	{ value: "tokens", label: "Tokens", key: "T" },
];

/** Page choices that survive closing the page (per browser). */
const PREFS_KEY = "pulsar.usage";
export interface Prefs {
	period: UsagePeriod;
	metric: Metric;
	breakdown: "model" | "day";
}
export function savePrefs(p: Prefs) {
	try {
		localStorage.setItem(PREFS_KEY, JSON.stringify(p));
	} catch {}
}
export function loadPrefs(): Prefs {
	const d: Prefs = { period: "7d", metric: "cost", breakdown: "model" };
	try {
		const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
		return {
			period: PERIODS.some((p) => p.value === v.period) ? v.period : d.period,
			metric: v.metric === "tokens" ? "tokens" : d.metric,
			breakdown: v.breakdown === "day" ? "day" : d.breakdown,
		};
	} catch {
		return d;
	}
}

function Segmented<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string; title?: string }[];
	onChange: (v: T) => void;
}) {
	return (
		<div className="usage-seg" role="radiogroup" aria-label={label}>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					role="radio"
					aria-checked={value === o.value}
					title={o.title}
					className={value === o.value ? "on" : ""}
					onClick={() => onChange(o.value)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}

const isTyping = (t: EventTarget | null) =>
	t instanceof HTMLElement &&
	(t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function UsageView({ variant }: { variant: "desktop" | "phone" }) {
	const [prefs, setPrefs] = useState(loadPrefs);
	const [filters, setFilters] = useState<Filters>({
		machine: null,
		harness: null,
	});
	const [model, setModel] = useState<string | null>(null);
	const [prices, setPrices] = useState(false);
	const q = useUsage(prefs.period);
	const update = (p: Partial<Prefs>) =>
		setPrefs((old) => {
			const next = { ...old, ...p };
			try {
				localStorage.setItem(PREFS_KEY, JSON.stringify(next));
			} catch {}
			return next;
		});

	// Desktop keys: C / T switch the metric, mod+shift+1..4 the period.
	useEffect(() => {
		if (variant !== "desktop") return;
		const onKey = (e: KeyboardEvent) => {
			if (isTyping(e.target) || model || prices) return;
			const mod = e.metaKey || e.ctrlKey;
			if (mod && e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
				e.preventDefault();
				update({ period: PERIODS[Number(e.code.slice(5)) - 1]!.value });
				return;
			}
			if (mod || e.altKey || e.shiftKey) return;
			if (e.key === "c" || e.key === "C") update({ metric: "cost" });
			if (e.key === "t" || e.key === "T") update({ metric: "tokens" });
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [variant, model, prices]);

	const report = q.data;
	const mod = /Mac|iP/.test(navigator.platform) ? "⌘" : "Ctrl+";
	return (
		<div className={`usage usage-${variant}`}>
			<header className="usage-head">
				<nav className="usage-crumbs" aria-label="Usage filters">
					{variant === "desktop" && <h1 className="usage-title">Usage</h1>}
					{variant === "desktop" && (
						<span className="usage-sep" aria-hidden="true">
							›
						</span>
					)}
					<select
						className="usage-select"
						aria-label="Machine"
						value={filters.machine ?? ""}
						onChange={(e) => {
							if (e.target.value === "\0prices") {
								setPrices(true);
								return;
							}
							setFilters((f) => ({ ...f, machine: e.target.value || null }));
						}}
					>
						<option value="">All machines</option>
						{report?.machines.map((m) => (
							<option key={m.id} value={m.id}>
								{m.name}
							</option>
						))}
						<option value={"\0prices"}>Model prices…</option>
					</select>
					<span className="usage-sep" aria-hidden="true">
						›
					</span>
					<select
						className="usage-select"
						aria-label="Harness"
						value={filters.harness ?? ""}
						onChange={(e) =>
							setFilters((f) => ({ ...f, harness: e.target.value || null }))
						}
					>
						<option value="">All harnesses</option>
						{harnessesOf(report).map((h) => (
							<option key={h} value={h}>
								{harnessName(h)}
							</option>
						))}
					</select>
				</nav>
				<div className="usage-controls">
					<Segmented
						label="Period"
						value={prefs.period}
						options={PERIODS.map((p, i) => ({
							...p,
							title: `${p.label} (${mod}Shift+${i + 1})`,
						}))}
						onChange={(period) => update({ period })}
					/>
					<select
						className="usage-select usage-compact"
						aria-label="Period"
						value={prefs.period}
						onChange={(e) => update({ period: e.target.value as UsagePeriod })}
					>
						{PERIODS.map((p) => (
							<option key={p.value} value={p.value}>
								{p.label}
							</option>
						))}
					</select>
					<Segmented
						label="Show"
						value={prefs.metric}
						options={METRICS.map((m) => ({
							...m,
							title: `${m.label} (${m.key})`,
						}))}
						onChange={(metric) => update({ metric })}
					/>
				</div>
			</header>
			{!report && q.isError && (
				<p className="usage-error" role="alert">
					Couldn't load usage.{" "}
					<button
						type="button"
						className="usage-link"
						onClick={() => void q.refetch()}
					>
						Try again
					</button>
				</p>
			)}
			{!report && !q.isError && <UsageSkeleton />}
			{report && (
				<Body
					report={report}
					metric={prefs.metric}
					filters={filters}
					breakdown={prefs.breakdown}
					onBreakdown={(breakdown) => update({ breakdown })}
					onModel={setModel}
					dim={q.isPlaceholderData}
				/>
			)}
			{report && model && (
				<ModelSheet
					report={report}
					rows={filterRows(report.rows, filters)}
					model={model}
					metric={prefs.metric}
					onClose={() => setModel(null)}
				/>
			)}
			{report && prices && (
				<PricesSheet report={report} onClose={() => setPrices(false)} />
			)}
		</div>
	);
}

export function harnessesOf(report: UsageReport | undefined): string[] {
	if (!report) return [];
	return [...new Set(report.rows.map((r) => r.harness))].sort();
}

function Body({
	report,
	metric,
	filters,
	breakdown,
	onBreakdown,
	onModel,
	dim,
}: {
	report: UsageReport;
	metric: Metric;
	filters: Filters;
	breakdown: "model" | "day";
	onBreakdown: (b: "model" | "day") => void;
	onModel: (model: string) => void;
	dim: boolean;
}) {
	const rows = useMemo(
		() => filterRows(report.rows, filters),
		[report, filters],
	);
	const t = useMemo(
		() => totals(report, rows, filters),
		[report, rows, filters],
	);
	const harnesses = useMemo(() => byHarness(rows, metric), [rows, metric]);
	const chart = useMemo(
		() => series(report, rows, metric),
		[report, rows, metric],
	);
	const fmt = metric === "cost" ? money : compact;
	const errors = report.machines.filter((m) => m.error);
	const whole = value(metric, t.cost, t.tokens);
	const chartLabel = `${report.bucket === "hour" ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "tokens"}`;
	if (rows.length === 0)
		return (
			<div className={`usage-body${dim ? " usage-dim" : ""}`}>
				<MachineErrors errors={errors} />
				<Limits report={report} />
				<p className="usage-empty" role="status">
					{report.scanning && !report.scannedAt
						? "Reading session files…"
						: "No usage yet."}
				</p>
			</div>
		);
	return (
		<div className={`usage-body${dim ? " usage-dim" : ""}`}>
			<MachineErrors errors={errors} />
			<Limits report={report} />
			<section className="usage-top">
				<div className="usage-summary">
					<p className="usage-figure" data-testid="usage-total">
						{fmt(whole)}
					</p>
					<p className="usage-sub">
						{plural(t.sessions, "session")} ·{" "}
						{metric === "cost" ? "API estimate" : "processed tokens"}
						{metric === "cost" && t.unpricedRecords > 0 && (
							<Unpriced records={t.unpricedRecords} models={t.unpricedModels} />
						)}
					</p>
					<ul className="usage-harnesses" aria-label="By harness">
						{harnesses.map((h) => (
							<li key={h.key} className="usage-harness">
								<span
									className="usage-dot"
									style={{ background: seriesColor(h.key) }}
									aria-hidden="true"
								/>
								<AgentAvatar harness={h.key} size="xs" />
								<span className="usage-harness-name">{harnessName(h.key)}</span>
								<span className="usage-num">
									{fmt(value(metric, h.cost, h.tokens))}
								</span>
								<span className="usage-harness-meta">
									{percent(h.share)} of {metric === "cost" ? "cost" : "tokens"}
									{metric === "cost" &&
										` · ${compact(processed(h.tokens))} tokens`}
								</span>
							</li>
						))}
					</ul>
				</div>
				<div className="usage-chart-wrap">
					<h2 className="usage-h2">{chartLabel}</h2>
					<UsageChart
						buckets={chart.buckets}
						series={chart.series}
						label={chartLabel}
						format={fmt}
						bucketLabel={(b) => bucketLabel(b, report.bucket)}
						name={harnessName}
					/>
				</div>
			</section>
			<Totals report={report} rows={rows} tokens={t.tokens} />
			<TypeShares report={report} rows={rows} metric={metric} />
			<section className="usage-breakdown" aria-labelledby="usage-bd">
				<div className="usage-bd-head">
					<h2 className="usage-h2" id="usage-bd">
						Breakdown
					</h2>
					<Segmented
						label="Breakdown by"
						value={breakdown}
						options={[
							{ value: "model", label: "Model" },
							{
								value: "day",
								label: report.bucket === "hour" ? "Hour" : "Day",
							},
						]}
						onChange={onBreakdown}
					/>
				</div>
				{breakdown === "model" ? (
					<ul className="usage-rows">
						{byModel(rows, metric).map((g) => {
							const unpriced = rows.some(
								(r) => r.model === g.key && r.cost === null,
							);
							return (
								<li key={g.key}>
									<button
										type="button"
										className="usage-row"
										onClick={() => onModel(g.key)}
									>
										<span className="usage-row-name">{g.key}</span>
										<ShareBar share={g.share} />
										<span className="usage-num">
											{metric === "cost" && unpriced
												? "No price"
												: fmt(value(metric, g.cost, g.tokens))}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				) : (
					<ul className="usage-rows">
						{byBucket(rows, metric).map((g) => (
							<li key={g.key} className="usage-row usage-row-static">
								<span className="usage-row-name">
									{bucketLabel(Number(g.key), report.bucket)}
								</span>
								<ShareBar share={g.share} />
								<span className="usage-num">
									{fmt(value(metric, g.cost, g.tokens))}
								</span>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

export function MachineErrors({ errors }: { errors: UsageReport["machines"] }) {
	if (!errors.length) return null;
	return (
		<ul className="usage-machine-errors" aria-label="Machines not counted">
			{errors.map((m) => (
				<li key={m.id}>
					{/* The daemon's reasons often name the machine ("mbp-b is asleep"). */}
					{m.error?.startsWith(m.name) ? m.error : `${m.name}: ${m.error}`}
				</li>
			))}
		</ul>
	);
}

export function Unpriced({
	records,
	models,
}: {
	records: number;
	models: string[];
}) {
	const [open, setOpen] = useState(false);
	return (
		<span className="usage-unpriced">
			<button
				type="button"
				className="usage-info"
				aria-expanded={open}
				aria-label="About unpriced usage"
				onClick={() => setOpen((o) => !o)}
			>
				<InfoIcon aria-hidden="true" />
			</button>
			{open && (
				<span className="usage-pop" role="note">
					{plural(records, "response")} from models with no price are left out:{" "}
					{models.join(", ")}. Set a price from the model's row.
				</span>
			)}
		</span>
	);
}

export function ShareBar({ share }: { share: number }) {
	return (
		<span className="usage-bar" aria-hidden="true">
			<span style={{ width: `${Math.max(share > 0 ? 2 : 0, share * 100)}%` }} />
		</span>
	);
}

function Totals({
	report,
	rows,
	tokens,
}: {
	report: UsageReport;
	rows: UsageRow[];
	tokens: UsageTokens;
}) {
	const items: [string, string][] = [
		["Processed tokens", compact(processed(tokens))],
		["Cached input", compact(tokens.cacheRead)],
		["Uncached input", compact(tokens.input)],
		["Output", compact(tokens.output)],
		["Cache savings", money(cacheSavings(rows, report.prices))],
	];
	return (
		<section aria-labelledby="usage-totals">
			<h2 className="usage-h2" id="usage-totals">
				Totals
			</h2>
			<dl className="usage-totals">
				{items.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd className="usage-num">{v}</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

export function TypeShares({
	report,
	rows,
	metric,
}: {
	report: UsageReport;
	rows: UsageRow[];
	metric: Metric;
}) {
	const parts = useMemo(() => {
		if (metric === "cost") {
			const c = costByType(rows, report.prices);
			return [
				["Input", c.input],
				["Cache reads", c.cacheRead],
				["Cache writes", c.cacheWrite],
				["Output", c.output],
			] as [string, number][];
		}
		const t = rows.reduce(
			(a, r) => ({
				input: a.input + r.input,
				read: a.read + r.cacheRead,
				write: a.write + r.cacheWrite5m + r.cacheWrite1h,
				output: a.output + r.output,
			}),
			{ input: 0, read: 0, write: 0, output: 0 },
		);
		return [
			["Input", t.input],
			["Cache reads", t.read],
			["Cache writes", t.write],
			["Output", t.output],
		] as [string, number][];
	}, [report, rows, metric]);
	const all = parts.reduce((n, [, v]) => n + v, 0);
	if (all <= 0) return null;
	const fmt = metric === "cost" ? money : compact;
	return (
		<section aria-labelledby="usage-types">
			<h2 className="usage-h2" id="usage-types">
				{metric === "cost" ? "Cost by type" : "Tokens by type"}
			</h2>
			<div className="usage-stack" aria-hidden="true">
				{parts.map(([k, v], i) => (
					<span
						key={k}
						data-part={i}
						style={{ width: `${(v / all) * 100}%` }}
					/>
				))}
			</div>
			<ul className="usage-legend">
				{parts.map(([k, v], i) => (
					<li key={k}>
						<span className="usage-swatch" data-part={i} aria-hidden="true" />
						{k} <span className="usage-num">{fmt(v)}</span>{" "}
						<span className="usage-muted">{percent(v / all)}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Shaped like the page, so nothing jumps when the report lands. */
export function UsageSkeleton() {
	return (
		<div className="usage-body usage-skeleton" aria-busy="true">
			<span className="usage-sr">Loading usage</span>
			<section className="usage-top">
				<div className="usage-summary">
					<span className="usage-sk usage-sk-figure" />
					<span className="usage-sk usage-sk-line" />
					{[0, 1, 2].map((i) => (
						<span key={i} className="usage-sk usage-sk-row" />
					))}
				</div>
				<div className="usage-chart-wrap">
					<span className="usage-sk usage-sk-chart" />
				</div>
			</section>
			<div className="usage-totals">
				{[0, 1, 2, 3, 4].map((i) => (
					<span key={i} className="usage-sk usage-sk-total" />
				))}
			</div>
		</div>
	);
}
