/**
 * The desktop PR review page (`#/pr/<agent>`): the PR's head line, a
 * "Submit review" popover, and tabs Summary / Files / Checks. Files lists
 * the changed files on the left and every file's diff on the right, with
 * review threads at their lines and a comment button on each line.
 */
import { ArrowLeftIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { AgentRow, GitPrReview } from "../../api/types.ts";
import { Counts, FileList, StatusMark } from "../../changes/FileList.tsx";
import { splitPath } from "../../changes/model.ts";
import type { PageProps } from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { findAgent } from "../../lib/store.ts";
import { checksSummary } from "../git/PrCard.tsx";
import { asChanged, openThreads, useReview } from "./data.ts";
import {
	Checks,
	FileReview,
	noPrText,
	PrHead,
	ReviewForm,
	Summary,
} from "./Review.tsx";
import "../../changes/changes.css";
import "../git/git.css";
import "./prreview.css";

type Tab = "summary" | "files" | "checks";
const TABS: Tab[] = ["summary", "files", "checks"];

/** Renders its children once it scrolls near the viewport (many files). */
function WhenNear({ children }: { children: ReactNode }) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [near, setNear] = useState(false);
	useEffect(() => {
		const el = ref.current;
		if (!el || near) return;
		const io = new IntersectionObserver(
			(es) => {
				if (es.some((e) => e.isIntersecting)) setNear(true);
			},
			{ rootMargin: "600px 0px" },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [near]);
	return (
		<div ref={ref} className={near ? undefined : "prv-later"}>
			{near ? children : null}
		</div>
	);
}

function Files({ agent, r }: { agent: AgentRow; r: GitPrReview }) {
	const [layout, setLayout] = useState<"split" | "unified">("split");
	const [current, setCurrent] = useState<string | null>(null);
	const pane = useRef<HTMLDivElement | null>(null);
	if (r.files.length === 0)
		return <p className="prv-empty">{r.message ?? "No files changed."}</p>;
	return (
		<div className="prv-files">
			<nav className="prv-files-nav" aria-label="Files">
				<FileList
					files={r.files.map(asChanged)}
					label="Changed files"
					selected={current}
					onSelect={(f) => {
						setCurrent(f.path);
						pane.current
							?.querySelector(`[data-file="${CSS.escape(f.path)}"]`)
							?.scrollIntoView({ block: "start" });
					}}
				/>
				{r.truncated && (
					<p className="cv-more">Showing the first {r.files.length} files.</p>
				)}
			</nav>
			<div className="prv-files-main" ref={pane}>
				<div className="prv-files-bar">
					<div className="cv-modes" role="radiogroup" aria-label="Layout">
						{(["split", "unified"] as const).map((l) => (
							<button
								key={l}
								type="button"
								role="radio"
								aria-checked={layout === l}
								className={`cv-mode${layout === l ? " on" : ""}`}
								onClick={() => setLayout(l)}
							>
								{l === "split" ? "Split" : "Unified"}
							</button>
						))}
					</div>
				</div>
				{r.files.map((f) => {
					const { dir, name } = splitPath(f.path);
					const open = openThreads(r.threads, f.path);
					return (
						<section
							key={f.path}
							className="prv-file"
							data-file={f.path}
							aria-label={f.path}
						>
							<h3 className="prv-file-head">
								<StatusMark file={asChanged(f)} />
								<span className="cv-name">
									<span className="cv-base">{name}</span>
									{f.oldPath ? (
										<span className="cv-dir">from {f.oldPath}</span>
									) : (
										dir && (
											<span className="cv-dir">{dir.replace(/\/$/, "")}</span>
										)
									)}
								</span>
								{open > 0 && <span className="prv-open">{open} open</span>}
								<Counts file={asChanged(f)} />
							</h3>
							<WhenNear>
								<FileReview
									agent={agent}
									r={r}
									file={f}
									layout={layout}
									mobile={false}
								/>
							</WhenNear>
						</section>
					);
				})}
			</div>
		</div>
	);
}

function SubmitReview({ agent, r }: { agent: AgentRow; r: GitPrReview }) {
	const [open, setOpen] = useState(false);
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button type="button" className="d-btn primary sm">
					Submit review
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="g-pop prv-pop"
					align="end"
					sideOffset={6}
					aria-label="Submit review"
				>
					{open && (
						<ReviewForm
							agentId={agent.id}
							r={r}
							mobile={false}
							onDone={() => setOpen(false)}
						/>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

function ReviewDesktopImpl({ arg, params }: PageProps) {
	const agent = findAgent(arg);
	const q = useReview(arg);
	const r = q.data;
	const [tab, setTab] = useState<Tab>(
		TABS.includes(params.t as Tab) ? (params.t as Tab) : "summary",
	);
	const back = (
		<button
			type="button"
			className="d-btn ghost sm"
			onClick={() => navigate({ view: "agent", id: arg })}
		>
			<ArrowLeftIcon aria-hidden="true" />
			{agent?.name ?? "Back"}
		</button>
	);
	if (!agent || !r?.pr)
		return (
			<main className="prv-page" aria-label="Pull request review">
				<header className="prv-head">{back}</header>
				<p className="prv-empty" role="status">
					{agent ? noPrText(r, q.error) : "This agent is gone."}
				</p>
			</main>
		);
	const open = openThreads(r.threads);
	const sum = checksSummary(r.checks);
	const label: Record<Tab, ReactNode> = {
		summary: "Summary",
		files: (
			<>
				Files <span className="prv-count">{r.files.length}</span>
				{open > 0 && <span className="prv-count warn">{open} open</span>}
			</>
		),
		checks: (
			<>
				Checks <span className={`g-sum ${sum.tone}`}>{sum.text}</span>
			</>
		),
	};
	return (
		<main className="prv-page" aria-label="Pull request review">
			<header className="prv-head">
				{back}
				<PrHead r={r} />
				<SubmitReview agent={agent} r={r} />
			</header>
			<div className="prv-tabs" role="tablist" aria-label="Review">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						id={`prv-tab-${t}`}
						aria-selected={tab === t}
						aria-controls="prv-panel"
						className={`prv-tab${tab === t ? " on" : ""}`}
						onClick={() => setTab(t)}
					>
						{label[t]}
					</button>
				))}
			</div>
			<section
				id="prv-panel"
				role="tabpanel"
				aria-labelledby={`prv-tab-${tab}`}
				className={`prv-panel ${tab}`}
			>
				{tab === "summary" && <Summary r={r} onFiles={() => setTab("files")} />}
				{tab === "files" && <Files agent={agent} r={r} />}
				{tab === "checks" && <Checks checks={r.checks} />}
			</section>
		</main>
	);
}

export default observer(ReviewDesktopImpl);
