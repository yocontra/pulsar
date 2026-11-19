/**
 * One file's diff: fetched by the summary entry's key, rendered with the
 * transcript's diff renderer (session/Diff.tsx) and highlighter. Binary,
 * too-large and gone files get a placeholder instead.
 */
import { useMemo } from "react";
import { ApiError } from "../api/client.ts";
import type { ChangedFile, ChangesMode } from "../api/types.ts";
import { DiffBody } from "../session/Diff.tsx";
import { langForPath, useTokens } from "../session/highlight.tsx";
import { useChangeFile } from "./data.ts";
import { parsePatch } from "./patch.ts";

export function PatchView({
	patch,
	path,
	layout,
}: {
	patch: string;
	path: string;
	layout: "split" | "unified";
}) {
	const p = useMemo(() => parsePatch(patch), [patch]);
	const lang = langForPath(path);
	const A = useTokens(p.before, p.before ? lang : null);
	const B = useTokens(p.after, p.after ? lang : null);
	return (
		<>
			{p.notes.length > 0 && <p className="cv-notes">{p.notes.join(" · ")}</p>}
			{p.hunks > 0 ? (
				<DiffBody
					items={p.items}
					A={A}
					B={B}
					layout={layout}
					className="cv-diff"
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
		return <PatchView patch={d.patch} path={file.path} layout={layout} />;
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
