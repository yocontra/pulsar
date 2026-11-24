/**
 * The Usage tab on the phone (Konsta inside a TabShell): the period and
 * Cost/Tokens as segmented controls, the total, a full-width chart card,
 * machine and harness pickers as list rows, the per-harness rows, totals as
 * a two-column grid, cost by type, and the By model / By day breakdown. A
 * model opens its sheet. Live: the report re-reads on `usage` notices
 * (data.ts), so there is no refresh control.
 */
import {
	Block,
	BlockTitle,
	Card,
	List,
	ListItem,
	Segmented,
	SegmentedButton,
} from "konsta/react";
import { type ReactNode, useMemo, useState } from "react";
import type { UsageReport } from "../api/types.ts";
import { AgentAvatar, harnessName, plural } from "../ds/index.ts";
import Limits from "../features/limits/Limits.tsx";
import { type ActionButton, showActions } from "../mobile/ui/actions.ts";
import { TabShell } from "../mobile/ui/PageShell.tsx";
import { SheetShell } from "../mobile/ui/SheetShell.tsx";
import { useUsage } from "./data.ts";
import { ModelSheet, PricesSheet, type SheetFrame } from "./ModelSheet.tsx";
import {
	bucketLabel,
	byBucket,
	byHarness,
	byModel,
	cacheSavings,
	compact,
	type Filters,
	filterRows,
	isLocalModel,
	LOCAL_LABEL,
	type Metric,
	modelName,
	money,
	percent,
	processed,
	series,
	totals,
	value,
} from "./model.ts";
import { seriesColor, UsageChart } from "./UsageChart.tsx";
import {
	harnessesOf,
	loadPrefs,
	MachineErrors,
	METRICS,
	PERIODS,
	type Prefs,
	ShareBar,
	savePrefs,
	TypeShares,
	Unpriced,
	UsageSkeleton,
} from "./UsageView.tsx";
import "./usage.css";
import "./usage-phone.css";

const SEG = {
	strongBgIos: "bg-[var(--ds-surface-3)]",
	strongBgMaterial: "bg-[var(--ds-surface-3)]",
	strongHighlightBgIos: "bg-[var(--p-seg-on)]",
	strongHighlightBgMaterial: "bg-[var(--p-seg-on)]",
};

/** A segmented control with radio semantics (one choice of a few). */
function Choice<T extends string>({
	label,
	value,
	options,
	onChange,
}: {
	label: string;
	value: T;
	options: { value: T; label: string }[];
	onChange: (v: T) => void;
}) {
	return (
		// Pulsar's tokens, so both themes keep AA contrast (ui.css .p-seg).
		<Segmented
			strong
			rounded
			colors={SEG}
			className="p-seg"
			role="radiogroup"
			aria-label={label}
		>
			{options.map((o) => (
				<SegmentedButton
					key={o.value}
					active={value === o.value}
					role="radio"
					aria-checked={value === o.value}
					onClick={() => onChange(o.value)}
				>
					{o.label}
				</SegmentedButton>
			))}
		</Segmented>
	);
}

/** ModelSheet and PricesSheet in the phone's sheet (IonModal + Konsta). */
const PhoneFrame: SheetFrame = ({ title, onClose, children }) => (
	<FrameSheet title={title} onClose={onClose}>
		{children}
	</FrameSheet>
);
function FrameSheet({
	title,
	onClose,
	children,
}: {
	title: string;
	onClose: () => void;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(true);
	return (
		<SheetShell
			className="p-usage-modal"
			open={open}
			onClose={() => setOpen(false)}
			onClosed={onClose}
			title={title}
			detents={[0, 0.75, 1]}
			initial={0.75}
			testId="usage-sheet"
		>
			<div className="usage usage-phone p-usage-sheet">{children}</div>
		</SheetShell>
	);
}

export default function UsagePhone() {
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
			savePrefs(next);
			return next;
		});
	const report = q.data;
	const machineName = filters.machine
		? (report?.machines.find((m) => m.id === filters.machine)?.name ??
			filters.machine)
		: "All";
	const pickMachine = () =>
		void showActions({
			header: "Machine",
			buttons: [
				{ id: null as string | null, name: "All machines" },
				...(report?.machines.map((m) => ({ id: m.id, name: m.name })) ?? []),
			]
				.map(
					(m): ActionButton => ({
						text: m.id === filters.machine ? `${m.name} ✓` : m.name,
						handler: () => setFilters((f) => ({ ...f, machine: m.id })),
					}),
				)
				.concat({ text: "Cancel", role: "cancel" }),
		});
	const pickHarness = () =>
		void showActions({
			header: "Harness",
			buttons: [null, ...harnessesOf(report)]
				.map((h): ActionButton => {
					const name = h ? harnessName(h) : "All harnesses";
					return {
						text: h === filters.harness ? `${name} ✓` : name,
						handler: () => setFilters((f) => ({ ...f, harness: h })),
					};
				})
				.concat({ text: "Cancel", role: "cancel" }),
		});
	return (
		<TabShell title="Usage" className="p-usage" testId="usage-page">
			<div className="usage usage-phone p-usage-body">
				<Block className="p-usage-controls my-3">
					<Choice
						label="Period"
						value={prefs.period}
						options={PERIODS}
						onChange={(period) => update({ period })}
					/>
					<Choice
						label="Show"
						value={prefs.metric}
						options={METRICS}
						onChange={(metric) => update({ metric })}
					/>
				</Block>
				{!report && q.isError && (
					<Block>
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
					</Block>
				)}
				{!report && !q.isError && (
					<Block>
						<UsageSkeleton />
					</Block>
				)}
				{report && (
					<Body
						report={report}
						metric={prefs.metric}
						filters={filters}
						breakdown={prefs.breakdown}
						onBreakdown={(breakdown) => update({ breakdown })}
						onModel={setModel}
						dim={q.isPlaceholderData}
						machineName={machineName}
						harnessName={filters.harness ? harnessName(filters.harness) : "All"}
						onMachine={pickMachine}
						onHarness={pickHarness}
						onPrices={() => setPrices(true)}
					/>
				)}
			</div>
			{report && model && (
				<ModelSheet
					report={report}
					rows={filterRows(report.rows, filters)}
					model={model}
					metric={prefs.metric}
					onClose={() => setModel(null)}
					frame={PhoneFrame}
				/>
			)}
			{report && prices && (
				<PricesSheet
					report={report}
					onClose={() => setPrices(false)}
					frame={PhoneFrame}
				/>
			)}
		</TabShell>
	);
}

/** Keep the value with its bar so the label can use the whole line. */
function BreakdownValue({ share, amount }: { share: number; amount: string }) {
	return (
		<span className="p-usage-breakdown-value">
			<ShareBar share={share} />
			<span className="usage-num">{amount}</span>
		</span>
	);
}

function Body({
	report,
	metric,
	filters,
	breakdown,
	onBreakdown,
	onModel,
	dim,
	machineName,
	harnessName: harnessLabel,
	onMachine,
	onHarness,
	onPrices,
}: {
	report: UsageReport;
	metric: Metric;
	filters: Filters;
	breakdown: "model" | "day";
	onBreakdown: (b: "model" | "day") => void;
	onModel: (model: string) => void;
	dim: boolean;
	machineName: string;
	harnessName: string;
	onMachine: () => void;
	onHarness: () => void;
	onPrices: () => void;
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
	const chartLabel = `${report.bucket === "hour" ? "Hourly" : "Daily"} ${metric === "cost" ? "cost" : "tokens"}`;
	const filterList = (
		<List strong inset aria-label="Usage filters">
			<ListItem
				link
				title="Machine"
				titleWrapClassName="p-usage-picker"
				after={machineName}
				onClick={onMachine}
				data-testid="usage-machine"
			/>
			<ListItem
				link
				title="Harness"
				titleWrapClassName="p-usage-picker"
				after={harnessLabel}
				onClick={onHarness}
				data-testid="usage-harness"
			/>
			<ListItem link title="Model prices" onClick={onPrices} />
		</List>
	);
	return (
		<div className={dim ? "usage-dim" : undefined}>
			{errors.length > 0 && (
				<Block className="my-3">
					<MachineErrors errors={errors} />
				</Block>
			)}
			{rows.length === 0 ? (
				<>
					{filterList}
					<Block className="my-4">
						<Limits report={report} />
					</Block>
					<Block>
						<p className="usage-empty" role="status">
							{report.scanning && !report.scannedAt
								? "Reading session files…"
								: "No usage yet."}
						</p>
					</Block>
				</>
			) : (
				<>
					<Block className="p-usage-summary my-4">
						<p className="usage-figure" data-testid="usage-total">
							{fmt(value(metric, t.cost, t.tokens))}
						</p>
						<p className="usage-sub">
							{plural(t.sessions, "session")} ·{" "}
							{metric === "cost" ? "API estimate" : "processed tokens"}
							{metric === "cost" && t.unpricedRecords > 0 && (
								<Unpriced
									records={t.unpricedRecords}
									models={t.unpricedModels}
								/>
							)}
						</p>
					</Block>
					<Card raised className="p-usage-chart" header={chartLabel}>
						<UsageChart
							buckets={chart.buckets}
							series={chart.series}
							label={chartLabel}
							format={fmt}
							bucketLabel={(b) => bucketLabel(b, report.bucket)}
							name={harnessName}
						/>
					</Card>
					{filterList}
					<Block className="my-4">
						<Limits report={report} />
					</Block>
					<BlockTitle>By harness</BlockTitle>
					<List strong inset aria-label="By harness">
						{harnesses.map((h) => (
							<ListItem
								key={h.key}
								media={
									<span className="p-usage-media">
										<span
											className="usage-dot"
											style={{ background: seriesColor(h.key) }}
											aria-hidden="true"
										/>
										<AgentAvatar harness={h.key} size="xs" />
									</span>
								}
								title={harnessName(h.key)}
								after={
									<span className="usage-num">
										{fmt(value(metric, h.cost, h.tokens))}
									</span>
								}
								footer={`${percent(h.share)} of ${metric === "cost" ? "cost" : "tokens"}${metric === "cost" ? ` · ${compact(processed(h.tokens))} tokens` : ""}`}
							/>
						))}
					</List>
					<BlockTitle>Totals</BlockTitle>
					<Block>
						<dl className="p-usage-totals">
							{(
								[
									["Processed tokens", compact(processed(t.tokens))],
									["Cached input", compact(t.tokens.cacheRead)],
									["Uncached input", compact(t.tokens.input)],
									["Output", compact(t.tokens.output)],
									["Cache savings", money(cacheSavings(rows, report.prices))],
								] as [string, string][]
							).map(([k, v]) => (
								<div key={k} className="p-usage-total">
									<dt>{k}</dt>
									<dd className="usage-num">{v}</dd>
								</div>
							))}
						</dl>
					</Block>
					<Block className="p-usage-types">
						<TypeShares report={report} rows={rows} metric={metric} />
					</Block>
					<BlockTitle>Breakdown</BlockTitle>
					<Block className="p-usage-bd">
						<Choice
							label="Breakdown by"
							value={breakdown}
							options={[
								{ value: "model", label: "By model" },
								{
									value: "day",
									label: report.bucket === "hour" ? "By hour" : "By day",
								},
							]}
							onChange={onBreakdown}
						/>
					</Block>
					<List strong inset aria-label="Breakdown" className="usage-breakdown">
						{breakdown === "model"
							? byModel(rows, metric).map((g) => {
									const unpriced = rows.some(
										(r) => r.model === g.key && r.cost === null,
									);
									return (
										<ListItem
											key={g.key}
											link
											linkComponent="button"
											contentClassName="w-full text-start"
											data-model={g.key}
											title={
												<span className="p-usage-model">
													{modelName(g.key)}
												</span>
											}
											footer={
												<BreakdownValue
													share={g.share}
													amount={
														metric === "cost" && isLocalModel(g.key)
															? LOCAL_LABEL
															: metric === "cost" && unpriced
																? "No price"
																: fmt(value(metric, g.cost, g.tokens))
													}
												/>
											}
											onClick={() => onModel(g.key)}
										/>
									);
								})
							: byBucket(rows, metric).map((g) => (
									<ListItem
										key={g.key}
										title={bucketLabel(Number(g.key), report.bucket)}
										footer={
											<BreakdownValue
												share={g.share}
												amount={fmt(value(metric, g.cost, g.tokens))}
											/>
										}
									/>
								))}
					</List>
				</>
			)}
		</div>
	);
}
