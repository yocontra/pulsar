/**
 * The phone's PR review pages: the PR (`#/pr/<agent>`) with tabs Summary /
 * Files / Checks, and one file (`#/pr/<agent>?f=<path>`), pushed on top,
 * with its threads and a comment button on each line. "Review" in the top
 * bar opens the review form in a sheet.
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import type { AgentRow, GitPrReview } from "../../api/types.ts";
import { Counts, FileList, StatusMark } from "../../changes/FileList.tsx";
import { splitPath } from "../../changes/model.ts";
import { CloseX } from "../../components/CloseX.tsx";
import type { PageProps } from "../../lib/registry.tsx";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { findAgent } from "../../lib/store.ts";
import { BackButton } from "../../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../../mobile/ionic.ts";
import { useIonicLazy } from "../../mobile/lazyIonic.ts";
import { checksSummary } from "../git/PrCard.tsx";
import { asChanged, openThreads, useReview } from "./data.ts";
import {
	Checks,
	FileReview,
	noPrText,
	PrHead,
	ReviewForm,
	Summary,
	ThreadsTruncated,
} from "./Review.tsx";
import "../../changes/changes.css";
import "../git/git.css";
import "./prreview.css";

type Tab = "summary" | "files" | "checks";
const TABS: Tab[] = ["summary", "files", "checks"];
const TAB_LABEL: Record<Tab, string> = {
	summary: "Summary",
	files: "Files",
	checks: "Checks",
};

function ReviewSheet({
	agent,
	r,
	open,
	onClose,
}: {
	agent: AgentRow;
	r: GitPrReview;
	open: boolean;
	onClose: () => void;
}) {
	const lz = useIonicLazy();
	if (!lz) return null;
	return createPortal(
		<lz.IonModal
			className="g-modal"
			isOpen={open}
			aria-label="Submit review"
			breakpoints={[0, 1]}
			initialBreakpoint={1}
			handle={false}
			onIonModalDidDismiss={onClose}
		>
			<IonContent className="p-sheet-content" scrollY={false}>
				<div className="g-sheet">
					<header className="m-sheet-head">
						<span />
						<h2>Submit review</h2>
						<CloseX onClick={onClose} />
					</header>
					<div className="m-sheet-scroll">
						<div className="g-sheet-body">
							{open && (
								<ReviewForm agentId={agent.id} r={r} mobile onDone={onClose} />
							)}
						</div>
					</div>
				</div>
			</IonContent>
		</lz.IonModal>,
		document.querySelector("ion-app") ?? document.body,
	);
}

function Overview({
	agent,
	r,
	tab,
	setTab,
	onReview,
}: {
	agent: AgentRow;
	r: GitPrReview;
	tab: Tab;
	setTab: (t: Tab) => void;
	onReview: () => void;
}) {
	const open = openThreads(r.threads);
	const sum = checksSummary(r.checks);
	return (
		<div className="prv-phone">
			<PrHead r={r} />
			{/* In the page, not the top bar (it has no room for more buttons). */}
			<button type="button" className="m-btn wide" onClick={onReview}>
				Submit review
			</button>
			<div className="cv-modes prv-seg" role="tablist" aria-label="Review">
				{TABS.map((t) => (
					<button
						key={t}
						type="button"
						role="tab"
						aria-selected={tab === t}
						className={`cv-mode${tab === t ? " on" : ""}`}
						onClick={() => setTab(t)}
					>
						{TAB_LABEL[t]}
					</button>
				))}
			</div>
			<div role="tabpanel" aria-label={TAB_LABEL[tab]} className="prv-panel">
				{tab === "summary" && <Summary r={r} onFiles={() => setTab("files")} />}
				{tab === "files" &&
					(r.files.length === 0 ? (
						<p className="prv-empty">{r.message ?? "No files changed."}</p>
					) : (
						<>
							<ThreadsTruncated r={r} />
							{(open > 0 || r.threadsTruncated) && (
								<p className="prv-note">
									{open}
									{r.threadsTruncated ? "+" : ""} open{" "}
									{open === 1 && !r.threadsTruncated ? "thread" : "threads"}
								</p>
							)}
							<FileList
								files={r.files.map(asChanged)}
								label="Changed files"
								onSelect={(f) =>
									navigate({
										view: "page",
										name: "pr",
										arg: agent.id,
										params: { f: f.path },
									})
								}
							/>
						</>
					))}
				{tab === "checks" && (
					<>
						<p className={`g-sum ${sum.tone} prv-note`}>{sum.text}</p>
						<Checks checks={r.checks} />
					</>
				)}
			</div>
		</div>
	);
}

function FilePage({
	agent,
	r,
	path,
}: {
	agent: AgentRow;
	r: GitPrReview;
	path: string;
}) {
	const f = r.files.find((x) => x.path === path);
	if (!f)
		return (
			<p className="prv-empty" role="status">
				This file is not in the PR any more.
			</p>
		);
	return (
		<div className="prv-phone prv-phone-file">
			<h2 className="cv-section-head">
				<StatusMark file={asChanged(f)} />
				<span className="cv-name">
					{f.oldPath ? (
						<span className="cv-dir">from {f.oldPath}</span>
					) : (
						<span className="cv-dir">
							{splitPath(path).dir.replace(/\/$/, "")}
						</span>
					)}
				</span>
				<Counts file={asChanged(f)} />
			</h2>
			<FileReview agent={agent} r={r} file={f} layout="unified" mobile />
		</div>
	);
}

function ReviewPhoneImpl({ arg, params }: PageProps) {
	const agent = findAgent(arg);
	const q = useReview(arg);
	const r = q.data;
	const file = params.f;
	const [tab, setTab] = useState<Tab>(
		TABS.includes(params.t as Tab) ? (params.t as Tab) : "summary",
	);
	const [sheet, setSheet] = useState(false);
	const route = {
		view: "page" as const,
		name: "pr",
		arg,
		...(file ? { params: { f: file } } : {}),
	};
	const ready = !!agent && !!r?.pr;
	return (
		<>
			<IonHeader>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={route} />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>
								{file
									? splitPath(file).name
									: r?.pr
										? `PR #${r.pr.number}`
										: "Pull request"}
							</h1>
							{agent && <span className="p-nav-sub">{agent.name}</span>}
						</span>
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent className="p-plain">
				{!ready ? (
					<p className="prv-empty" role="status">
						{agent ? noPrText(r, q.error) : "This agent is gone."}
					</p>
				) : file ? (
					<FilePage agent={agent!} r={r!} path={file} />
				) : (
					<Overview
						agent={agent!}
						r={r!}
						tab={tab}
						setTab={setTab}
						onReview={() => setSheet(true)}
					/>
				)}
			</IonContent>
			{ready && !file && (
				<ReviewSheet
					agent={agent!}
					r={r!}
					open={sheet}
					onClose={() => setSheet(false)}
				/>
			)}
		</>
	);
}

export default observer(ReviewPhoneImpl);
