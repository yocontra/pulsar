/**
 * Phone git actions: a branch button in the agent header opens a sheet
 * with the overview (branch, changes, upstream, PR), the quick action and
 * Commit / Push / Create PR, each with the reason when it can't run. The
 * commit form, the PR card and "Ask {agent} to fix" open in the same
 * sheet; progress shows in place of the buttons.
 */
import {
	ChevronRightIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AgentRow, GitStatus } from "../../api/types.ts";
import { useChangesPeek } from "../../changes/data.ts";
import { CloseX } from "../../components/CloseX.tsx";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { IonButton, IonContent } from "../../mobile/ionic.ts";
import { useIonicLazy } from "../../mobile/lazyIonic.ts";
import { CommitForm } from "./CommitForm.tsx";
import {
	commitReason,
	prOpen,
	prReason,
	pushReason,
	quickAction,
	type Step,
} from "./model.ts";
import { AskFixForm, PR_STATE, PrCard } from "./PrCard.tsx";
import { Progress } from "./Progress.tsx";
import { type GitRunner, useGitRunner, useGitStatus } from "./run.ts";
import "./git.css";

type View = "overview" | "commit" | "pr" | "ask";

const TITLE: Record<View, string> = {
	overview: "Git",
	commit: "Commit changes",
	pr: "Pull request",
	ask: "Ask to fix",
};

function Overview({
	agent,
	status,
	run,
	go,
}: {
	agent: AgentRow;
	status: GitStatus;
	run: GitRunner;
	go: (v: View) => void;
}) {
	const peek = useChangesPeek(agent.id).data;
	const quick = quickAction(status, agent.machine);
	const rows: { step: Step; label: string; why: string | null }[] = [
		{ step: "commit", label: "Commit", why: commitReason(status) },
		{ step: "push", label: "Push", why: pushReason(status) },
		{ step: "pr", label: "Create PR", why: prReason(status, agent.machine) },
	];
	const start = (steps: Step[]) => {
		run.start(steps);
		if (steps[0] === "commit") go("commit");
	};
	return (
		<div className="g-sheet-body">
			<ul className="g-rows">
				<li>
					<span className="g-row-label">Branch</span>
					<span className="g-row-value">
						{status.branch ?? "Detached HEAD"}
						{status.onDefault && <span className="g-chip warn">Default</span>}
					</span>
				</li>
				<li>
					<span className="g-row-label">Changes</span>
					<span className="g-row-value">
						{status.dirty === 0 ? (
							"Clean"
						) : (
							<>
								{status.dirty} {status.dirty === 1 ? "file" : "files"}
								{peek?.available && (
									<span className="g-stat">
										<span className="g-add">+{peek.added}</span>
										<span className="g-del">−{peek.removed}</span>
									</span>
								)}
							</>
						)}
					</span>
				</li>
				<li>
					<span className="g-row-label">Remote</span>
					<span className="g-row-value">
						{!status.remote
							? "None"
							: !status.upstream
								? "Not pushed yet"
								: status.ahead || status.behind
									? `${status.ahead} ahead, ${status.behind} behind ${status.upstream}`
									: `Up to date with ${status.upstream}`}
					</span>
				</li>
				{status.pr && (
					<li>
						<button
							type="button"
							className="g-row-btn"
							onClick={() => go("pr")}
						>
							<span className="g-row-label">
								<GitPullRequestIcon
									aria-hidden="true"
									className={`g-pr-ico ${status.pr.state}`}
								/>
								PR #{status.pr.number}
							</span>
							<span className="g-row-value">
								{PR_STATE[status.pr.state]}
								<ChevronRightIcon aria-hidden="true" />
							</span>
						</button>
					</li>
				)}
			</ul>
			{run.phase.kind !== "idle" ? (
				<Progress phase={run.phase} run={run} mobile />
			) : (
				<div className="g-sheet-actions">
					{quick.href ? (
						<a
							className="m-btn wide"
							href={quick.href}
							target="_blank"
							rel="noopener noreferrer"
						>
							{quick.label}
						</a>
					) : (
						<button
							type="button"
							className="m-btn wide"
							disabled={!!quick.disabled}
							onClick={() => start(quick.steps)}
						>
							{quick.label}
						</button>
					)}
					{quick.disabled && <p className="g-why">{quick.disabled}</p>}
					<div className="g-sheet-more">
						{rows.map((r) =>
							r.step === "pr" && status.pr && prOpen(status) ? null : (
								<button
									key={r.step}
									type="button"
									className="m-btn small gray"
									disabled={!!r.why}
									onClick={() => start([r.step])}
								>
									{r.label}
								</button>
							),
						)}
					</div>
					{rows
						.filter((r) => r.why && r.why !== quick.disabled)
						.map((r) => (
							<p key={r.step} className="g-why">
								{r.label}: {r.why}
							</p>
						))}
				</div>
			)}
		</div>
	);
}

function GitPhoneImpl({ agent }: { agent: AgentRow; mobile: boolean }) {
	const lz = useIonicLazy();
	const status = useGitStatus(agent.id).data;
	const run = useGitRunner(agent, status);
	const [open, setOpen] = useState(false);
	const [view, setView] = useState<View>("overview");
	const [ask, setAsk] = useState("");
	const modal = useRef<HTMLIonModalElement | null>(null);
	// A form or the PR card needs the whole height (its buttons sit at the end).
	useEffect(() => {
		if (open && view !== "overview")
			void modal.current?.setCurrentBreakpoint(1).catch(() => {});
	}, [open, view]);
	// A confirm mid-run (the agent started working) needs the sheet open.
	useEffect(() => {
		if (run.confirm) setOpen(true);
	}, [run.confirm]);
	if (!can("git")) return null;
	if (!status?.available) return null;
	const running = run.phase.kind === "running";
	const close = () => {
		if (view === "commit") run.closeCommit();
		setOpen(false);
		setView("overview");
	};
	const dot = running
		? null
		: status.dirty > 0
			? "dirty"
			: status.pr && prOpen(status)
				? "pr"
				: null;
	return (
		<>
			<IonButton
				className="g-phone-btn"
				aria-label={`Git: ${status.branch ?? "detached HEAD"}${status.dirty ? `, ${status.dirty} changed` : ""}`}
				onClick={() => {
					setView("overview");
					setOpen(true);
				}}
			>
				{running ? (
					<LoaderCircleIcon aria-hidden="true" className="g-spin" />
				) : (
					<GitBranchIcon aria-hidden="true" />
				)}
				{dot && <span className={`g-dot ${dot}`} aria-hidden="true" />}
			</IonButton>
			{/*
			 * Portaled to ion-app: Ionic moves the sheet there, out of this
			 * nav page's portal, and React only sees its events inside the
			 * portal container they come from.
			 */}
			{lz &&
				createPortal(
					<lz.IonModal
						ref={modal}
						className="g-modal"
						isOpen={open}
						aria-label="Git"
						breakpoints={[0, 0.65, 1]}
						initialBreakpoint={0.65}
						handle={false}
						onIonModalDidDismiss={close}
					>
						<IonContent className="p-sheet-content" scrollY={false}>
							<div className="g-sheet">
								<header className="m-sheet-head">
									{view === "overview" ? (
										<span />
									) : (
										<button
											type="button"
											className="g-link"
											onClick={() => {
												if (view === "commit") run.closeCommit();
												setView(view === "ask" ? "pr" : "overview");
											}}
										>
											Back
										</button>
									)}
									<h2>
										{view === "ask" ? `Ask ${agent.name} to fix` : TITLE[view]}
									</h2>
									<CloseX onClick={close} />
								</header>
								<div className="m-sheet-scroll">
									{view === "overview" && (
										<Overview
											agent={agent}
											status={status}
											run={run}
											go={setView}
										/>
									)}
									{view === "commit" && run.commitThen && (
										<div className="g-sheet-body">
											<CommitForm
												agent={agent}
												status={status}
												mobile
												onCommit={(c) => {
													run.commit(c);
													setView("overview");
												}}
												onCancel={() => {
													run.closeCommit();
													setView("overview");
												}}
											/>
										</div>
									)}
									{view === "pr" && (
										<div className="g-sheet-body">
											<PrCard
												agent={agent}
												fallback={status.pr}
												mobile
												onAsk={(t) => {
													setAsk(t);
													setView("ask");
												}}
											/>
										</div>
									)}
									{view === "ask" && (
										<div className="g-sheet-body">
											<AskFixForm
												agent={agent}
												initial={ask}
												mobile
												onDone={() => setView("pr")}
											/>
										</div>
									)}
								</div>
								{run.confirm && (
									<div
										className="g-sheet-confirm"
										role="alertdialog"
										aria-label={run.confirm.title}
									>
										<strong>{run.confirm.title}</strong>
										<p>{run.confirm.body}</p>
										<div className="g-sheet-foot">
											<button
												type="button"
												className="m-btn gray"
												onClick={() => run.confirm?.resolve(false)}
											>
												Cancel
											</button>
											<button
												type="button"
												className="m-btn"
												onClick={() => run.confirm?.resolve(true)}
											>
												{run.confirm.ok}
											</button>
										</div>
									</div>
								)}
							</div>
						</IonContent>
					</lz.IonModal>,
					document.querySelector("ion-app") ?? document.body,
				)}
		</>
	);
}

export default observer(GitPhoneImpl);
