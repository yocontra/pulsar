import {
	ChevronRightIcon,
	FolderIcon,
	LaptopIcon,
	MonitorOffIcon,
	PinIcon,
} from "lucide-react";
import type { AgentRow, AttentionItem, TreeNode } from "../api/types.ts";
import { terminalTitle } from "../approval/terminal.ts";
import { useNow } from "../data/clock.ts";
import { AgentAvatar, AgentStatus, NeedsBadge, Skeleton } from "../ds/index.ts";
import { issueOf } from "../features/issues/open.ts";
import {
	activityLine,
	age,
	fullDate,
	plural,
	rollupOf,
	sentence,
	stateLabel,
} from "../lib/format.ts";
import { route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import {
	expanded,
	nodes,
	selection,
	toggleExpanded,
	toggleSelect,
} from "../lib/store.ts";
import { SubagentsToggle, SubagentTreeRow } from "./SubagentRows.tsx";
import { openNode, openRow, type RowViewProps } from "./Tree.tsx";

/**
 * Desktop sidebar rows. Signal, not noise: group rows show only an amber
 * needs-you count, and a machine's reachability when it isn't normal. Agent
 * rows show the harness, the name, one line of activity and a status word.
 */

/** Left padding for a row at `depth`: each level steps 18 px. */
export const indent = (depth: number) => 4 + depth * 18;

/** Machine reachability, only when it isn't normal. */
export function reachText(n: TreeNode): string | null {
	if (n.kind !== "machine") return null;
	switch (n.link) {
		case "asleep":
			return n.reason ? sentence(n.reason) : "Asleep";
		case "daemon-down":
			return "Offline";
		case "upgrade":
			return "Update Pulsar";
		default:
			return null;
	}
}

/** One line for a needs-you item: "Wants to run Bash", or the question. */
export function needsLine(i: AttentionItem) {
	if (i.kind === "terminal") return terminalTitle(i.agent.machine);
	if (i.kind !== "approval") return i.title;
	// A question, plan or dialog: the daemon's line ("Answer: Auth method").
	if ((i.approval?.kind ?? "permission") !== "permission") return i.title;
	const tool = i.approval?.tool;
	if (tool) return `Wants to run ${tool}`;
	return i.agent.needsYou?.detail ?? "Waiting for your approval";
}

/** The agent's state for screen readers: "busy", "idle 4m", "needs approval". */
function a11yState(a: AgentRow) {
	switch (a.state) {
		case "needs-you":
			return a.needsYou?.reason === "approval"
				? "needs approval"
				: a.needsYou?.reason === "terminal"
					? "waiting in the terminal"
					: "asked you";
		case "idle":
			return stateLabel("idle", a.stateSince);
		default:
			return a.state;
	}
}

function currentId() {
	const r = route.value;
	if (
		r.view === "agent" ||
		r.view === "subagent" ||
		r.view === "approval" ||
		r.view === "node" ||
		r.view === "changes"
	)
		return r.id;
	return null;
}

function RowViewImpl({ row, focused, onContext }: RowViewProps) {
	// Relative times tick from the shared clock (no refetch).
	const now = useNow();
	const cls = focused ? " focused" : "";
	const cur = currentId();
	switch (row.t) {
		case "section":
			if (row.key === "s-all")
				return (
					<div className="d-section" role="presentation">
						<span>Machines</span>
					</div>
				);
			return (
				<div className="d-section" role="presentation">
					<span>{row.label}</span>
					{row.key === "s-needs" && row.count !== undefined && (
						<NeedsBadge
							count={row.count}
							label={`${row.count} waiting on you`}
						/>
					)}
					{row.more && row.count !== undefined && row.count > 3 && (
						<button type="button" className="d-section-more" onClick={row.more}>
							View all
						</button>
					)}
				</div>
			);
		case "attn": {
			const a = row.item.agent;
			return (
				<button
					type="button"
					className={`d-row d-two attn${cls}${cur === a.id ? " current" : ""}`}
					style={{ paddingLeft: indent(0) + 6 }}
					onClick={() => openRow(row)}
					aria-label={`${a.name} on ${a.machine}: ${row.item.title}`}
				>
					<AgentAvatar harness={a.harness} size="md" />
					<span className="d-lines">
						<span className="d-line1">
							<span className="d-name" title={`${a.name} on ${a.machine}`}>
								{a.name}
							</span>
							<span className="d-trail" title={fullDate(row.item.createdAt)}>
								{age(row.item.createdAt, now)}
							</span>
						</span>
						<span className="d-line2 d-needs-line" title={needsLine(row.item)}>
							{needsLine(row.item)}
						</span>
					</span>
				</button>
			);
		}
		case "recent":
			return null;
		case "pin": {
			const n = nodes.get(row.pin.id);
			const r = n ? rollupOf(n) : null;
			const target = row.pin.agentId ?? row.pin.id;
			const pinLabel =
				row.pin.kind === "agent"
					? row.pin.name
					: row.pin.selector
							.replace(/machine=|project=/g, "")
							.replace(" ", " / ");
			return (
				<button
					type="button"
					className={`d-row pin${cls}${cur === target ? " current" : ""}`}
					style={{ paddingLeft: indent(0) + 6 }}
					onClick={() => openRow(row)}
				>
					<PinIcon className="d-ico" />
					<span className="d-name" title={pinLabel}>
						{pinLabel}
					</span>
					<span className="d-trail">
						{r && (
							<NeedsBadge
								count={r.needsYou}
								label={`${r.needsYou} waiting on you`}
							/>
						)}
					</span>
				</button>
			);
		}
		case "loading":
			return (
				<SkeletonRow
					depth={row.depth}
					width={SKELETON_WIDTHS[(row.i ?? 0) % SKELETON_WIDTHS.length]}
				/>
			);
		case "more":
			return (
				<button
					type="button"
					className={`d-row more${cls}`}
					style={{ paddingLeft: indent(row.depth) + 26 }}
					onClick={() => openRow(row)}
				>
					<span className="d-more">
						{row.loading
							? "Loading…"
							: `Show ${plural(Math.max(0, row.remaining), "more", "more")}`}
					</span>
				</button>
			);
		case "offline":
			return (
				<div
					className={`d-row offline-group is-offline${cls}`}
					style={{ paddingLeft: indent(0) }}
				>
					<button
						type="button"
						className="chev"
						aria-expanded={row.open}
						aria-label={`${row.open ? "Collapse" : "Expand"} offline machines`}
						title={`${row.open ? "Collapse" : "Expand"} offline machines`}
						onClick={() => openRow(row)}
						tabIndex={-1}
					>
						<ChevronRightIcon />
					</button>
					<button
						type="button"
						className="row-main"
						onClick={() => openRow(row)}
						aria-expanded={row.open}
					>
						<MonitorOffIcon className="d-ico" />
						<span className="d-name">
							{plural(row.count, "offline machine")}
						</span>
					</button>
				</div>
			);
		case "subs":
			return <SubagentsToggle row={row} focused={focused} />;
		case "sub":
			return (
				<SubagentTreeRow
					row={row}
					focused={focused}
					current={cur === row.sub.id}
				/>
			);
		case "node":
			return (
				<NodeRow
					id={row.id}
					depth={row.depth}
					focused={focused}
					current={cur === row.id || cur === nodes.get(row.id)?.agent?.id}
					onContext={onContext}
				/>
			);
	}
}

const SKELETON_WIDTHS = [0.42, 0.3, 0.5, 0.36, 0.46, 0.28, 0.4, 0.34];

/** A loading row with the same box as a group row. */
export function SkeletonRow({
	depth,
	width = 0.55,
}: {
	depth: number;
	width?: number;
}) {
	return (
		<div
			className="d-row d-skel-row"
			style={{ paddingLeft: indent(depth) }}
			aria-hidden="true"
		>
			<span className="chev-space" />
			<Skeleton data-shine="" className="d-skel-ico" />
			<Skeleton
				data-shine=""
				style={{ height: 10, width: `${Math.round(width * 100)}%` }}
			/>
		</div>
	);
}

function NodeRowImpl({
	id,
	depth,
	focused,
	current,
	onContext,
}: {
	id: string;
	depth: number;
	focused: boolean;
	current: boolean;
	onContext?: (e: React.MouseEvent, n: TreeNode) => void;
}) {
	useNow();
	const n = nodes.get(id);
	if (!n) return null;
	const open = expanded.value.has(id);
	const pad = { paddingLeft: `${indent(depth)}px` };
	const state = `${focused ? " focused" : ""}${current ? " current" : ""}`;
	const ctx = (e: React.MouseEvent) => {
		if (!onContext) return;
		e.preventDefault();
		onContext(e, n);
	};
	if (n.kind === "agent" && n.agent) {
		const a = n.agent;
		const selected = selection.value.has(a.id);
		const click = (e: React.MouseEvent) => {
			if (e.metaKey || e.ctrlKey || e.shiftKey) {
				toggleSelect(a.id);
				return;
			}
			openNode(n);
		};
		const line = activityLine(a);
		const issue = issueOf(a);
		return (
			<button
				type="button"
				className={`d-row d-two node agent${state}${selected ? " selected" : ""}`}
				style={pad}
				role="treeitem"
				aria-level={depth + 1}
				aria-selected={selected}
				aria-current={current ? "page" : undefined}
				aria-label={`${a.name}, ${a11yState(a)}${issue ? `, issue #${issue}` : ""}${a.activity ? `, ${a.activity}` : ""}`}
				data-agent={a.id}
				onClick={click}
				onContextMenu={ctx}
			>
				<AgentAvatar harness={a.harness} size="md" />
				<span className="d-lines">
					<span className="d-line1">
						<span className="d-name" title={`${a.name} on ${a.machine}`}>
							{a.name}
						</span>
						<span className="d-trail">
							<AgentStatus
								state={a.state}
								since={a.stateSince}
								// The short "Needs you" fits the narrow sidebar; line 2
								// says what for ("Wants to run Bash").
								variant={a.state === "needs-you" ? "soft" : "plain"}
								className="d-row-status"
							/>
						</span>
					</span>
					<span className="d-line2" title={line}>
						{issue && <span className="d-issue">#{issue}</span>}
						{line}
					</span>
				</span>
			</button>
		);
	}
	const r = rollupOf(n);
	const reach = reachText(n);
	const offline = r.agents > 0 && r.offline === r.agents;
	const toggle = (e: React.SyntheticEvent) => {
		e.stopPropagation();
		toggleExpanded(id);
	};
	const Icon = n.kind === "machine" ? LaptopIcon : FolderIcon;
	return (
		<div
			className={`d-row node ${n.kind}${state}${offline || reach ? " is-offline" : ""}`}
			style={pad}
			role="treeitem"
			tabIndex={-1}
			aria-level={depth + 1}
			aria-expanded={open}
			aria-label={nodeLabel(n, open, reach)}
			data-node={id}
			onContextMenu={ctx}
		>
			<button
				type="button"
				className="chev"
				aria-label={`${open ? "Collapse" : "Expand"} ${n.label}`}
				title={`${open ? "Collapse" : "Expand"} ${n.label}`}
				aria-expanded={open}
				onClick={toggle}
				tabIndex={-1}
			>
				<ChevronRightIcon />
			</button>
			<button
				type="button"
				className="row-main"
				onClick={() => openNode(n)}
				onDoubleClick={toggle}
			>
				<Icon className="d-ico" />
				<span className="d-name" title={n.label}>
					{n.label}
				</span>
				<span className="d-trail">
					{r.needsYou > 0 ? (
						<NeedsBadge
							count={r.needsYou}
							label={`${r.needsYou} waiting on you`}
						/>
					) : (
						reach && <span className="d-reach">{reach}</span>
					)}
				</span>
			</button>
		</div>
	);
}

function nodeLabel(n: TreeNode, open: boolean, reach: string | null) {
	const r = rollupOf(n);
	const parts = [n.label, n.kind];
	if (r.needsYou) parts.push(`${plural(r.needsYou, "agent")} waiting on you`);
	if (reach) parts.push(reach);
	parts.push(open ? "expanded" : "collapsed");
	return parts.join(", ");
}

const NodeRow = observer(NodeRowImpl);
export const DesktopRow = observer(RowViewImpl);
