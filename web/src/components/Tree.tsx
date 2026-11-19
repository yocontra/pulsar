import type { ComponentType } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TreeNode } from "../api/types.ts";
import { observer } from "../lib/signals.ts";
import { filter, loadMore, nodes, noteInteraction } from "../lib/store.ts";
import { useVirtualizer } from "../lib/virtual.ts";
import {
	desktopRows,
	focusKey,
	mobileRows,
	noMatch,
	type Row,
} from "./treeRows.ts";

export * from "./treeRows.ts";

export interface RowViewProps {
	row: Row;
	focused: boolean;
	onContext?: (e: React.MouseEvent, n: TreeNode) => void;
}

interface TreeProps {
	mobile: boolean;
	/** How a row looks (TreeDesktop), so each layout loads only its own. */
	rowView: ComponentType<RowViewProps>;
	onContext?: (e: React.MouseEvent, n: TreeNode) => void;
	/** Rendered above the rows inside the scroller (mobile pull-to-refresh). */
	header?: React.ReactNode;
}

/**
 * Desktop row heights (px). Fixed so the virtualizer never measures and the
 * sidebar skeleton (ShellSkeleton, TreeDesktop) matches the loaded rows to
 * the pixel.
 */
export const D_H = {
	section: 40,
	sectionFirst: 26,
	node: 32,
	agent: 50,
	attn: 50,
	row: 32,
	sub: 44,
};

function desktopHeight(r: Row, i: number) {
	switch (r.t) {
		case "section":
			return i === 0 ? D_H.sectionFirst : D_H.section;
		case "attn":
			return D_H.attn;
		case "node":
			return nodes.get(r.id)?.kind === "agent" ? D_H.agent : D_H.node;
		case "sub":
			return D_H.sub;
		default:
			return D_H.row;
	}
}
/** Phone row heights at the default text size (17px); they scale with Dynamic Type. */
const M_H = {
	section: 50,
	sectionFirst: 38,
	attn: 82,
	node: 56,
	agent: 64,
	row: 48,
};

/** Rows that sit together in one inset-grouped section. */
const grouped = (r?: Row) => !!r && r.t !== "section" && r.t !== "attn";

/** Text-size factor: the root font size against the default 17px. */
function textScale() {
	const px = Number.parseFloat(
		getComputedStyle(document.documentElement).fontSize,
	);
	return Math.max(1, (px || 17) / 17);
}

function mobileHeight(r: Row, i: number, k: number) {
	switch (r.t) {
		case "section":
			return Math.round((i === 0 ? M_H.sectionFirst : M_H.section) * k);
		case "attn":
			return Math.round(M_H.attn * k);
		case "node":
			return Math.round(
				(nodes.get(r.id)?.kind === "agent" ? M_H.agent : M_H.node) * k,
			);
		default:
			return Math.round(M_H.row * k);
	}
}

function TreeImpl({ mobile, onContext, header, rowView: RowView }: TreeProps) {
	const rows = mobile ? mobileRows.value : desktopRows.value;
	const scrollRef = useRef<HTMLDivElement>(null);
	const headRef = useRef<HTMLDivElement>(null);
	const [margin, setMargin] = useState(0);
	// Re-read on resize too: a text-size change resizes the header.
	const [k, setK] = useState(() => (mobile ? textScale() : 1));
	// The header (large title, search) scrolls with the rows: offset them by its height.
	useLayoutEffect(() => {
		const el = headRef.current;
		if (!el) return;
		setMargin(el.offsetHeight);
		const ro = new ResizeObserver(() => {
			setMargin(el.offsetHeight);
			if (mobile) setK(textScale());
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [!!header]);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (i) => {
			const r = rows[i];
			if (!r) return D_H.row;
			if (mobile) return mobileHeight(r, i, k);
			return desktopHeight(r, i);
		},
		overscan: mobile ? 6 : 12,
		getItemKey: (i) => rows[i]?.key ?? i,
		scrollMargin: margin,
	});
	useEffect(() => v.measure(), [k]);
	const items = v.getVirtualItems();

	// Load the next page of machines when its "more" row scrolls into view.
	const lastIdx = items[items.length - 1]?.index ?? -1;
	useEffect(() => {
		for (const it of items) {
			const r = rows[it.index];
			if (r?.t === "more" && r.branch === "" && !r.loading) void loadMore("");
		}
	}, [lastIdx, rows.length]);

	// Keep the keyboard focus in view.
	const fk = focusKey.value;
	useEffect(() => {
		if (!fk) return;
		const i = rows.findIndex((r) => r.key === fk);
		if (i >= 0) v.scrollToIndex(i, { align: "auto" });
	}, [fk]);

	const tree = (
		<div className="tree-inner" style={{ height: `${v.getTotalSize()}px` }}>
			{items.map((it) => {
				const row = rows[it.index];
				if (!row) return null;
				// Inset-grouped corners: first and last row of each section.
				const pos = mobile
					? `${grouped(row) && !grouped(rows[it.index - 1]) ? " gf" : ""}${grouped(row) && !grouped(rows[it.index + 1]) ? " gl" : ""}`
					: "";
				return (
					<div
						key={it.key}
						className={`vrow${pos}`}
						data-index={it.index}
						style={{
							transform: `translateY(${it.start - margin}px)`,
							height: `${it.size}px`,
						}}
					>
						<RowView row={row} focused={fk === row.key} onContext={onContext} />
					</div>
				);
			})}
		</div>
	);
	if (header)
		return (
			<div
				className="tree tree-mobile m-scroll"
				ref={scrollRef}
				onScroll={noteInteraction}
				onTouchStart={noteInteraction}
				data-ptr
			>
				<div ref={headRef}>{header}</div>
				<div role="tree" aria-label="Machines">
					{tree}
				</div>
			</div>
		);
	return (
		<div
			className={`tree ${mobile ? "tree-mobile" : "tree-desktop"}`}
			ref={scrollRef}
			onScroll={noteInteraction}
			onTouchStart={noteInteraction}
			role="tree"
			aria-label="Machines"
		>
			{tree}
			{!mobile && noMatch(rows, filter.value) && (
				<p className="d-tree-empty">Nothing matches “{filter.value}”.</p>
			)}
		</div>
	);
}

export const Tree = observer(TreeImpl);
