import { FolderIcon, LaptopIcon, MegaphoneIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api/client.ts";
import type { AgentRow, AgentsPage, TreeNode } from "../api/types.ts";
import { useAgents as useLiveAgents } from "../data/index.ts";
import { AgentAvatar, AgentStatus, Skeleton } from "../ds/index.ts";
import {
	num,
	plural,
	rollupOf,
	sentence,
	type WAKE_LABEL,
	wakeTotals,
} from "../lib/format.ts";
import { back, navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { nodes, treeVersion } from "../lib/store.ts";
import { CloseX } from "./CloseX.tsx";
import { Composer, type Target } from "./Composer.tsx";
import { Back } from "./icons.tsx";

/**
 * Who a machine/project/selection reaches, with a short preview. A selector
 * is a live query (the data layer keeps it current over the stream); an
 * explicit id list is fetched once.
 */
export function useAgents(
	selectorOrIds: { selector?: string; ids?: string[] },
	limit = 12,
): AgentsPage | null {
	const ids = selectorOrIds.ids;
	const live = useLiveAgents({
		selector: selectorOrIds.selector ?? "",
		limit,
		enabled: !ids,
	});
	const [idsPage, setIdsPage] = useState<AgentsPage | null>(null);
	const key = ids?.join(",") ?? "";
	useEffect(() => {
		setIdsPage(null);
		if (!ids) return;
		let alive = true;
		// An explicit id list: fetch each row (small lists only).
		Promise.all(
			ids.slice(0, limit).map((id) => api.agent(id).catch(() => null)),
		)
			.then((rows) => {
				if (!alive) return;
				const items = rows.filter((r): r is AgentRow => !!r);
				setIdsPage({
					items,
					total: ids.length,
					machines: new Set(items.map((i) => i.machineId)).size,
					totals: wakeTotals(items),
					nextCursor: null,
				});
			})
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [key]);
	if (ids) return idsPage;
	if (!live.data) return null;
	return {
		items: live.items.slice(0, limit),
		total: live.total,
		machines: live.machines,
		totals: live.totals ?? wakeTotals([]),
		nextCursor: null,
	};
}

const WAKE_WORDS: Record<keyof typeof WAKE_LABEL, string> = {
	wakes: "Wakes",
	"inbox-only": "Inbox only",
	held: "Held",
	refuses: "Refuses",
	queued: "Queued",
};

/** The wake most agents in the scope have (from the totals, else the rows). */
function usualWake(
	page: AgentsPage,
): AgentsPage["items"][number]["wake"] | null {
	const counts = new Map<string, number>();
	if (page.totals)
		for (const [k, v] of Object.entries(page.totals)) counts.set(k, v ?? 0);
	else
		for (const a of page.items)
			counts.set(a.wake, (counts.get(a.wake) ?? 0) + 1);
	let best: string | null = null;
	for (const [k, v] of counts)
		if (v > 0 && (!best || v > counts.get(best)!)) best = k;
	return best as AgentsPage["items"][number]["wake"] | null;
}

function PreviewImpl({ page }: { page: AgentsPage | null }) {
	if (!page)
		return (
			<div className="preview loading" aria-busy="true">
				<ul className="preview-list d-card">
					{[0, 1, 2, 3].map((i) => (
						<li key={i} className="d-prev-skel">
							<Skeleton data-shine="" className="d-prev-skel-av" />
							<Skeleton
								style={{ width: `${30 + ((i * 17) % 30)}%`, height: 10 }}
							/>
						</li>
					))}
				</ul>
			</div>
		);
	const more = page.total - page.items.length;
	// Say only what differs between rows: the machine when the scope spans
	// several, the wake word where it is not the usual one (the summary line
	// above counts every kind).
	const oneMachine = page.machines <= 1;
	const usual = usualWake(page);
	return (
		<div className="preview">
			<ul className="preview-list d-card">
				{page.items.map((a) => (
					<li key={a.id}>
						<AgentAvatar harness={a.harness} size="sm" />
						<button
							type="button"
							className="link name"
							onClick={() => navigate({ view: "agent", id: a.id })}
						>
							{a.name}
						</button>
						{!oneMachine && (
							<span className="muted d-prev-machine">{a.machine}</span>
						)}
						<AgentStatus
							state={a.state}
							since={a.stateSince}
							needsReason={a.needsYou?.reason}
							short
							lastSession={a.sessionFrom === "folder"}
							variant={a.state === "needs-you" ? "soft" : "plain"}
							className="d-prev-status"
						/>
						{a.wake !== usual && (
							<span className={`wake w-${a.wake}`}>{WAKE_WORDS[a.wake]}</span>
						)}
					</li>
				))}
			</ul>
			{more > 0 && (
				<p className="muted d-prev-more">And {plural(more, "more agent")}</p>
			)}
		</div>
	);
}

function nodeTitle(n: TreeNode, wide: boolean) {
	// A machine under a project, or a project under a machine.
	if (n.kind === "machine")
		return n.project
			? `Everyone in ${n.project} on ${n.label}`
			: `Everyone on ${n.label}`;
	if (n.machine && !wide) return `Everyone in ${n.label} on ${n.machine}`;
	return `Everyone in ${n.label}`;
}

function broadSelector(n: TreeNode) {
	return n.project === null ? n.selector : `project=${n.project}`;
}

function ScopeViewImpl({ id, mobile }: { id: string; mobile: boolean }) {
	// Reading the version subscribes to tree changes (a bare read statement
	// would be dropped by the minifier).
	const n = treeVersion.value >= 0 ? nodes.get(id) : undefined;
	const [wide, setWide] = useState(false);
	useEffect(() => setWide(false), [id]);
	const selector = n ? (wide ? broadSelector(n) : n.selector) : "";
	const page = useAgents({ selector }, mobile ? 6 : 12);
	if (!n) {
		return (
			<div className="scope empty-state">
				<p>This group isn't loaded. Open it from the tree.</p>
				<button type="button" className="btn" onClick={back}>
					Back
				</button>
			</div>
		);
	}
	// A project under a machine.
	const machineName = n.kind === "project" ? n.machine : null;
	const title = nodeTitle(n, wide);
	const target: Target = {
		kind: "selector",
		selector,
		label: `${title.replace(/^Everyone/, "everyone")} (${selector})`,
	};
	return (
		<section className={`scope${mobile ? " m-scope" : ""}`} aria-label={title}>
			{mobile ? (
				<header className="m-sheet-head m-scope-head">
					<button
						type="button"
						className="m-text-btn"
						onClick={() => navigate({ view: "broadcast", selector })}
					>
						Builder
					</button>
					<div className="m-scope-title">
						<h1>{title}</h1>
						<p>
							{page
								? `${plural(page.total, "agent")} on ${plural(page.machines, "machine")}`
								: `${num(rollupOf(n).agents)} agents`}
						</p>
					</div>
					<CloseX onClick={back} />
				</header>
			) : (
				<header className="pane-header d-scope-head">
					<span className="d-scope-icon" aria-hidden="true">
						{n.kind === "machine" ? <LaptopIcon /> : <FolderIcon />}
					</span>
					<div className="pane-title">
						<h1>{title}</h1>
						<p>
							{page
								? `${plural(page.total, "agent")} on ${plural(page.machines, "machine")}`
								: `${plural(rollupOf(n).agents, "agent")}`}
							{n.reason && (
								<span className="reason">
									{" "}
									· {sentence(n.reason)}: messages wait until it's back
								</span>
							)}
						</p>
					</div>
					<button
						type="button"
						className="d-btn sm"
						onClick={() => navigate({ view: "broadcast", selector })}
						title="Open in Broadcast for filters and a dry run"
					>
						<MegaphoneIcon aria-hidden="true" /> Open in Broadcast
					</button>
				</header>
			)}
			{mobile && n.reason && (
				<p className="m-scope-reason" role="note">
					{sentence(n.reason)}: messages wait until it's back
				</p>
			)}
			{machineName && (n.elsewhere ?? 0) > 0 && (
				<div
					className="seg d-seg scope-toggle"
					role="radiogroup"
					aria-label="Which machines"
				>
					<button
						type="button"
						role="radio"
						aria-checked={!wide}
						className={!wide ? "on" : ""}
						onClick={() => setWide(false)}
					>
						On {machineName}
					</button>
					<button
						type="button"
						role="radio"
						aria-checked={wide}
						className={wide ? "on" : ""}
						onClick={() => setWide(true)}
					>
						On all {n.elsewhere! + 1} machines
					</button>
				</div>
			)}
			<p className="mono selector-line">{selector}</p>
			{page?.totals && (
				<p className="wake-summary">
					{Object.entries(page.totals)
						.filter(([, v]) => v)
						.map(
							([k, v]) =>
								`${WAKE_WORDS[k as keyof typeof WAKE_LABEL]} ${num(v ?? 0)}`,
						)
						.join(" · ")}
				</p>
			)}
			<Preview page={page} />
			<Composer
				// The node, not the selector: the scope radios keep the draft.
				key={id}
				target={target}
				compact={mobile}
				inSheet={mobile}
				placeholder={`Message ${title.replace(/^Everyone/, "everyone")}…`}
				autofocus={!mobile}
			/>
		</section>
	);
}

/** Composer for an explicit id list (multi-select, "message non-repliers"). */
function IdsViewImpl({ ids, mobile }: { ids: string[]; mobile: boolean }) {
	const page = useAgents({ ids }, 12);
	const label = `${plural(ids.length, "selected agent")}`;
	return (
		<section className="scope" aria-label={label}>
			<header className="pane-header d-scope-head">
				{mobile && (
					<button
						type="button"
						className="icon-btn"
						onClick={back}
						aria-label="Back"
					>
						<Back />
					</button>
				)}
				<span className="d-scope-icon" aria-hidden="true">
					<UsersIcon />
				</span>
				<div className="pane-title">
					<h1>Message {label}</h1>
					<p>Sent by id: these agents don't share a selector.</p>
				</div>
			</header>
			<div className="d-scope-gap" />
			<Preview page={page} />
			<Composer
				key={ids.join(",")}
				target={{ kind: "ids", ids, label }}
				compact={mobile}
				autofocus={!mobile}
			/>
		</section>
	);
}

export const Preview = observer(PreviewImpl);
export const ScopeView = observer(ScopeViewImpl);
export const IdsView = observer(IdsViewImpl);
