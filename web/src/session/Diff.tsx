import { diffLines } from "diff";
import { type ReactNode, useMemo, useState } from "react";
import { plural } from "../lib/format.ts";
import { type Lines, LineTokens, useTokens } from "./highlight.tsx";

export type DiffRow = {
	sign: "+" | "-" | " ";
	/** 0-based line in `before` (for -/ ) or `after` (for +/ ). */
	a?: number;
	b?: number;
	text: string;
	/** 1-based line numbers in the file, old and new side (a git patch knows them). */
	oldLine?: number;
	newLine?: number;
};

/** Which side of a diff a line is on: LEFT the old file, RIGHT the new one. */
export type DiffSide = "LEFT" | "RIGHT";

/**
 * Optional per-line extras (PR review): `gutter` renders at the start of a
 * line (an "add comment" button), `after` below it across the whole diff
 * (a comment thread). Context lines are asked for both sides.
 */
export interface DiffLineExtras {
	gutter?: (r: DiffRow, side: DiffSide) => ReactNode;
	after?: (r: DiffRow, side: DiffSide) => ReactNode;
}
type Fold = { fold: number; key: string };

/** Unchanged runs longer than this fold into "N unchanged lines". */
const CONTEXT = 3;

export function diffRows(before: string, after: string) {
	const rows: DiffRow[] = [];
	let a = 0;
	let b = 0;
	let added = 0;
	let removed = 0;
	// Same line ending on both sides, so an unchanged last line isn't "changed".
	const nl = (t: string) => (t && !t.endsWith("\n") ? `${t}\n` : t);
	for (const part of diffLines(nl(before), nl(after))) {
		const lines = part.value.replace(/\n$/, "").split("\n");
		for (const text of lines) {
			if (part.added) {
				rows.push({ sign: "+", b: b++, text });
				added++;
			} else if (part.removed) {
				rows.push({ sign: "-", a: a++, text });
				removed++;
			} else rows.push({ sign: " ", a: a++, b: b++, text });
		}
	}
	return { rows, added, removed };
}

function folded(rows: DiffRow[], expanded: boolean): (DiffRow | Fold)[] {
	if (expanded) return rows;
	const out: (DiffRow | Fold)[] = [];
	let i = 0;
	while (i < rows.length) {
		if (rows[i]!.sign !== " ") {
			out.push(rows[i++]!);
			continue;
		}
		let j = i;
		while (j < rows.length && rows[j]!.sign === " ") j++;
		const run = rows.slice(i, j);
		const head = i === 0 ? 0 : CONTEXT;
		const tail = j === rows.length ? 0 : CONTEXT;
		if (run.length > head + tail + 1) {
			out.push(...run.slice(0, head));
			out.push({ fold: run.length - head - tail, key: `f${i}` });
			out.push(...run.slice(run.length - tail));
		} else out.push(...run);
		i = j;
	}
	return out;
}

const isFold = (r: DiffItem): r is Fold => "fold" in r;

function tok(r: DiffRow, A: Lines | null, B: Lines | null) {
	if (r.sign === "-" || (r.sign === " " && r.b === undefined)) return A?.[r.a!];
	return B?.[r.b!] ?? A?.[r.a!];
}

/**
 * A highlighted line diff. `layout="split"` (desktop) puts old and new side
 * by side, pairing removed lines with the added lines that replace them;
 * `layout="unified"` (phone) stacks them. Long unchanged runs fold.
 * Classes `.diff .add/.del/.ctx` stay stable for tests.
 */
export function Diff({
	before,
	after,
	lang,
	layout = "unified",
	className,
}: {
	before: string;
	after: string;
	lang: string | null;
	layout?: "split" | "unified";
	className?: string;
}) {
	const { rows } = useMemo(() => diffRows(before, after), [before, after]);
	const [expanded, setExpanded] = useState(false);
	const A = useTokens(before.replace(/\n$/, ""), before ? lang : null);
	const B = useTokens(after.replace(/\n$/, ""), lang);
	return (
		<DiffBody
			items={folded(rows, expanded)}
			A={A}
			B={B}
			layout={layout}
			className={className}
			onExpand={() => setExpanded(true)}
		/>
	);
}

/** A hunk header between the hunks of a patch ("@@ -12,7 +12,9 @@ fn"). */
export type DiffHunk = { hunk: string; key: string };
export type DiffItem = DiffRow | Fold | DiffHunk;

const isHunk = (r: DiffItem): r is DiffHunk => "hunk" in r;

/**
 * The diff renderer behind `Diff`, for rows built elsewhere (a git patch,
 * see changes/patch.ts): `a`/`b` index the old-side and new-side texts
 * that `A` and `B` highlight.
 */
export function DiffBody({
	items,
	A,
	B,
	layout = "unified",
	className,
	onExpand,
	numbers = false,
	extras,
}: {
	items: DiffItem[];
	A: Lines | null;
	B: Lines | null;
	layout?: "split" | "unified";
	className?: string;
	onExpand?: () => void;
	/** Show the file's line numbers (rows with `oldLine` / `newLine`). */
	numbers?: boolean;
	extras?: DiffLineExtras;
}) {
	const sideOf = (r: DiffRow): DiffSide => (r.sign === "-" ? "LEFT" : "RIGHT");
	const below = (r: DiffRow, sides: DiffSide[], key: string) => {
		if (!extras?.after) return null;
		const parts = sides.map((s) => extras.after!(r, s)).filter(Boolean);
		return parts.length ? (
			<div key={key} className="ds-diff-after">
				{parts}
			</div>
		) : null;
	};
	const ln = (n: number | undefined) =>
		numbers ? (
			<span className="ds-diff-ln" aria-hidden="true">
				{n ?? ""}
			</span>
		) : null;
	// A pure addition (a new file) has nothing to put on the left.
	const split =
		layout === "split" &&
		items.some((r) => !isFold(r) && !isHunk(r) && r.sign !== "+");

	const foldRow = (f: Fold) => (
		<button
			key={f.key}
			type="button"
			className="ds-diff-fold"
			onClick={onExpand}
		>
			{plural(f.fold, "unchanged line")}
		</button>
	);
	const hunkRow = (h: DiffHunk) => (
		<div key={h.key} className="ds-diff-hunk">
			{h.hunk}
		</div>
	);

	if (!split)
		return (
			<div
				className={`diff ds-diff unified${className ? ` ${className}` : ""}`}
				role="group"
				aria-label="Changes"
			>
				<div
					className="ds-diff-scroll"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
					tabIndex={0}
				>
					<div className="ds-diff-grid u">
						{items.map((r, i) =>
							isFold(r)
								? foldRow(r)
								: isHunk(r)
									? hunkRow(r)
									: [
											<div
												key={i}
												className={`ds-diff-row ${r.sign === "+" ? "add" : r.sign === "-" ? "del" : "ctx"}`}
											>
												{extras?.gutter?.(r, sideOf(r))}
												{ln(r.oldLine)}
												{ln(r.newLine)}
												<span className="sign" aria-hidden="true">
													{r.sign === " " ? "" : r.sign === "-" ? "−" : "+"}
												</span>
												<span className="ds-diff-code">
													<LineTokens tokens={tok(r, A, B)} text={r.text} />
												</span>
											</div>,
											below(
												r,
												r.sign === " " ? ["LEFT", "RIGHT"] : [sideOf(r)],
												`${i}-after`,
											),
										],
						)}
					</div>
				</div>
			</div>
		);

	// Split: walk hunks; pair the k-th removed line with the k-th added line.
	type Cell = DiffRow | null;
	const pairs: ([Cell, Cell] | Fold | DiffHunk)[] = [];
	for (let i = 0; i < items.length; ) {
		const r = items[i]!;
		if (isFold(r) || isHunk(r)) {
			pairs.push(r);
			i++;
			continue;
		}
		if (r.sign === " ") {
			pairs.push([r, r]);
			i++;
			continue;
		}
		const dels: DiffRow[] = [];
		const adds: DiffRow[] = [];
		while (i < items.length) {
			const x = items[i]!;
			if (isFold(x) || isHunk(x) || x.sign === " ") break;
			(x.sign === "-" ? dels : adds).push(x);
			i++;
		}
		for (let k = 0; k < Math.max(dels.length, adds.length); k++)
			pairs.push([dels[k] ?? null, adds[k] ?? null]);
	}
	const cell = (c: Cell, side: "a" | "b", key: string) => {
		if (!c)
			return (
				<span key={key} className="ds-diff-cell empty" aria-hidden="true" />
			);
		const cls = c.sign === "+" ? "add" : c.sign === "-" ? "del" : "ctx";
		const t =
			c.sign === " " ? (side === "a" ? A?.[c.a!] : B?.[c.b!]) : tok(c, A, B);
		return (
			<span key={key} className={`ds-diff-cell ${cls}`}>
				{/* A context line takes comments on its new side only. */}
				{c.sign === " " && side === "a"
					? null
					: extras?.gutter?.(c, side === "a" ? "LEFT" : "RIGHT")}
				{ln(side === "a" ? c.oldLine : c.newLine)}
				<span className="sign" aria-hidden="true">
					{c.sign === " " ? "" : c.sign === "-" ? "−" : "+"}
				</span>
				<span className="ds-diff-code">
					<LineTokens tokens={t} text={c.text} />
				</span>
			</span>
		);
	};
	// A pair's threads: the old side's under its line, then the new side's.
	const splitBelow = ([l, r]: [Cell, Cell], i: number) => {
		if (!extras?.after) return null;
		const parts = [
			l ? extras.after(l, "LEFT") : null,
			r ? extras.after(r, "RIGHT") : null,
		].filter(Boolean);
		return parts.length ? (
			<div key={`${i}-after`} className="ds-diff-after">
				{parts}
			</div>
		) : null;
	};
	return (
		<div
			className={`diff ds-diff split${className ? ` ${className}` : ""}`}
			role="group"
			aria-label="Changes, before and after"
		>
			<div className="ds-diff-grid s">
				{pairs.map((p, i) =>
					"fold" in p
						? foldRow(p)
						: "hunk" in p
							? hunkRow(p)
							: [
									<div key={i} className="ds-diff-pair">
										{cell(p[0], "a", "a")}
										{cell(p[1], "b", "b")}
									</div>,
									splitBelow(p, i),
								],
				)}
			</div>
		</div>
	);
}
