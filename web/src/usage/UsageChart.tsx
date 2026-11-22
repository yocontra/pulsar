import { useRef, useState } from "react";
import { harnessKey } from "../ds/index.ts";
import type { Series } from "./model.ts";

const W = 600;
const H = 224;
const PAD_TOP = 8;

/** A series' color: the harness's own token, else a neutral one. */
export function seriesColor(key: string): string {
	const k = harnessKey(key);
	return k === "other" ? "var(--ds-text-3)" : `var(--ds-h-${k}-fg)`;
}

/**
 * Stacked-free area chart in plain SVG: one translucent area and a 2px line
 * per series, light gridlines, and a tooltip that follows the pointer to the
 * nearest bucket. Labels are HTML so they stay crisp at any width.
 */
export function UsageChart({
	buckets,
	series,
	label,
	format,
	bucketLabel,
	name,
	color = seriesColor,
}: {
	buckets: number[];
	series: Series[];
	/** The accessible name ("Daily cost"). */
	label: string;
	format: (n: number) => string;
	bucketLabel: (t: number) => string;
	name: (key: string) => string;
	color?: (key: string) => string;
}) {
	const ref = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<number | null>(null);
	const n = buckets.length;
	const max = Math.max(0, ...series.flatMap((s) => s.points));
	const top = niceMax(max);
	const x = (i: number) => (n <= 1 ? W / 2 : (i / (n - 1)) * W);
	const y = (v: number) => H - (top > 0 ? (v / top) * (H - PAD_TOP) : 0);
	const line = (pts: number[]) =>
		pts
			.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
			.join("");
	const area = (pts: number[]) =>
		`${line(pts)}L${x(n - 1).toFixed(1)},${H}L${x(0).toFixed(1)},${H}Z`;
	const pick = (clientX: number) => {
		const el = ref.current;
		if (!el || n === 0) return;
		const r = el.getBoundingClientRect();
		const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
		setHover(Math.round(f * (n - 1)));
	};
	const ticks = [0.25, 0.5, 0.75, 1];
	const labelEvery = Math.max(1, Math.ceil(n / 6));
	return (
		<figure className="usage-chart" aria-label={label}>
			<div className="usage-chart-y" aria-hidden="true">
				{ticks
					.slice()
					.reverse()
					.map((t) => (
						<span key={t}>{format(top * t)}</span>
					))}
			</div>
			<div
				ref={ref}
				className="usage-chart-plot"
				onPointerMove={(e) => pick(e.clientX)}
				onPointerDown={(e) => pick(e.clientX)}
				onPointerLeave={() => setHover(null)}
			>
				<svg
					viewBox={`0 0 ${W} ${H}`}
					preserveAspectRatio="none"
					role="img"
					aria-label={label}
				>
					{ticks.map((t) => (
						<line
							key={t}
							className="usage-grid"
							x1={0}
							x2={W}
							y1={y(top * t)}
							y2={y(top * t)}
						/>
					))}
					<line
						className="usage-grid"
						x1={0}
						x2={W}
						y1={H - 0.5}
						y2={H - 0.5}
					/>
					{series.map((s) => (
						<g key={s.key} style={{ color: color(s.key) }}>
							<path className="usage-area" d={area(s.points)} />
							<path className="usage-line" d={line(s.points)} />
						</g>
					))}
					{hover !== null && (
						<line
							className="usage-cursor"
							x1={x(hover)}
							x2={x(hover)}
							y1={0}
							y2={H}
						/>
					)}
				</svg>
				{hover !== null && (
					<div
						className="usage-tip"
						role="status"
						data-side={hover > (n - 1) / 2 ? "left" : "right"}
						style={{ left: `${n <= 1 ? 50 : (hover / (n - 1)) * 100}%` }}
					>
						<div className="usage-tip-title">
							{bucketLabel(buckets[hover]!)}
						</div>
						{series.map((s) => (
							<div key={s.key} className="usage-tip-row">
								<span
									className="usage-dot"
									style={{ background: color(s.key) }}
								/>
								<span className="usage-tip-name">{name(s.key)}</span>
								<span className="usage-num">
									{format(s.points[hover] ?? 0)}
								</span>
							</div>
						))}
					</div>
				)}
			</div>
			<div className="usage-chart-x" aria-hidden="true">
				{buckets.map((t, i) =>
					i % labelEvery === 0 ? (
						<span
							key={t}
							// The end labels stay inside the chart: the first starts at
							// its tick, the last ends at its tick.
							className={
								n > 1 && i === 0
									? "is-first"
									: n > 1 && i === n - 1
										? "is-last"
										: undefined
							}
							style={{ left: `${n <= 1 ? 50 : (i / (n - 1)) * 100}%` }}
						>
							{bucketLabel(t)}
						</span>
					) : null,
				)}
			</div>
		</figure>
	);
}

/** A round top for the axis (1, 2 or 5 times a power of ten). */
function niceMax(v: number): number {
	if (v <= 0) return 0;
	const p = 10 ** Math.floor(Math.log10(v));
	for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
	return 10 * p;
}
