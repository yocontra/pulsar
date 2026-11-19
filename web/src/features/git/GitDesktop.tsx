/**
 * Desktop git actions in the session header: "+N −M", the PR chip (its
 * card in a popover) and a split button: the quick action for this
 * worktree, and a menu with Commit / Push / Create PR. A disabled control
 * says why on hover. While an action runs, its progress replaces the
 * button (spinner, step, timer).
 */
import {
	ChevronDownIcon,
	GitCommitHorizontalIcon,
	GitPullRequestIcon,
	UploadIcon,
} from "lucide-react";
import { DropdownMenu, Popover, Tooltip } from "radix-ui";
import { type ReactNode, useState } from "react";
import type { AgentRow, GitStatus } from "../../api/types.ts";
import { useChangesPeek } from "../../changes/data.ts";
import { toggleChanges } from "../../changes/panel-state.ts";
import { Layer } from "../../components/desktop/Layer.tsx";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { CommitForm } from "./CommitForm.tsx";
import {
	commitReason,
	httpsOnly,
	prOpen,
	prReason,
	pushReason,
	quickAction,
	type Step,
} from "./model.ts";
import { AskFixForm, PR_STATE, PrCard } from "./PrCard.tsx";
import { Progress } from "./Progress.tsx";
import { useGitRunner, useGitStatus } from "./run.ts";
import "./git.css";

function Tip({ text, children }: { text: string | null; children: ReactNode }) {
	if (!text) return <>{children}</>;
	return (
		<Tooltip.Root delayDuration={150}>
			<Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content className="g-tip" side="bottom" sideOffset={6}>
					{text}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}

/** "+N −M" with a per-file breakdown on hover. */
function ChangesStat({ agentId }: { agentId: string }) {
	const peek = useChangesPeek(agentId).data;
	if (!peek?.available || peek.total === 0) return null;
	const top = peek.files.slice(0, 12);
	return (
		<Tooltip.Root delayDuration={200}>
			<Tooltip.Trigger asChild>
				<button
					type="button"
					className="g-stat g-head-stat"
					aria-label={`${peek.total} changed files, ${peek.added} lines added, ${peek.removed} removed`}
					onClick={toggleChanges}
				>
					<span className="g-add">+{peek.added}</span>
					<span className="g-del">−{peek.removed}</span>
				</button>
			</Tooltip.Trigger>
			<Tooltip.Portal>
				<Tooltip.Content
					className="g-tip g-tip-files"
					side="bottom"
					sideOffset={6}
				>
					{top.map((f) => (
						<div key={f.path} className="g-tip-file">
							<span className="g-tip-path">{f.path}</span>
							<span className="g-add">+{f.added ?? 0}</span>
							<span className="g-del">−{f.removed ?? 0}</span>
						</div>
					))}
					{peek.total > top.length && (
						<div className="g-tip-more">and {peek.total - top.length} more</div>
					)}
				</Tooltip.Content>
			</Tooltip.Portal>
		</Tooltip.Root>
	);
}

function PrChip({
	agent,
	status,
	onAsk,
}: {
	agent: AgentRow;
	status: GitStatus;
	onAsk: (text: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const pr = status.pr!;
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className={`d-btn sm g-pr-chip ${pr.state}`}
					aria-label={`PR #${pr.number}, ${PR_STATE[pr.state]}`}
				>
					<GitPullRequestIcon aria-hidden="true" />#{pr.number}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="g-pop"
					align="end"
					sideOffset={6}
					aria-label="Pull request"
				>
					{open && (
						<PrCard
							agent={agent}
							fallback={pr}
							mobile={false}
							onAsk={(t) => {
								setOpen(false);
								onAsk(t);
							}}
						/>
					)}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

const ICON: Record<Step, typeof UploadIcon> = {
	commit: GitCommitHorizontalIcon,
	push: UploadIcon,
	pr: GitPullRequestIcon,
};

function GitDesktopImpl({ agent }: { agent: AgentRow; mobile: boolean }) {
	const q = useGitStatus(agent.id);
	const status = q.data;
	const run = useGitRunner(agent, status);
	const [ask, setAsk] = useState<string | null>(null);
	if (!can("git")) return null;
	// Nothing to show for a folder that isn't a repo (or no folder).
	if (!status || (!status.available && status.reason !== "git_failed"))
		return null;
	const quick = quickAction(status, agent.machine);
	const reasons: Record<Step, string | null> = {
		commit: commitReason(status),
		push: pushReason(status),
		pr: prReason(status, agent.machine),
	};
	const busy = run.phase.kind === "running" || run.phase.kind === "paused";
	const items: { step: Step; label: string }[] = [
		{ step: "commit", label: "Commit…" },
		{
			step: "push",
			label: status.pushTo ? `Push to ${status.pushTo}` : "Push",
		},
		{ step: "pr", label: "Create PR" },
	];
	return (
		<Tooltip.Provider>
			<div className="g-actions">
				<ChangesStat agentId={agent.id} />
				{status.pr && <PrChip agent={agent} status={status} onAsk={setAsk} />}
				{run.phase.kind !== "idle" ? (
					<Progress phase={run.phase} run={run} mobile={false} />
				) : (
					<div className="g-split" role="group" aria-label="Git actions">
						<Tip text={quick.disabled ?? null}>
							{quick.href ? (
								<a
									className="d-btn sm g-main"
									href={quick.href}
									target="_blank"
									rel="noopener noreferrer"
								>
									<GitPullRequestIcon aria-hidden="true" />
									{quick.label}
								</a>
							) : (
								<button
									type="button"
									className="d-btn sm g-main"
									aria-disabled={quick.disabled ? true : undefined}
									onClick={() => {
										if (!quick.disabled && !busy) run.start(quick.steps);
									}}
								>
									{(() => {
										const Icon = ICON[quick.steps.at(-1) ?? "commit"];
										return <Icon aria-hidden="true" />;
									})()}
									{quick.label}
								</button>
							)}
						</Tip>
						<DropdownMenu.Root>
							<DropdownMenu.Trigger asChild>
								<button
									type="button"
									className="d-btn sm icon g-more"
									aria-label="More git actions"
								>
									<ChevronDownIcon aria-hidden="true" />
								</button>
							</DropdownMenu.Trigger>
							<DropdownMenu.Portal>
								<DropdownMenu.Content
									className="d-menu g-menu"
									align="end"
									sideOffset={6}
								>
									{items.map(({ step, label }) => {
										const Icon = ICON[step];
										const why = reasons[step];
										if (
											step === "pr" &&
											status.pr &&
											prOpen(status) &&
											httpsOnly(status.pr.url)
										)
											return (
												<DropdownMenu.Item key={step} asChild>
													<a
														href={status.pr.url}
														target="_blank"
														rel="noopener noreferrer"
														className="g-menu-item"
													>
														<Icon aria-hidden="true" />
														<span className="g-menu-text">
															View PR #{status.pr.number}
														</span>
													</a>
												</DropdownMenu.Item>
											);
										return (
											<DropdownMenu.Item
												key={step}
												className="g-menu-item"
												disabled={!!why}
												onSelect={() => run.start([step])}
											>
												<Icon aria-hidden="true" />
												<span className="g-menu-text">
													{label}
													{why && <small>{why}</small>}
												</span>
											</DropdownMenu.Item>
										);
									})}
								</DropdownMenu.Content>
							</DropdownMenu.Portal>
						</DropdownMenu.Root>
					</div>
				)}
			</div>
			{run.commitThen && (
				<Layer
					title="Commit changes"
					onClose={run.closeCommit}
					className="g-commit-layer"
					initialFocus={() => {}}
				>
					<CommitForm
						agent={agent}
						status={status}
						mobile={false}
						onCommit={run.commit}
						onCancel={run.closeCommit}
					/>
				</Layer>
			)}
			{run.confirm && (
				<Layer
					title={run.confirm.title}
					hideTitle
					role="alertdialog"
					onClose={() => run.confirm?.resolve(false)}
					className="d-confirm"
					initialFocus={() => {}}
				>
					<div className="d-confirm-body">
						<h2>{run.confirm.title}</h2>
						<p>{run.confirm.body}</p>
					</div>
					<div className="d-pop-foot">
						<button
							type="button"
							className="d-btn"
							onClick={() => run.confirm?.resolve(false)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="d-btn primary"
							onClick={() => run.confirm?.resolve(true)}
						>
							{run.confirm.ok}
						</button>
					</div>
				</Layer>
			)}
			{ask !== null && (
				<Layer
					title={`Ask ${agent.name} to fix`}
					onClose={() => setAsk(null)}
					className="g-ask-layer"
				>
					<AskFixForm
						agent={agent}
						initial={ask}
						mobile={false}
						onDone={() => setAsk(null)}
					/>
				</Layer>
			)}
		</Tooltip.Provider>
	);
}

export default observer(GitDesktopImpl);
