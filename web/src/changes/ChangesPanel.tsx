/**
 * The desktop changes panel: what the agent's worktree has dirty (or what
 * its branch changed since the default branch), live. Files on top, the
 * selected file's diff below (side by side when the panel is wide), or every
 * file's diff with "Expand all" (each loads as it scrolls into view).
 */
import {
	ChevronDownIcon,
	ChevronUpIcon,
	FoldVerticalIcon,
	GitBranchIcon,
	UnfoldVerticalIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChangedFile, ChangesSummary } from "../api/types.ts";
import { observer } from "../lib/signals.ts";
import { useChanges } from "./data.ts";
import { FileDiff } from "./FileDiff.tsx";
import { Counts, Dir, FileList, StatusMark } from "./FileList.tsx";
import { MODE_LABEL, splitPath, unavailableText } from "./model.ts";
import { changesMode, SHORTCUT_LABEL, setChangesMode } from "./panel-state.ts";

/** Side by side from this panel width. */
const SPLIT_FROM = 860;

function useWidth(ref: React.RefObject<HTMLElement | null>): number {
	const [w, setW] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver((entries) => {
			const e = entries[0];
			if (e) setW(e.contentRect.width);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [ref]);
	return w;
}

function BranchLine({ s }: { s: ChangesSummary }) {
	return (
		<p className="cv-branch">
			<GitBranchIcon aria-hidden="true" />
			<span className="cv-repo">{s.repo}</span>
			<span className="cv-sep" aria-hidden="true">
				/
			</span>
			<span className="cv-ref">
				{s.branch ??
					(s.head ? `detached at ${s.head.slice(0, 7)}` : "no commits yet")}
			</span>
			{s.upstream && (s.upstream.ahead > 0 || s.upstream.behind > 0) && (
				<span
					className="cv-ab"
					title={`${s.upstream.ahead} ahead, ${s.upstream.behind} behind ${s.upstream.ref}`}
				>
					{s.upstream.ahead > 0 && `↑${s.upstream.ahead}`}
					{s.upstream.behind > 0 && ` ↓${s.upstream.behind}`}
				</span>
			)}
		</p>
	);
}

/** Expand all: one section per file; its diff loads once it nears the view. */
function ExpandedFile({
	agentId,
	mode,
	file,
	layout,
	root,
	current,
}: {
	agentId: string;
	mode: "worktree" | "base";
	file: ChangedFile;
	layout: "split" | "unified";
	root: React.RefObject<HTMLElement | null>;
	current: boolean;
}) {
	const ref = useRef<HTMLElement>(null);
	const [seen, setSeen] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el || seen) return;
		if (typeof IntersectionObserver === "undefined") {
			setSeen(true);
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) setSeen(true);
			},
			{ root: root.current, rootMargin: "600px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [seen, root]);
	const { dir, name } = splitPath(file.path);
	return (
		<section
			ref={ref}
			className={`cv-section${current ? " current" : ""}`}
			data-path={file.path}
			aria-label={file.path}
		>
			<h3 className="cv-section-head">
				<StatusMark file={file} />
				<span className="cv-name">
					<span className="cv-base">{name}</span>
					<Dir dir={dir} />
				</span>
				<Counts file={file} />
			</h3>
			<FileDiff
				agentId={agentId}
				mode={mode}
				file={file}
				layout={layout}
				enabled={seen}
			/>
		</section>
	);
}

function ChangesPanelImpl({
	id,
	file: wanted,
	onClose,
}: {
	id: string;
	file: string | null;
	onClose: () => void;
}) {
	const mode = changesMode.value;
	const q = useChanges(id, mode);
	const s = q.data?.agent === id && q.data.mode === mode ? q.data : undefined;
	const files = s?.files ?? [];
	const [selected, setSelected] = useState<string | null>(wanted);
	const [expandAll, setExpandAll] = useState(false);
	const panel = useRef<HTMLElement>(null);
	const body = useRef<HTMLDivElement>(null);
	const width = useWidth(panel);
	const layout = width >= SPLIT_FROM ? "split" : "unified";

	useEffect(() => {
		if (wanted) setSelected(wanted);
	}, [wanted]);
	// Keep a selection: the first file, or the one after a file that went away.
	const index = files.findIndex((f) => f.path === selected);
	const current: ChangedFile | null =
		index >= 0 ? files[index]! : (files[0] ?? null);
	useEffect(() => {
		if (!files.length || index >= 0 || selected === null) return;
		// Files are sorted by path: the one after the file that went away.
		setSelected((files.find((f) => f.path > selected) ?? files.at(-1)!).path);
	}, [files, index, selected]);

	// Expand all starts at the selected file.
	useEffect(() => {
		if (!expandAll || !selected) return;
		body.current
			?.querySelector<HTMLElement>(`[data-path="${CSS.escape(selected)}"]`)
			?.scrollIntoView({ block: "start" });
	}, [expandAll]);

	const pick = (f: ChangedFile) => {
		setSelected(f.path);
		if (expandAll)
			body.current
				?.querySelector<HTMLElement>(`[data-path="${CSS.escape(f.path)}"]`)
				?.scrollIntoView({ block: "start" });
		else body.current?.scrollTo({ top: 0 });
	};
	const step = (d: 1 | -1) => {
		if (!files.length) return;
		const i = current ? files.indexOf(current) : -1;
		const f = files[Math.min(files.length - 1, Math.max(0, i + d))]!;
		pick(f);
		panel.current
			?.querySelector<HTMLElement>(
				`.cv-file[data-path="${CSS.escape(f.path)}"]`,
			)
			?.scrollIntoView({ block: "nearest" });
	};

	const title = useMemo(() => {
		if (!s?.available) return "";
		if (s.total === 0)
			return mode === "base" && s.base
				? `No changes on ${s.branch ?? "this branch"} since ${s.base.ref}`
				: `No changes in ${s.branch ?? "this worktree"}`;
		return "";
	}, [s, mode]);

	return (
		<aside
			ref={panel}
			className="cv-panel"
			aria-label="Changes"
			onKeyDown={(e) => {
				const t = e.target as HTMLElement;
				if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
				if (e.key === "]") {
					e.preventDefault();
					step(1);
				} else if (e.key === "[") {
					e.preventDefault();
					step(-1);
				}
			}}
		>
			<header className="cv-head">
				<div className="cv-head-row">
					<h2 className="cv-title">
						Changes
						{s?.available && s.total > 0 && (
							<span className="cv-total">
								{s.total} {s.total === 1 ? "file" : "files"}
								<span className="add">+{s.added}</span>
								<span className="del">−{s.removed}</span>
							</span>
						)}
					</h2>
					<button
						type="button"
						className="d-btn sm icon"
						aria-label="Close changes"
						title={`Close (${SHORTCUT_LABEL})`}
						onClick={onClose}
					>
						<XIcon aria-hidden="true" />
					</button>
				</div>
				{s?.repo && <BranchLine s={s} />}
				<div className="cv-head-row cv-tools">
					<div className="cv-modes" role="radiogroup" aria-label="Compare">
						{(["worktree", "base"] as const).map((m) => (
							<button
								key={m}
								type="button"
								role="radio"
								aria-checked={mode === m}
								className={`cv-mode${mode === m ? " on" : ""}`}
								title={
									m === "base"
										? `What the branch changed since ${s?.base?.ref ?? "the default branch"}, plus uncommitted work`
										: "Staged, unstaged and untracked changes since the last commit"
								}
								onClick={() => setChangesMode(m)}
							>
								{MODE_LABEL[m]}
								{m === "base" && s?.base && s.base.ahead > 0 && (
									<span className="cv-mode-n">{s.base.ahead}</span>
								)}
							</button>
						))}
					</div>
					<span className="cv-spacer" />
					<button
						type="button"
						className="d-btn sm icon"
						aria-label="Previous file"
						title="Previous file ( [ )"
						disabled={!files.length}
						onClick={() => step(-1)}
					>
						<ChevronUpIcon aria-hidden="true" />
					</button>
					<button
						type="button"
						className="d-btn sm icon"
						aria-label="Next file"
						title="Next file ( ] )"
						disabled={!files.length}
						onClick={() => step(1)}
					>
						<ChevronDownIcon aria-hidden="true" />
					</button>
					<button
						type="button"
						className="d-btn sm"
						aria-pressed={expandAll}
						disabled={!files.length}
						onClick={() => setExpandAll((v) => !v)}
					>
						{expandAll ? (
							<FoldVerticalIcon aria-hidden="true" />
						) : (
							<UnfoldVerticalIcon aria-hidden="true" />
						)}
						{expandAll ? "Collapse" : "Expand all"}
					</button>
				</div>
			</header>
			{!s && q.isError && (
				<p className="cv-empty" role="alert">
					Couldn't read this agent's changes.{" "}
					<button type="button" className="link" onClick={() => q.refetch()}>
						Retry
					</button>
				</p>
			)}
			{!s && !q.isError && (
				<div className="cv-loading" aria-busy="true">
					<span className="cv-sr">Loading changes</span>
				</div>
			)}
			{s && !s.available && (
				<p className="cv-empty" role="status">
					{unavailableText(s)}
				</p>
			)}
			{s?.available && s.total === 0 && (
				<p className="cv-empty" role="status">
					{title}
				</p>
			)}
			{s?.available && files.length > 0 && (
				<>
					<div className="cv-list">
						<FileList
							files={files}
							selected={current?.path ?? null}
							onSelect={pick}
							label="Changed files"
						/>
						{s.truncated && (
							<p className="cv-more">
								Showing {files.length} of {s.total} files.
							</p>
						)}
					</div>
					<div
						ref={body}
						role="region"
						className="cv-body"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be keyboard-reachable
						tabIndex={0}
						aria-label={
							expandAll ? "Every file's diff" : `Diff of ${current?.path ?? ""}`
						}
					>
						{expandAll
							? files.map((f) => (
									<ExpandedFile
										key={f.path}
										agentId={id}
										mode={mode}
										file={f}
										layout={layout}
										root={body}
										current={f.path === current?.path}
									/>
								))
							: current && (
									<>
										<h3 className="cv-section-head sticky">
											<StatusMark file={current} />
											<span className="cv-name">
												<span className="cv-base">{current.path}</span>
												{current.oldPath && (
													<span className="cv-dir">from {current.oldPath}</span>
												)}
											</span>
											<Counts file={current} />
										</h3>
										<FileDiff
											key={current.path}
											agentId={id}
											mode={mode}
											file={current}
											layout={layout}
										/>
									</>
								)}
					</div>
				</>
			)}
		</aside>
	);
}

export default observer(ChangesPanelImpl);
