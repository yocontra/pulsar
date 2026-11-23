import { cx as cn } from "../../lib/cx.ts";
import {
	badgeCount,
	fullDate,
	heldFor,
	num,
	STATUS_LABEL,
	stateLabel,
} from "../../lib/format.ts";

export type AgentState = "busy" | "idle" | "needs-you" | "offline";
export type Tone = AgentState | "failed" | "done";

/**
 * Status shape + color, never color alone: busy is a filled dot that pulses
 * when `live`, idle a ring, needs you a triangle, offline a slashed ring,
 * failed a cross, done a check.
 */
export function StatusDot({
	state,
	live,
	label,
	className,
}: {
	state: Tone;
	/** Pulse (busy only; off with reduced motion). */
	live?: boolean;
	label?: string;
	className?: string;
}) {
	const a11y = label
		? { role: "img" as const, "aria-label": label }
		: { "aria-hidden": true as const };
	return (
		<svg
			viewBox="0 0 12 12"
			className={cn("ds-dot", `s-${state}`, live && "is-live", className)}
			{...a11y}
		>
			{label && <title>{label}</title>}
			{state === "busy" && <circle cx="6" cy="6" r="4" fill="currentColor" />}
			{state === "idle" && (
				<circle
					cx="6"
					cy="6"
					r="3.6"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
				/>
			)}
			{state === "needs-you" && (
				<path
					d="M6 1.4 10.8 10H1.2z"
					fill="currentColor"
					stroke="currentColor"
					strokeWidth="0.8"
					strokeLinejoin="round"
				/>
			)}
			{state === "offline" && (
				<>
					<circle
						cx="6"
						cy="6"
						r="3.6"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.4"
					/>
					<path d="M3.2 8.8 8.8 3.2" stroke="currentColor" strokeWidth="1.4" />
				</>
			)}
			{state === "failed" && (
				<path
					d="M3 3l6 6M9 3l-6 6"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
				/>
			)}
			{state === "done" && (
				<path
					d="M2.5 6.4 5 8.8l4.5-5.3"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.8"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			)}
		</svg>
	);
}

/**
 * A status as a quiet pill: shape + word ("Working", "Idle 40m",
 * "Needs you"). `variant="plain"` drops the fill for dense rows.
 */
export function StatusBadge({
	state,
	children,
	live,
	variant = "soft",
	className,
	title,
}: {
	state: Tone;
	/** The words. Use STATUS_LABEL[state] (+ a duration) from lib/format. */
	children: React.ReactNode;
	live?: boolean;
	variant?: "soft" | "plain";
	className?: string;
	/** Hover text: what a short label means ("Idle since Nov 22, 4:56 PM"). */
	title?: string;
}) {
	return (
		<span
			title={title}
			className={cn(
				"ds-status",
				`s-${state}`,
				`ds-status--${variant}`,
				className,
			)}
		>
			<StatusDot state={state} live={live} />
			<span className="ds-status-text">{children}</span>
		</span>
	);
}

/**
 * The amber "needs you" count (approvals + questions waiting). Renders
 * nothing at 0. `label` is read by VoiceOver ("2 need you").
 */
export function NeedsBadge({
	count,
	label,
	className,
}: {
	count: number;
	label?: string;
	className?: string;
}) {
	if (count <= 0) return null;
	return (
		<span className={cn("ds-needs-badge", className)} title={label}>
			<span aria-hidden={label ? true : undefined}>{badgeCount(count)}</span>
			{label && <span className="sr-only">{label}</span>}
		</span>
	);
}

/** A neutral count capsule (sidebar sections, facet chips). */
export function CountBadge({
	count,
	className,
}: {
	count: number;
	className?: string;
}) {
	return (
		<span
			className={cn("ds-count", className)}
			title={count > 99 ? num(count) : undefined}
		>
			{badgeCount(count)}
		</span>
	);
}

/**
 * An agent's status in words, ready for a row or header: "Working" (live
 * pulse), "Idle 40m", "Needs you" / "Waiting for approval", "Offline".
 * Pass `now` from a shared clock so the duration ticks.
 */
export function AgentStatus({
	state,
	since: ts,
	needsReason,
	lastSession,
	now,
	variant = "plain",
	className,
	short = false,
}: {
	state: AgentState;
	/** When the agent entered this state (ms); adds "40m" to Idle. */
	since?: number;
	/** `needsYou.reason`: "approval" reads "Waiting for approval", "terminal" "Waiting in the terminal". */
	needsReason?: string;
	/**
	 * Idle as "Idle · last session": the folder's latest session of an open
	 * OpenCode TUI, a guess (it only gets messages in its inbox).
	 */
	lastSession?: boolean;
	now?: number;
	variant?: "soft" | "plain";
	className?: string;
	/** Short words for a narrow title bar ("Needs approval"). */
	short?: boolean;
}) {
	const words =
		state === "needs-you"
			? needsReason === "approval"
				? short
					? "Needs approval"
					: "Waiting for approval"
				: needsReason === "terminal"
					? short
						? "In the terminal"
						: "Waiting in the terminal"
					: "Needs you"
			: state === "idle"
				? lastSession
					? `${STATUS_LABEL.idle} · last session`
					: stateLabel(STATUS_LABEL.idle, ts, now)
				: STATUS_LABEL[state];
	return (
		<StatusBadge
			state={state}
			live={state === "busy"}
			variant={variant}
			className={className}
			title={
				state === "idle" && !lastSession && heldFor(ts, now) && ts
					? `Idle since ${fullDate(ts)}`
					: undefined
			}
		>
			{words}
		</StatusBadge>
	);
}
