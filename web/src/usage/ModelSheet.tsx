/**
 * Sheets over the usage page: one model's trend, cache hit rate, cost per
 * million tokens and its price ("Set price"), and the whole price table.
 * They sit inside the page (the desktop layer keeps focus there; the phone
 * page scrolls under them), close with Esc or the X, and give focus back.
 */
import { XIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api } from "../api/client.ts";
import type { UsagePrice, UsageReport, UsageRow } from "../api/types.ts";
import { invalidateUsage } from "./data.ts";
import {
	addTokens,
	bucketLabel,
	cacheHitRate,
	compact,
	type Metric,
	money,
	percent,
	priceOf,
	processed,
	series,
	ZERO,
} from "./model.ts";
import { UsageChart } from "./UsageChart.tsx";

function Sheet({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const back = document.activeElement as HTMLElement | null;
		ref.current?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			// The sheet closes, not the page under it.
			e.stopPropagation();
			e.preventDefault();
			onClose();
		};
		const el = ref.current;
		el?.addEventListener("keydown", onKey);
		return () => {
			el?.removeEventListener("keydown", onKey);
			back?.focus?.();
		};
	}, [onClose]);
	return (
		<div className="usage-sheet-wrap">
			<button
				type="button"
				className="usage-sheet-backdrop"
				aria-label="Close"
				tabIndex={-1}
				onClick={onClose}
			/>
			<div
				ref={ref}
				className="usage-sheet"
				role="dialog"
				aria-modal="true"
				aria-label={title}
				tabIndex={-1}
			>
				<div className="usage-sheet-head">
					<h2 className="usage-sheet-title">{title}</h2>
					<button
						type="button"
						className="usage-icon-btn"
						aria-label="Close"
						onClick={onClose}
					>
						<XIcon aria-hidden="true" />
					</button>
				</div>
				{children}
			</div>
		</div>
	);
}

type PriceFields = Omit<UsagePrice, "model" | "source">;
const FIELDS: { key: keyof PriceFields; label: string }[] = [
	{ key: "input", label: "Input" },
	{ key: "output", label: "Output" },
	{ key: "cacheRead", label: "Cache read" },
	{ key: "cacheWrite5m", label: "Cache write (5m)" },
	{ key: "cacheWrite1h", label: "Cache write (1h)" },
];

/** Dollars per million tokens for one model; saving re-prices every period. */
function PriceForm({
	model,
	current,
	onSaved,
}: {
	model: string;
	current: UsagePrice | null;
	onSaved?: () => void;
}) {
	const init = () =>
		Object.fromEntries(
			FIELDS.map((f) => [f.key, current ? String(current[f.key]) : ""]),
		) as Record<keyof PriceFields, string>;
	const [v, setV] = useState(init);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const parsed = FIELDS.map((f) => Number(v[f.key]));
	const valid = FIELDS.every(
		(f, i) => v[f.key].trim() !== "" && parsed[i]! >= 0 && parsed[i]! <= 10_000,
	);
	const save = async (price: PriceFields | null) => {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			await api.setUsagePrice(model, price);
			await invalidateUsage();
			setSaved(true);
			onSaved?.();
		} catch (e) {
			setError((e as Error).message || "Couldn't save the price.");
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			className="usage-price-form"
			aria-label={`Price for ${model}`}
			onSubmit={(e) => {
				e.preventDefault();
				if (!valid || busy) return;
				const price = Object.fromEntries(
					FIELDS.map((f, i) => [f.key, parsed[i]!]),
				) as PriceFields;
				void save(price);
			}}
		>
			<p className="usage-muted">US dollars per million tokens.</p>
			<div className="usage-price-grid">
				{FIELDS.map((f) => (
					<label key={f.key}>
						<span>{f.label}</span>
						<input
							inputMode="decimal"
							value={v[f.key]}
							onChange={(e) => setV((o) => ({ ...o, [f.key]: e.target.value }))}
							aria-invalid={
								v[f.key].trim() !== "" &&
								!(Number(v[f.key]) >= 0 && Number(v[f.key]) <= 10_000)
							}
						/>
					</label>
				))}
			</div>
			<div className="usage-price-actions">
				{busy ? (
					<span className="usage-progress" role="status">
						Saving…
					</span>
				) : (
					<button
						type="submit"
						className="usage-primary"
						disabled={!valid}
						title={
							valid
								? undefined
								: "Enter a number from 0 to 10000 in every field"
						}
					>
						Set price
					</button>
				)}
				{current?.source === "custom" && !busy && (
					<button
						type="button"
						className="usage-link"
						onClick={() => void save(null)}
					>
						Use default
					</button>
				)}
				{saved && !busy && (
					<span className="usage-muted" role="status">
						Saved.
					</span>
				)}
			</div>
			{error && (
				<p className="usage-error" role="alert">
					{error}
				</p>
			)}
		</form>
	);
}

export function ModelSheet({
	report,
	rows,
	model,
	metric,
	onClose,
}: {
	report: UsageReport;
	rows: UsageRow[];
	model: string;
	metric: Metric;
	onClose: () => void;
}) {
	const mine = rows.filter((r) => r.model === model);
	const tokens = mine.reduce(addTokens, ZERO);
	const priced = mine.every((r) => r.cost !== null);
	const cost = mine.reduce((n, r) => n + (r.cost ?? 0), 0);
	const all = processed(tokens);
	const chart = series(report, mine, metric, () => model);
	const fmt = metric === "cost" ? money : compact;
	const price = priceOf(model, report.prices);
	return (
		<Sheet title={model} onClose={onClose}>
			<dl className="usage-totals usage-totals-3">
				<div>
					<dt>{priced ? "API estimate" : "Cost"}</dt>
					<dd className="usage-num">{priced ? money(cost) : "No price"}</dd>
				</div>
				<div>
					<dt>Cache hit rate</dt>
					<dd className="usage-num">{percent(cacheHitRate(tokens))}</dd>
				</div>
				<div>
					<dt>Per million tokens</dt>
					<dd className="usage-num">
						{priced && all > 0 ? money((cost / all) * 1e6) : "—"}
					</dd>
				</div>
			</dl>
			<UsageChart
				buckets={chart.buckets}
				series={chart.series}
				label={`${model} trend`}
				format={fmt}
				bucketLabel={(b) => bucketLabel(b, report.bucket)}
				name={() => model}
				color={() => "var(--ds-primary)"}
			/>
			<h3 className="usage-h2">Price</h3>
			<PriceForm model={model} current={price} />
		</Sheet>
	);
}

export function PricesSheet({
	report,
	onClose,
}: {
	report: UsageReport;
	onClose: () => void;
}) {
	const [editing, setEditing] = useState<string | null>(null);
	const [adding, setAdding] = useState("");
	const unpriced = [
		...new Set(report.rows.filter((r) => r.cost === null).map((r) => r.model)),
	].sort();
	return (
		<Sheet title="Model prices" onClose={onClose}>
			<p className="usage-muted">
				Used for every machine's tokens. A price covers model ids that start
				with its name.
			</p>
			{unpriced.length > 0 && (
				<p className="usage-muted">No price yet: {unpriced.join(", ")}</p>
			)}
			<ul className="usage-rows">
				{report.prices.map((p) => (
					<li key={p.model}>
						<button
							type="button"
							className="usage-row"
							aria-expanded={editing === p.model}
							onClick={() => setEditing(editing === p.model ? null : p.model)}
						>
							<span className="usage-row-name">{p.model}</span>
							<span className="usage-muted">
								{p.source === "custom" ? "Edited" : "Default"}
							</span>
							<span className="usage-num">
								${p.input} / ${p.output}
							</span>
						</button>
						{editing === p.model && <PriceForm model={p.model} current={p} />}
					</li>
				))}
			</ul>
			<form
				className="usage-add-price"
				onSubmit={(e) => {
					e.preventDefault();
					if (adding.trim()) setEditing(adding.trim());
				}}
			>
				<label>
					<span>Add a model</span>
					<input
						value={adding}
						placeholder={unpriced[0] ?? "model id"}
						onChange={(e) => setAdding(e.target.value)}
					/>
				</label>
				<button type="submit" className="usage-link" disabled={!adding.trim()}>
					Add
				</button>
			</form>
			{editing && !report.prices.some((p) => p.model === editing) && (
				<PriceForm
					model={editing}
					current={null}
					onSaved={() => setAdding("")}
				/>
			)}
		</Sheet>
	);
}
