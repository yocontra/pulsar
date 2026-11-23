import {
	FolderIcon,
	GitBranchIcon,
	GitPullRequestIcon,
	LaptopIcon,
	SquareIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentRow } from "../../api/types.ts";
import { stopAgentTurn, takeStopAsk, useStopping } from "../../data/index.ts";
import {
	AgentAvatar,
	harnessName,
	STATUS_LABEL,
	StatusBadge,
} from "../../ds/index.ts";
import {
	fullDate,
	shortModel,
	stateLabel,
	tagValue,
	timer,
} from "../../lib/format.ts";
import { branchLink, prLink, repoLink } from "../../lib/links.ts";
import { Slot } from "../../lib/registry.tsx";
import { observer } from "../../lib/signals.ts";
import { can, showToast } from "../../lib/store.ts";

import { ExtLink } from "../ExtLink.tsx";
import { withKeys } from "../ui/kbd.tsx";
import { Layer } from "./Layer.tsx";
import { SessionHeaderSkeleton } from "./skeletons.tsx";

/** Live status with its timer: "Working 04:12", "Idle 40m", "Approval 01:03". */
function LiveStatusImpl({ agent }: { agent: AgentRow }) {
	const [, tick] = useState(0);
	useEffect(() => {
		const t = setInterval(() => tick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, []);
	const s = agent.state;
	const stopping = useStopping(agent.id);
	const word = stopping
		? "Stopping…"
		: s === "needs-you"
			? agent.needsYou?.reason === "approval"
				? // A question or plan (needs-you "Answer: …", "Review plan").
					/^Approve /.test(agent.needsYou.detail ?? "Approve ")
					? "Waiting for approval"
					: "Waiting for your answer"
				: agent.needsYou?.reason === "terminal"
					? "Waiting in the terminal"
					: "Asked you"
			: s === "idle"
				? agent.sessionFrom === "folder"
					? `${STATUS_LABEL.idle} · last session`
					: stateLabel(STATUS_LABEL.idle, agent.stateSince)
				: STATUS_LABEL[s];
	return (
		<StatusBadge
			state={s}
			live={s === "busy"}
			variant="soft"
			title={
				agent.stateSince
					? `${STATUS_LABEL[s]} since ${fullDate(agent.stateSince)}`
					: undefined
			}
		>
			<span aria-live="polite">{word}</span>
			{(s === "busy" || s === "needs-you") && (
				<span className="ds-status-timer">{timer(agent.stateSince)}</span>
			)}
		</StatusBadge>
	);
}
const LiveStatus = observer(LiveStatusImpl);

/**
 * Desktop session header: who (avatar, name, live status), where (machine,
 * project, branch, PR) and Stop, which always confirms.
 */
function DesktopSessionHeaderImpl({
	agent,
	extra,
}: {
	agent: AgentRow | null;
	/** More actions before Stop (the changes toggle). */
	extra?: React.ReactNode;
}) {
	const [confirmStop, setConfirmStop] = useState(false);
	// Not optimistic: "Stopping…" until the daemon answers (data/mutations.ts).
	const stopping = useStopping(agent?.id ?? "");
	useEffect(() => {
		const h = () => setConfirmStop(true);
		addEventListener("pulsar:stop", h);
		return () => removeEventListener("pulsar:stop", h);
	}, []);
	// Asked before this header loaded (the tree's context menu).
	useEffect(() => {
		if (agent && takeStopAsk(agent.id)) setConfirmStop(true);
	}, [agent?.id]);
	if (!agent) return <SessionHeaderSkeleton />;
	const canStop = can("stop") && agent.canStop;
	const stop = async () => {
		try {
			const r = await stopAgentTurn(agent);
			if (r.result === "interrupted") showToast(`Stopped ${agent.name}'s turn`);
			else if (r.result === "not-running")
				showToast(`${agent.name} wasn't running a turn`);
			else
				showToast(
					`Couldn't stop ${agent.name}${r.detail ? `: ${r.detail}` : ""}`,
					"warn",
				);
		} catch (e) {
			showToast(`Couldn't stop ${agent.name}: ${(e as Error).message}`, "warn");
		}
		setConfirmStop(false);
	};
	const pr = tagValue(agent.tags, "pr");
	const worktree = tagValue(agent.tags, "worktree");
	const model = shortModel(agent.model);
	return (
		<header className="d-session-head session-header">
			<AgentAvatar harness={agent.harness} size="md" />
			<div className="d-sh-id">
				<div className="d-sh-line1">
					<h1 title={`${agent.name} on ${agent.machine}`}>{agent.name}</h1>
					<LiveStatus agent={agent} />
				</div>
				<p className="d-sh-meta">
					<span title={`Machine: ${agent.machine}`}>
						<LaptopIcon aria-hidden="true" />
						{agent.machine}
					</span>
					{agent.project && (
						<span title={`Project: ${agent.project}`} className="d-sh-shrink">
							<ExtLink href={repoLink(agent.repoUrl)} className="d-sh-repo">
								<FolderIcon aria-hidden="true" />
								<span className="d-sh-project">{agent.project}</span>
							</ExtLink>
						</span>
					)}
					{agent.branch && (
						<span
							title={`Branch: ${agent.branch}${worktree ? `, worktree ${worktree}` : ""}`}
							className="d-sh-shrink is-branch"
						>
							<ExtLink
								href={branchLink(agent.repoUrl, agent.branch)}
								className="d-sh-branch-link"
							>
								<GitBranchIcon aria-hidden="true" />
								<span className="d-sh-branch">{agent.branch}</span>
							</ExtLink>
						</span>
					)}
					{pr && (
						<span title={`Pull request #${pr}`}>
							<ExtLink href={prLink(agent.repoUrl, pr)} className="d-sh-pr">
								<GitPullRequestIcon aria-hidden="true" />
								PR #{pr}
							</ExtLink>
						</span>
					)}
				</p>
			</div>
			<div className="d-sh-actions">
				{extra}
				<Slot name="session.header" agent={agent} mobile={false} />
				<span
					className="d-sh-model"
					title={`${harnessName(agent.harness)}${agent.model ? ` · ${agent.model}` : ""}`}
				>
					{harnessName(agent.harness)}
					{model && (
						<>
							<span className="d-dot-sep" aria-hidden="true" />
							{model}
						</>
					)}
				</span>
				{canStop && (
					<button
						type="button"
						className="d-btn sm d-stop"
						onClick={() => setConfirmStop(true)}
						title={withKeys("Stop the current turn", ["mod", "."])}
					>
						<SquareIcon aria-hidden="true" />
						<span className="d-btn-label">Stop</span>
					</button>
				)}
			</div>
			{confirmStop && canStop && (
				<Layer
					title="Confirm stop"
					hideTitle
					role="alertdialog"
					onClose={() => setConfirmStop(false)}
					dismissable={!stopping}
					className="d-confirm stop-confirm"
					// Cancel takes focus: Enter never stops by accident.
					initialFocus={() => {}}
				>
					<div className="d-confirm-body">
						<h2>Stop {agent.name}?</h2>
						<p>
							This interrupts its current turn. It picks up again from your next
							message.
						</p>
					</div>
					<div className="d-pop-foot">
						<button
							type="button"
							className="d-btn"
							onClick={() => setConfirmStop(false)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="d-btn danger-fill"
							disabled={stopping}
							onClick={stop}
						>
							{stopping ? "Stopping…" : "Stop this turn"}
						</button>
					</div>
				</Layer>
			)}
		</header>
	);
}

export const DesktopSessionHeader = observer(DesktopSessionHeaderImpl);
