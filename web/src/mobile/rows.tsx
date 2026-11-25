/**
 * Home list rows. Each row renders the same boxes (data-sk) whether it is
 * loaded or a skeleton, so skeletons match the loaded layout to the pixel.
 *
 * Signal, not noise: machine and project rows show no rollup counts and no
 * busy dots, only an amber "needs you" badge when someone waits, and a
 * machine's reachability when it isn't normal.
 */
import {
	ChevronRightIcon,
	FolderIcon,
	MessageCircleQuestionIcon,
	MonitorIcon,
	PinIcon,
	ShieldCheckIcon,
	SquareTerminalIcon,
	WifiOffIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import type { AgentRow, AttentionItem, Link, TreeNode } from "../api/types.ts";
import { terminalTitle, terminalWhy } from "../approval/terminal.ts";
import { visible } from "../approval/visible.ts";
import {
	AgentAvatar,
	AgentStatus as DsAgentStatus,
	NeedsBadge as DsNeedsBadge,
	harnessName,
} from "../ds/index.ts";
import { issueOf } from "../features/issues/open.ts";
import { activityLine, age, heldFor, num, rollupOf } from "../lib/format.ts";
import { now } from "./clock.ts";

/* ------------------------------------------------------------ shell */

type Kind = "agent" | "group" | "needs" | "plain";

/** One row's layout. `sk` swaps text for placeholder bars of the same size. */
export function RowShell({
	kind,
	depth = 0,
	lead,
	title,
	sub,
	trail,
	sk,
}: {
	kind: Kind;
	depth?: number;
	lead?: ReactNode;
	title: ReactNode;
	sub?: ReactNode;
	trail?: ReactNode;
	sk?: { title: number; sub?: number; trail?: number };
}) {
	const two = kind === "agent" || kind === "needs";
	const trailBox = (trail || sk?.trail) && (
		<span className="p-trail" data-sk="trail">
			{sk?.trail ? <Bar w={sk.trail} /> : trail}
		</span>
	);
	const titleBox = (
		<span className="p-title" data-sk="title">
			{sk ? <Bar w={sk.title} /> : title}
		</span>
	);
	return (
		<div className={`p-row is-${kind}`} data-depth={depth || undefined}>
			{lead !== undefined && (
				<span className="p-lead" data-sk="lead">
					{lead}
				</span>
			)}
			<span className="p-text">
				{two ? (
					// Mail style: time and status share the title's line and baseline.
					<span className="p-line1">
						{titleBox}
						{trailBox}
					</span>
				) : (
					titleBox
				)}
				{two && (
					<span className="p-sub" data-sk="sub">
						{sk ? <Bar w={sk.sub ?? 60} /> : sub}
					</span>
				)}
			</span>
			{!two && trailBox}
		</div>
	);
}

/** A skeleton bar: `w` percent of its line (or px when > 100). */
export function Bar({ w }: { w: number }) {
	return (
		<span
			className="p-sk p-sk-line"
			aria-hidden="true"
			style={{ width: w > 100 ? `${w}px` : `${w}%` }}
		/>
	);
}

/* ------------------------------------------------------------ avatar */

/** The agent's harness mark (ds AgentAvatar at list size, 40 pt). */
export function Avatar({ harness }: { harness: string }) {
	return (
		<AgentAvatar harness={harness} size="list" label={harnessName(harness)} />
	);
}

export { harnessName };

/* ------------------------------------------------------------ status */

/** A short human status for an agent row's trailing edge (ds AgentStatus). */
export function AgentStatus({
	a,
	reason = false,
	short = false,
}: {
	a: AgentRow;
	reason?: boolean;
	/** Short words, for the agent page's title bar. */
	short?: boolean;
}) {
	return (
		<DsAgentStatus
			short={short}
			state={a.state}
			since={a.stateSince}
			needsReason={reason ? a.needsYou?.reason : undefined}
			lastSession={a.sessionFrom === "folder"}
			now={now.value}
			className="p-state"
		/>
	);
}

export function statusText(a: AgentRow): string {
	switch (a.state) {
		case "needs-you":
			return "needs you";
		case "busy":
			return "working";
		case "unknown":
			return "status unknown";
		case "idle": {
			const held = heldFor(a.stateSince);
			return held ? `idle for ${held}` : "idle";
		}
		default:
			return "offline";
	}
}

/** Reachability words, only when it isn't normal. */
export function linkWord(link: Link | null): string | null {
	switch (link) {
		case "asleep":
			return "Asleep";
		case "daemon-down":
			return "Offline";
		case "upgrade":
			return "Update Pulsar";
		default:
			return null;
	}
}

export function NeedsBadge({ n, label }: { n: number; label?: string }) {
	return (
		<DsNeedsBadge
			count={n}
			label={label ?? `${num(n)} ${n === 1 ? "needs" : "need"} you`}
		/>
	);
}

/* ------------------------------------------------------------ rows */

/** The row's second line, after the issue the agent works on (features/issues). */
function IssueSub({ a, text }: { a: AgentRow; text: string }) {
	const issue = issueOf(a);
	if (!issue) return text;
	return (
		<>
			<span className="p-issue">#{issue}</span>
			{text}
		</>
	);
}

export function AgentRowView({
	a,
	depth = 0,
	withPlace = false,
}: {
	a: AgentRow;
	depth?: number;
	withPlace?: boolean;
}) {
	return (
		<RowShell
			kind="agent"
			depth={depth}
			lead={<Avatar harness={a.harness} />}
			title={a.name}
			sub={<IssueSub a={a} text={activityLine(a, withPlace)} />}
			trail={<AgentStatus a={a} />}
		/>
	);
}

export function GroupRowView({
	n,
	depth = 0,
}: {
	n: TreeNode;
	depth?: number;
}) {
	const r = rollupOf(n);
	const machine = n.kind === "machine";
	const word = machine ? linkWord(n.link) : null;
	const allOffline = machine && r.agents > 0 && r.offline === r.agents;
	return (
		<RowShell
			kind="group"
			depth={depth}
			lead={
				<span
					className={`p-icon ${machine ? (word || allOffline ? "is-offline" : "is-machine") : "is-project"}`}
					aria-hidden="true"
				>
					{machine ? word ? <WifiOffIcon /> : <MonitorIcon /> : <FolderIcon />}
				</span>
			}
			title={n.label}
			trail={
				<>
					{word && <span className="p-quiet">{word}</span>}
					<NeedsBadge n={r.needsYou} />
					<span className="p-disclose" aria-hidden="true">
						<ChevronRightIcon />
					</span>
				</>
			}
		/>
	);
}

/** An approval's request in one safe line: invisible characters as markers. */
export function requestLine(item: AttentionItem): ReactNode {
	const ap = item.approval;
	if (!ap) return item.title;
	const input = ap.input as Record<string, unknown>;
	const pick =
		(typeof input.command === "string" && input.command) ||
		(typeof input.file_path === "string" && input.file_path) ||
		(typeof input.path === "string" && input.path) ||
		(typeof input.url === "string" && input.url) ||
		null;
	if (!pick) return item.title;
	const pieces = visible(pick.length > 160 ? pick.slice(0, 160) : pick);
	return (
		<code>
			{pieces.map((p, i) =>
				p.mark === "ctl" ? (
					<span key={i} className="p-mark">
						{p.text}
					</span>
				) : p.mark === "space" ? (
					" "
				) : p.mark === "tab" || p.mark === "nl" ? (
					<span key={i} className="p-mark">
						{p.text}
					</span>
				) : (
					p.text
				),
			)}
		</code>
	);
}

export function NeedsRowView({ item }: { item: AttentionItem }) {
	const t = now.value;
	const approval = item.kind === "approval";
	const terminal = item.kind === "terminal";
	const why = terminal ? terminalWhy(item) : null;
	return (
		<RowShell
			kind="needs"
			lead={
				<span
					className={`p-icon is-needs${approval ? "" : " is-asked"}`}
					aria-hidden="true"
				>
					{approval ? (
						<ShieldCheckIcon />
					) : terminal ? (
						<SquareTerminalIcon />
					) : (
						<MessageCircleQuestionIcon />
					)}
				</span>
			}
			title={item.agent.name}
			sub={
				terminal ? (
					`${terminalTitle(item.agent.machine)}${why ? `. ${why}` : ""}`
				) : approval ? (
					<>
						<span className="p-tool">{item.approval?.tool ?? "Tool"}</span>{" "}
						{requestLine(item)}
					</>
				) : (
					(item.agent.needsYou?.detail ?? "Asked you a question")
				)
			}
			trail={<span className="p-quiet">{age(item.createdAt, t)}</span>}
		/>
	);
}

export function PinRowView({
	label,
	agent,
}: {
	label: string;
	agent: AgentRow | null;
}) {
	if (agent) return <AgentRowView a={agent} withPlace />;
	return (
		<RowShell
			kind="group"
			lead={
				<span className="p-icon is-pin" aria-hidden="true">
					<PinIcon />
				</span>
			}
			title={label}
		/>
	);
}
