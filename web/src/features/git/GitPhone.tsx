/**
 * Phone git actions: a branch button in the agent header opens a sheet
 * with the overview (branch, changes, upstream, PR), the quick action and
 * Commit / Push / Create PR, each with the reason when it can't run. The
 * commit form, the PR card and "Ask {agent} to fix" open in the same
 * sheet; progress shows in place of the buttons.
 */

import { Button, List, ListItem } from "konsta/react";
import {
	GitBranchIcon,
	GitPullRequestIcon,
	LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentRow, GitStatus } from "../../api/types.ts";
import { useChangesPeek } from "../../changes/data.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { IonButton } from "../../mobile/ionic.ts";
import { SheetShell } from "../../mobile/ui/SheetShell.tsx";
import { CommitForm } from "./CommitForm.tsx";
import {
	commitReason,
	prOpen,
	prReason,
	pushReason,
	quickAction,
	type Step,
	tracking,
} from "./model.ts";
import { gitAsk, offerGit } from "./open.ts";
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
	const remote = !status.remote
		? "None"
		: status.upstreamGone
			? `${status.upstream} is gone: push makes ${status.pushTo}`
			: !tracking(status)
				? `Not pushed to ${status.pushTo} yet`
				: status.ahead || status.behind
					? `${status.ahead} ahead, ${status.behind} behind ${status.upstream}`
					: `Up to date with ${status.upstream}`;
	return (
		<>
			<List
				strong
				inset
				className="g-rows"
				role="group"
				aria-label="Git status"
			>
				<ListItem
					title="Branch"
					after={
						<span className="g-row-value">
							{status.branch ?? "Detached HEAD"}
							{status.onDefault && <span className="g-chip warn">Default</span>}
						</span>
					}
				/>
				<ListItem
					title="Changes"
					after={
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
					}
				/>
				<ListItem
					title="Remote"
					after={<span className="g-row-value g-row-wrap">{remote}</span>}
				/>
				{status.pr && (
					<ListItem
						link
						linkComponent="button"
						linkProps={{ type: "button" }}
						onClick={() => go("pr")}
						media={
							<GitPullRequestIcon
								aria-hidden="true"
								className={`g-pr-ico ${status.pr.state}`}
							/>
						}
						title={`PR #${status.pr.number}`}
						after={PR_STATE[status.pr.state]}
					/>
				)}
			</List>
			{run.phase.kind !== "idle" ? (
				<div className="p-sheet-pad">
					<Progress phase={run.phase} run={run} mobile />
				</div>
			) : (
				<div className="p-sheet-pad g-sheet-actions">
					{quick.href ? (
						<Button
							large
							rounded
							component="a"
							{...{
								href: quick.href,
								target: "_blank",
								rel: "noopener noreferrer",
							}}
						>
							{quick.label}
						</Button>
					) : (
						<Button
							large
							rounded
							disabled={!!quick.disabled}
							onClick={() => start(quick.steps)}
						>
							{quick.label}
						</Button>
					)}
					{quick.disabled && <p className="g-why">{quick.disabled}</p>}
					<div className="g-sheet-more">
						{rows.map((r) =>
							r.step === "pr" && status.pr && prOpen(status) ? null : (
								<Button
									key={r.step}
									tonal
									rounded
									inline
									className="p-tonal"
									disabled={!!r.why}
									onClick={() => start([r.step])}
								>
									{r.label}
								</Button>
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
		</>
	);
}

function GitPhoneImpl({ agent }: { agent: AgentRow; mobile: boolean }) {
	const status = useGitStatus(agent.id).data;
	const run = useGitRunner(agent, status);
	const [open, setOpen] = useState(false);
	// Mounted from the first open until it has animated out: no closed
	// sheet sits in the page.
	const [mounted, setMounted] = useState(false);
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
		if (run.confirm) {
			setMounted(true);
			setOpen(true);
		}
	}, [run.confirm]);
	const offered = can("git") && !!status?.available;
	const enabled =
		offered &&
		!!status &&
		(run.phase.kind !== "idle" ||
			!!status.pr ||
			!commitReason(status) ||
			!pushReason(status) ||
			!prReason(status, agent.machine));
	// The ••• menu offers "Git" on a narrow phone (the button is hidden).
	useEffect(() => {
		offerGit(agent.id, offered ? enabled : undefined);
		return () => offerGit(agent.id, undefined);
	}, [agent.id, offered, enabled]);
	const asked = enabled && gitAsk.value === agent.id;
	useEffect(() => {
		if (!asked) return;
		gitAsk.value = null;
		setView("overview");
		setMounted(true);
		setOpen(true);
	}, [asked]);
	if (!offered || !status) return null;
	const running = run.phase.kind === "running";
	const close = () => {
		if (view === "commit") run.closeCommit();
		setOpen(false);
		setView("overview");
	};
	// No badge: the Changes button beside it counts the changed files, and
	// one orange badge per header reads as one thing to act on.
	const label = [
		`Git: ${status.branch ?? "detached HEAD"}`,
		status.dirty ? `${status.dirty} changed` : null,
		status.pr && prOpen(status) ? `PR #${status.pr.number} open` : null,
	]
		.filter(Boolean)
		.join(", ");
	return (
		<>
			<IonButton
				className="g-phone-btn"
				aria-label={label}
				disabled={!enabled}
				onClick={() => {
					setView("overview");
					setMounted(true);
					setOpen(true);
				}}
			>
				{running ? (
					<LoaderCircleIcon aria-hidden="true" className="g-spin" />
				) : (
					<GitBranchIcon aria-hidden="true" />
				)}
			</IonButton>
			{mounted && (
				<SheetShell
					open={open}
					onClose={close}
					onClosed={() => setMounted(false)}
					title={view === "ask" ? `Ask ${agent.name} to fix` : TITLE[view]}
					label="Git"
					detents={[0, 0.65, 1]}
					initial={0.65}
					className="g-modal"
					modalRef={modal}
					testId="git-sheet"
					onBack={
						view === "overview"
							? undefined
							: () => {
									if (view === "commit") run.closeCommit();
									setView(view === "ask" ? "pr" : "overview");
								}
					}
					footer={
						run.confirm && (
							<div
								className="p-sheet-foot g-sheet-confirm"
								role="alertdialog"
								aria-label={run.confirm.title}
							>
								<strong>{run.confirm.title}</strong>
								<p>{run.confirm.body}</p>
								<div className="g-sheet-foot">
									<Button
										large
										rounded
										tonal
										className="p-tonal"
										onClick={() => run.confirm?.resolve(false)}
									>
										Cancel
									</Button>
									<Button
										large
										rounded
										onClick={() => run.confirm?.resolve(true)}
									>
										{run.confirm.ok}
									</Button>
								</div>
							</div>
						)
					}
				>
					{view === "overview" && (
						<Overview agent={agent} status={status} run={run} go={setView} />
					)}
					{view === "commit" && run.commitThen && (
						<div className="p-sheet-pad">
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
						<div className="p-sheet-pad">
							<PrCard
								agent={agent}
								fallback={status.pr}
								mobile
								onAsk={(t) => {
									setAsk(t);
									setView("ask");
								}}
								onReview={close}
							/>
						</div>
					)}
					{view === "ask" && (
						<div className="p-sheet-pad">
							<AskFixForm
								agent={agent}
								initial={ask}
								mobile
								onDone={() => setView("pr")}
							/>
						</div>
					)}
				</SheetShell>
			)}
		</>
	);
}

export default observer(GitPhoneImpl);
