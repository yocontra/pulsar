/**
 * An issue's card: number, title, state, labels, assignees, the body's
 * first part as Markdown (the transcript's hardened renderer: no remote
 * images, safe links) and a link to GitHub. Read-only.
 */
import { useQuery } from "@tanstack/react-query";
import {
	CircleCheckIcon,
	CircleDotIcon,
	CircleSlashIcon,
	ExternalLinkIcon,
	LoaderCircleIcon,
} from "lucide-react";
import { useEffect } from "react";
import { api } from "../../api/client.ts";
import type {
	AgentRow,
	IssueDetails,
	IssueInfo,
	IssueSource,
} from "../../api/types.ts";
import { MessageResponse } from "../../components/ai-elements/message.tsx";
import { ExtLink } from "../../components/ExtLink.tsx";
import { queryClient } from "../../data/hooks.ts";
import { ago } from "../../lib/format.ts";
import { issueAsk } from "./open.ts";

/** The card's data, only while it is open; a slow refresh while shown. */
export function useIssue(agentId: string, number: string, open: boolean) {
	return useQuery(
		{
			queryKey: ["issue", agentId, number],
			queryFn: () => api.issue(agentId),
			enabled: open,
			refetchInterval: (q) => (open && !q.state.error ? 60_000 : false),
			staleTime: 30_000,
			retry: false,
		},
		queryClient,
	);
}

/** Opens the card once when `showIssue` asked for this agent's. */
export function useAsked(agentId: string, open: () => void) {
	const asked = issueAsk.value === agentId;
	useEffect(() => {
		if (!asked) return;
		issueAsk.value = null;
		open();
	}, [asked]);
}

export function stateText(i: IssueInfo): string {
	if (i.state === "open") return "Open";
	return i.stateReason === "not_planned" ? "Closed as not planned" : "Closed";
}

function stateKey(i: IssueInfo): "open" | "done" | "skipped" {
	if (i.state === "open") return "open";
	return i.stateReason === "not_planned" ? "skipped" : "done";
}

const STATE_ICON = {
	open: CircleDotIcon,
	done: CircleCheckIcon,
	skipped: CircleSlashIcon,
};

const SOURCE: Record<IssueSource, string> = {
	tag: "Set by the agent",
	branch: "From the branch name",
	pr: "Closed by its pull request",
	message: "From your first message",
};

/** Why there is no card, in plain words. */
export function reasonText(d: IssueDetails, machine?: string): string {
	const on = machine ? `on ${machine}` : "on the agent's machine";
	const n = d.number ? `#${d.number}` : "The issue";
	switch (d.reason) {
		case "no_issue":
			return "This agent isn't linked to an issue any more.";
		case "no_github":
			return "This agent's repo isn't on GitHub.";
		case "gh_missing":
			return `gh isn't installed ${on}.`;
		case "gh_logged_out":
			return `gh is not logged in ${on}. Run gh auth login there.`;
		case "not_found":
			return d.message ?? `${n} wasn't found in this repo.`;
		default:
			return d.message ?? `Couldn't load ${n}.`;
	}
}

/** Text that reads well on a label's own color. */
function onColor(hex: string): string {
	const r = Number.parseInt(hex.slice(0, 2), 16);
	const g = Number.parseInt(hex.slice(2, 4), 16);
	const b = Number.parseInt(hex.slice(4, 6), 16);
	return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1f2328" : "#ffffff";
}

export function IssueCard({
	agent,
	number,
	mobile,
}: {
	agent: AgentRow;
	number: string;
	mobile: boolean;
}) {
	const q = useIssue(agent.id, number, true);
	const d = q.data;
	const i = d?.issue ?? null;
	if (!i)
		return (
			<div className={`i-card${mobile ? " mobile" : ""}`}>
				{q.isLoading ? (
					<p className="i-empty" role="status">
						<LoaderCircleIcon aria-hidden="true" className="i-spin" />
						Loading issue #{number}…
					</p>
				) : (
					<p className="i-empty">
						{d
							? reasonText(d, agent.machine)
							: `Couldn't load issue #${number}.`}
					</p>
				)}
			</div>
		);
	const key = stateKey(i);
	const Icon = STATE_ICON[key];
	const updated = i.updatedAt ? Date.parse(i.updatedAt) : Number.NaN;
	return (
		<div className={`i-card${mobile ? " mobile" : ""}`}>
			<div className="i-head">
				<Icon aria-hidden="true" className={`i-ico ${key}`} />
				<div className="i-title">
					<ExtLink href={i.url}>
						<span className="i-num">#{i.number}</span> {i.title}
					</ExtLink>
					<span className="i-sub">
						<span className={`i-state ${key}`}>{stateText(i)}</span>
						{i.author && <> · Opened by {i.author}</>}
						{Number.isFinite(updated) && <> · Updated {ago(updated)}</>}
					</span>
				</div>
			</div>
			{i.labels.length > 0 && (
				<ul className="i-labels" aria-label="Labels">
					{i.labels.map((l) => (
						<li
							key={l.name}
							className="i-label"
							style={
								l.color
									? { background: `#${l.color}`, color: onColor(l.color) }
									: undefined
							}
						>
							{l.name}
						</li>
					))}
				</ul>
			)}
			<p className="i-assignees">
				{i.assignees.length
					? `Assigned to ${i.assignees.join(", ")}`
					: "No one assigned"}
			</p>
			{i.body.trim() ? (
				<div className="i-body">
					<MessageResponse>{i.body}</MessageResponse>
					{i.truncated && <p className="i-more">…</p>}
				</div>
			) : (
				<p className="i-empty">No description.</p>
			)}
			<div className="i-foot">
				{d?.source && <span className="i-source">{SOURCE[d.source]}</span>}
				{i.url && (
					<ExtLink href={i.url} className="i-open">
						Open on GitHub
						<ExternalLinkIcon aria-hidden="true" />
					</ExtLink>
				)}
			</div>
		</div>
	);
}
