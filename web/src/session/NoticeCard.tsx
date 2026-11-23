import { BellIcon } from "lucide-react";
import { type ReactNode, useContext, useState } from "react";
import type { TranscriptEvent, TranscriptNotice } from "../api/types.ts";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { AgentMark } from "../ds/index.ts";
import { agentColor, nameKey } from "../lib/agent-color.ts";
import { clock, fullDate } from "../lib/format.ts";
import { peerFrom } from "./messages.ts";
import { SubagentColors } from "./subagent-colors.tsx";

/**
 * A Claude Code agent-team message or a background task's result (an event
 * with `notice`): the sender with its teammate color, what happened ("Idle",
 * "Finished", "Plan for approval"), the summary as a title, and the body as
 * Markdown, clamped past ~8 lines. An idle notice with nothing to say is one
 * quiet line.
 */
export function NoticeCard({
	ev,
	actions,
}: {
	ev: TranscriptEvent & { notice: TranscriptNotice };
	/** The platform's message actions (copy, reply), when this is a turn. */
	actions?: ReactNode;
}) {
	const n = ev.notice;
	const task = n.type === "task_notification";
	const name = task ? "Background task" : peerFrom(ev.from);
	const text = ev.text.trim();
	const label = noticeLabel(n, !!text);
	const tone = noticeTone(n);
	const [open, setOpen] = useState(false);
	// The sender's color, the same as on its subagent row and cards.
	const senders = useContext(SubagentColors).senders;
	const color = task
		? null
		: agentColor({ color: n.color ?? senders.get(nameKey(name)), name });
	const dot = task ? (
		<BellIcon className="ds-notice-icon" aria-hidden="true" />
	) : (
		<AgentMark color={color} className="ds-notice-dot" />
	);
	const time = ev.ts ? (
		<time
			className="ds-time"
			dateTime={new Date(ev.ts).toISOString()}
			title={fullDate(ev.ts)}
		>
			{clock(ev.ts)}
		</time>
	) : null;

	if (!text)
		return (
			<div
				className="ev peer ds-notice-quiet"
				data-msg-id={ev.id}
				data-notice={n.type}
				role="status"
			>
				{dot}
				<span className="ds-notice-name">{name}</span>
				{label && (
					<span className={`ds-notice-label${tone}`}>
						{label.toLowerCase()}
					</span>
				)}
				{n.summary && <span className="ds-notice-sub">{n.summary}</span>}
				{time}
			</div>
		);

	const long = isLong(text);
	return (
		<div
			className="ev peer ds-turn ds-turn--peer ds-notice-turn"
			data-msg-id={ev.id}
			data-notice={n.type}
		>
			<div className="ds-author">
				{dot}
				<span className="ds-author-name">{name}</span>
				{label && <span className={`ds-notice-label${tone}`}>{label}</span>}
				{time}
			</div>
			<div
				className="ds-peer-body ds-notice-card"
				data-agent-color={color ?? undefined}
			>
				{/* Kept for search and tests: "from lead". */}
				<span className="sr-only">from {name}</span>
				{n.summary && <div className="ds-notice-title">{n.summary}</div>}
				<div className={`ds-notice-body${long && !open ? " is-clamped" : ""}`}>
					<MessageResponse>{text}</MessageResponse>
				</div>
				{long && (
					<button
						type="button"
						className="ds-notice-more"
						aria-expanded={open}
						onClick={() => setOpen((o) => !o)}
					>
						{open ? "Show less" : "Show more"}
					</button>
				)}
			</div>
			{actions}
		</div>
	);
}

/** More than ~8 lines of text: clamp it behind "Show more". */
export function isLong(text: string): boolean {
	return text.split("\n").length > 8 || text.length > 720;
}

/** What happened, in words: "Finished", "Plan for approval", … */
export function noticeLabel(
	n: TranscriptNotice,
	hasText: boolean,
): string | undefined {
	const ok = n.status === "approved";
	switch (n.type) {
		case "message":
			return undefined;
		case "idle_notification":
			if (n.status === "failed") return "Failed";
			return hasText ? "Finished" : "Idle";
		case "task_notification":
			if (n.status === "failed") return "Task failed";
			if (n.status === "killed" || n.status === "stopped")
				return "Task stopped";
			return "Task done";
		case "task_completed":
			return "Task done";
		case "task_assignment":
			return "Task assigned";
		case "shutdown_request":
			return "Asked to shut down";
		case "shutdown_response":
		case "shutdown_approved":
			return n.status === "rejected" ? "Declined shutdown" : "Shutting down";
		case "plan_approval_request":
			return "Plan for approval";
		case "plan_approval_response":
			return ok ? "Plan approved" : "Plan changes requested";
		case "permission_request":
			return "Permission request";
		case "permission_response":
			return ok ? "Permission granted" : "Permission denied";
		default: {
			const words = n.type.replace(/_/g, " ").trim();
			return words ? words[0]!.toUpperCase() + words.slice(1) : undefined;
		}
	}
}

function noticeTone(n: TranscriptNotice): string {
	if (n.status === "failed" || n.status === "rejected") return " is-error";
	if (n.status === "approved") return " is-ok";
	return "";
}
