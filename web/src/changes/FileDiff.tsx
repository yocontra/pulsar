/**
 * One file's diff: fetched by the summary entry's key, rendered with the
 * transcript's diff renderer (session/Diff.tsx) and highlighter. Binary,
 * too-large and gone files get a placeholder instead.
 */
import { useMemo, useState } from "react";
import { ApiError } from "../api/client.ts";
import type { ChangedFile, ChangesMode } from "../api/types.ts";
import { DiffBody, type DiffRow, type DiffSide } from "../session/Diff.tsx";
import { langForPath, useTokens } from "../session/highlight.tsx";
import { useChangeFile } from "./data.ts";
import { parsePatch } from "./patch.ts";
import { ReviewLines } from "./ReviewLines.tsx";

export function PatchView({
	agentId,
	oldPath,
	mode,
	patch,
	path,
	layout,
}: {
	agentId: string;
	oldPath?: string;
	mode: ChangesMode;
	patch: string;
	path: string;
	layout: "split" | "unified";
}) {
	const p = useMemo(() => parsePatch(patch), [patch]);
	const lang = langForPath(path);
	const A = useTokens(p.before, p.before ? lang : null);
	const B = useTokens(p.after, p.after ? lang : null);
	const [selection, select] = useState<{
		side: DiffSide;
		at: number;
		first: number;
		lines: string[];
	} | null>(null);
	function pick(row: DiffRow, side: DiffSide) {
		const prop = side === "LEFT" ? "oldLine" : "newLine";
		const at = row[prop];
		if (!at) return;
		const index = p.items.indexOf(row);
		let start = index,
			stop = index + 1;
		while (start > 0 && "sign" in p.items[start - 1]!) start--;
		while (stop < p.items.length && "sign" in p.items[stop]!) stop++;
		const rows = (p.items.slice(start, stop) as DiffRow[]).filter(
			(r) => r[prop] !== undefined,
		);
		select({
			side,
			at,
			first: rows[0]![prop]!,
			lines: rows.map((r) => r.text),
		});
	}
	return (
		<>
			{p.notes.length > 0 && <p className="cv-notes">{p.notes.join(" · ")}</p>}
			{selection && (
				<ReviewLines
					key={selection.side + selection.at}
					agentId={agentId}
					path={selection.side === "LEFT" ? (oldPath ?? path) : path}
					source={`${mode === "base" ? "branch vs base" : "working tree"}, ${selection.side === "LEFT" ? "before" : "after"}`}
					{...selection}
					onClose={() => select(null)}
				/>
			)}
			{p.hunks > 0 ? (
				<DiffBody
					items={p.items}
					A={A}
					B={B}
					layout={layout}
					className="cv-diff"
					extras={{
						bothContextGutters: true,
						gutter: (row, side) => {
							const n = side === "LEFT" ? row.oldLine : row.newLine;
							return (
								<button
									type="button"
									className="review-ln"
									aria-label={`Review ${side === "LEFT" ? "old" : "new"} line ${n}`}
									title="Review line"
									onClick={() => pick(row, side)}
								>
									{n}
								</button>
							);
						},
					}}
				/>
			) : (
				p.notes.length === 0 && <p className="cv-placeholder">Empty file</p>
			)}
		</>
	);
}

export function FileDiff({
	agentId,
	mode,
	file,
	layout,
	enabled = true,
}: {
	agentId: string;
	mode: ChangesMode;
	file: ChangedFile;
	layout: "split" | "unified";
	/** False until the file scrolls into view (Expand all). */
	enabled?: boolean;
}) {
	const q = useChangeFile(agentId, mode, file, enabled);
	if (file.binary)
		return <p className="cv-placeholder">Binary file, not shown.</p>;
	const d = q.data;
	if (d?.binary)
		return <p className="cv-placeholder">Binary file, not shown.</p>;
	if (d?.tooLarge)
		return (
			<p className="cv-placeholder">
				This diff is over 512 KB. Open the file in your editor to see it.
			</p>
		);
	if (d?.patch != null)
		return (
			<PatchView
				key={file.key + mode}
				agentId={agentId}
				mode={mode}
				oldPath={file.oldPath}
				patch={d.patch}
				path={file.path}
				layout={layout}
			/>
		);
	if (q.error)
		return (
			<p className="cv-placeholder" role="status">
				{q.error instanceof ApiError && q.error.code === "not_found"
					? "This file has no changes any more."
					: "Couldn't load this diff."}
			</p>
		);
	if (d && d.patch === null)
		return <p className="cv-placeholder">Nothing to show.</p>;
	return (
		<div className="cv-loading" aria-busy="true">
			<span className="cv-sr">Loading diff</span>
		</div>
	);
}
