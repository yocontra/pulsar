/**
 * The end-of-turn summary: "Changed 3 files +42 −7", which opens to the
 * files with their +/−. A file opens its own diff; "Show all diffs" opens
 * every file's diff, one after the other (the turn's combined diff). Built
 * from the turn's edit calls (turn-changes.ts), so nothing is fetched.
 */
import { ChevronRightIcon, FileDiffIcon } from "lucide-react";
import { lazy, memo, Suspense, useState } from "react";
import { plural } from "../lib/format.ts";
import { DiffBody } from "./Diff.tsx";
import { langForPath, useTokens } from "./highlight.tsx";
import type { TurnChanges as Changes, TurnFile } from "./turn-changes.ts";
import "./turn-changes.css";

// Reads the page registry and the router, which the renderer itself must not load.
const OpenFile = lazy(() =>
	import("./TurnFileLink.tsx").then((m) => ({ default: m.TurnFileLink })),
);

const LETTER: Record<TurnFile["status"], string> = {
	added: "A",
	modified: "M",
	written: "W",
	deleted: "D",
	moved: "R",
};
const LABEL: Record<TurnFile["status"], string> = {
	added: "Added",
	modified: "Modified",
	written: "Written",
	deleted: "Deleted",
	moved: "Moved",
};

function Stat({ added, removed }: { added: number; removed: number }) {
	return (
		<span className="ds-diffstat">
			<span className="add">+{added}</span>
			<span className="del">−{removed}</span>
		</span>
	);
}

/** Rows drawn before "Show N more lines" (a long Write is all additions). */
const ROWS = 400;

function FileDiffView({
	file,
	layout,
}: {
	file: TurnFile;
	layout: "split" | "unified";
}) {
	const lang = langForPath(file.path);
	const A = useTokens(file.before, file.before ? lang : null);
	const B = useTokens(file.after, file.after ? lang : null);
	const [full, setFull] = useState(false);
	if (!file.items.length)
		return (
			<p className="ds-turnchg-note">
				{file.status === "deleted"
					? "The file was deleted."
					: "No lines to show."}
			</p>
		);
	const more = full ? 0 : file.items.length - ROWS;
	return (
		<>
			<DiffBody
				items={more > 0 ? file.items.slice(0, ROWS) : file.items}
				A={A}
				B={B}
				layout={layout}
				className="ds-turnchg-diff"
			/>
			{more > 0 && (
				<button
					type="button"
					className="ds-turnchg-more"
					onClick={() => setFull(true)}
				>
					Show {plural(more, "more line")}
				</button>
			)}
		</>
	);
}

export const TurnChanges = memo(function TurnChanges({
	changes,
	layout,
	agentId,
}: {
	changes: Changes;
	layout: "split" | "unified";
	/** Set in the app: each file links to the file viewer when there is one. */
	agentId?: string;
}) {
	const [open, setOpen] = useState(false);
	const [shown, setShown] = useState<ReadonlySet<string>>(() => new Set());
	const n = changes.files.length;
	const all = shown.size === n;
	const toggle = (key: string) =>
		setShown((s) => {
			const next = new Set(s);
			if (!next.delete(key)) next.add(key);
			return next;
		});
	return (
		<section
			className="ds-turnchg"
			data-state={open ? "open" : "closed"}
			data-turn-changes={n}
			aria-label="Files changed in this turn"
		>
			<button
				type="button"
				className="ds-turnchg-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
			>
				<span className="ds-tool-icon" aria-hidden="true">
					<FileDiffIcon />
				</span>
				<span className="ds-turnchg-title">Changed {plural(n, "file")}</span>
				<Stat added={changes.added} removed={changes.removed} />
				<ChevronRightIcon className="ds-tool-chev" aria-hidden="true" />
			</button>
			{open && (
				<div className="ds-turnchg-body">
					<div className="ds-turnchg-bar">
						<button
							type="button"
							className="ds-turnchg-all"
							aria-pressed={all}
							onClick={() =>
								setShown(
									all ? new Set() : new Set(changes.files.map((f) => f.key)),
								)
							}
						>
							{all ? "Hide all diffs" : "Show all diffs"}
						</button>
					</div>
					<ul className="ds-turnchg-files">
						{changes.files.map((f) => {
							const on = shown.has(f.key);
							const slash = f.path.lastIndexOf("/");
							return (
								<li key={f.key} className="ds-turnchg-item" data-path={f.path}>
									<div className="ds-turnchg-row">
										<button
											type="button"
											className="ds-turnchg-file"
											aria-expanded={on}
											onClick={() => toggle(f.key)}
										>
											<ChevronRightIcon
												className="ds-tool-chev"
												aria-hidden="true"
											/>
											<span
												className={`ds-turnchg-st st-${f.status}`}
												title={LABEL[f.status]}
											>
												{LETTER[f.status]}
												<span className="sr-only"> {LABEL[f.status]}</span>
											</span>
											<span className="ds-turnchg-name" title={f.path}>
												{f.path.slice(slash + 1)}
											</span>
											<span className="ds-turnchg-dir">
												{f.from
													? `from ${f.from}`
													: slash > 0
														? f.path.slice(0, slash)
														: ""}
											</span>
											<Stat added={f.added} removed={f.removed} />
										</button>
										{agentId && f.status !== "deleted" && (
											<Suspense fallback={null}>
												<OpenFile agentId={agentId} path={f.path} />
											</Suspense>
										)}
									</div>
									{on && <FileDiffView file={f} layout={layout} />}
								</li>
							);
						})}
					</ul>
				</div>
			)}
		</section>
	);
});
