import type { ComponentType } from "react";
import { useEffect, useRef } from "react";
import type { TreeNode } from "../api/types.ts";
import { observer } from "../lib/signals.ts";
import { filter, loadMore, nodes, noteInteraction } from "../lib/store.ts";
import { useVirtualizer } from "../lib/virtual.ts";
import { desktopRows, focusKey, noMatch, type Row } from "./treeRows.ts";

export * from "./treeRows.ts";

export interface RowViewProps {
	row: Row;
	focused: boolean;
	onContext?: (e: React.MouseEvent, n: TreeNode) => void;
}

interface TreeProps {
	/** How a row looks (TreeDesktop), so each layout loads only its own. */
	rowView: ComponentType<RowViewProps>;
	onContext?: (e: React.MouseEvent, n: TreeNode) => void;
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
function TreeImpl({ onContext, rowView: RowView }: TreeProps) {
	const rows = desktopRows.value;
	const scrollRef = useRef<HTMLDivElement>(null);
	const v = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (i) => {
			const r = rows[i];
			return r ? desktopHeight(r, i) : D_H.row;
		},
		overscan: 12,
		getItemKey: (i) => rows[i]?.key ?? i,
	});
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
				return (
					<div
						key={it.key}
						className="vrow"
						data-index={it.index}
						style={{
							transform: `translateY(${it.start}px)`,
							height: `${it.size}px`,
						}}
					>
						<RowView row={row} focused={fk === row.key} onContext={onContext} />
					</div>
				);
			})}
		</div>
	);
	return (
		<div
			className="tree tree-desktop"
			ref={scrollRef}
			onScroll={noteInteraction}
			onTouchStart={noteInteraction}
			role="tree"
			aria-label="Machines"
		>
			{tree}
			{noMatch(rows, filter.value) && (
				<p className="d-tree-empty">Nothing matches “{filter.value}”.</p>
			)}
		</div>
	);
}

export const Tree = observer(TreeImpl);
