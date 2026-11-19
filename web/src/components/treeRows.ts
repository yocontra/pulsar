/**
 * The tree as rows (sections, needs-you, pins, machines, projects, agents),
 * shared by the desktop tree and the phone list. No React here, so the phone
 * doesn't load the desktop tree's virtualizer.
 */
import type {
	AgentRow,
	AttentionItem,
	SubagentCounts,
	SubagentRow,
	TreeNode,
} from "../api/types.ts";
import { num, rollupOf } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { computed, signal } from "../lib/signals.ts";
import {
	attention,
	branches,
	expanded,
	loadMore,
	nodes,
	type Pin,
	pins,
	setExpanded,
	treeVersion,
} from "../lib/store.ts";
import {
	orderSubagents,
	showFinished,
	subagentsLabel,
	subLists,
	subOpen,
	subVersion,
	toggleSubagents,
	visibleSubagents,
} from "../lib/subagents.ts";

export type Row =
	| {
			t: "section";
			key: string;
			label: string;
			count?: number;
			more?: () => void;
	  }
	| { t: "attn"; key: string; item: AttentionItem }
	| { t: "recent"; key: string; agent: AgentRow }
	| { t: "pin"; key: string; pin: Pin }
	| { t: "node"; key: string; id: string; depth: number }
	| { t: "offline"; key: string; count: number; open: boolean }
	| {
			t: "more";
			key: string;
			branch: string;
			depth: number;
			remaining: number;
			loading: boolean;
	  }
	| { t: "loading"; key: string; depth: number; i?: number }
	/** Desktop: the disclosure under an agent with subagents. */
	| {
			t: "subs";
			key: string;
			agentId: string;
			counts: SubagentCounts;
			/** "2 running subagents" (subagentsLabel). */
			label: string;
			open: boolean;
			depth: number;
	  }
	/** Desktop: one subagent, indented under its parent agent. */
	| { t: "sub"; key: string; sub: SubagentRow; depth: number };

export const OFFLINE = "!offline";

function isOffline(n: TreeNode) {
	return (
		n.kind === "machine" &&
		rollupOf(n).agents > 0 &&
		rollupOf(n).offline === rollupOf(n).agents
	);
}

function walk(rows: Row[], branchId: string, depth: number) {
	const b = branches.get(branchId);
	if (!b) return;
	let ids = b.ids;
	let offline: string[] = [];
	if (branchId === "") {
		// Unreachable machines sort last; fold them into one group row.
		let i = ids.length;
		while (i > 0 && isOffline(nodes.get(ids[i - 1]!)!)) i--;
		if (ids.length - i >= 2) {
			offline = ids.slice(i);
			ids = ids.slice(0, i);
		}
	}
	const emit = (list: string[], d: number) => {
		for (const id of list) {
			const n = nodes.get(id);
			if (!n) continue;
			rows.push({ t: "node", key: id, id, depth: d });
			if (n.kind === "agent" && !mobileWalk) subagentRows(rows, n, d);
			if (n.kind !== "agent" && expanded.value.has(id)) {
				const cb = branches.get(id);
				if (!cb || (cb.loading && cb.ids.length === 0))
					for (let i = 0; i < (mobileWalk ? 1 : 3); i++)
						rows.push({
							t: "loading",
							key: `${id}~loading${i ? `-${i}` : ""}`,
							depth: d + 1,
							i,
						});
				else walk(rows, id, d + 1);
			}
		}
	};
	emit(ids, depth);
	if (b.nextCursor || (b.loading && branchId === "" && b.ids.length > 0))
		rows.push({
			t: "more",
			key: `${branchId}~more`,
			branch: branchId,
			depth,
			remaining: b.total - b.ids.length,
			loading: b.loading,
		});
	if (offline.length) {
		const open = expanded.value.has(OFFLINE);
		rows.push({ t: "offline", key: OFFLINE, count: offline.length, open });
		if (open) emit(offline, depth + 1);
	}
}

/** An agent's subagent disclosure and, when open, its subagents (desktop). */
function subagentRows(rows: Row[], n: TreeNode, depth: number) {
	const a = n.agent;
	const counts = a?.subagents;
	if (!a || !counts) return;
	// Without "Show finished subagents", an agent with none running or idle
	// shows no disclosure.
	const show = showFinished.value;
	const label = subagentsLabel(counts, show);
	if (!label) return;
	const open = subOpen.value.has(a.id);
	rows.push({
		t: "subs",
		key: `${n.id}~subs`,
		agentId: a.id,
		counts,
		label,
		open,
		depth: depth + 1,
	});
	if (!open) return;
	const list = subLists.get(a.id);
	if (!list) {
		rows.push({ t: "loading", key: `${n.id}~subs-loading`, depth: depth + 1 });
		return;
	}
	for (const { sub, level } of orderSubagents(visibleSubagents(list, show)))
		rows.push({
			t: "sub",
			key: `sub-${sub.id}`,
			sub,
			depth: depth + 1 + level,
		});
}

/** Placeholder rows the desktop sidebar shows while the first page loads. */
export const TOP_SKELETON_ROWS = 12;
let mobileWalk = false;

export function buildRows(mobile: boolean): Row[] {
	mobileWalk = mobile;
	// Read the version so observers re-render on tree changes. A bare
	// `treeVersion.value;` statement is dropped by the minifier.
	// The "Show finished subagents" signal is read in subagentRows, wherever
	// it changes the rows.
	if (treeVersion.value < 0 || subVersion.value < 0) return [];
	const rows: Row[] = [];
	const att = attention.value;
	if (att.length) {
		rows.push({
			t: "section",
			key: "s-needs",
			label: "Needs you",
			count: att.length,
			more: () => navigate({ view: "needs" }),
		});
		// The daemon orders them: approvals first, newest first.
		for (const item of att.slice(0, mobile ? 2 : 3))
			rows.push({ t: "attn", key: `att-${item.id}`, item });
	}
	if (pins.value.length) {
		rows.push({ t: "section", key: "s-pinned", label: "Pinned" });
		for (const p of pins.value)
			rows.push({ t: "pin", key: `pin-${p.id}`, pin: p });
	}
	const top = branches.get("");
	rows.push({
		t: "section",
		key: "s-all",
		label: "All machines",
		count: top?.total,
	});
	if (!top || (top.loading && top.ids.length === 0))
		// Desktop: a full sidebar of placeholder rows, so nothing jumps when
		// the first page lands.
		for (let i = 0; i < (mobile ? 1 : TOP_SKELETON_ROWS); i++)
			rows.push({
				t: "loading",
				key: `top~loading${i ? `-${i}` : ""}`,
				depth: 0,
				i,
			});
	else walk(rows, "", 0);
	return rows;
}

export const focusKey = signal<string | null>(null);
export const desktopRows = computed(() => buildRows(false));
export const mobileRows = computed(() => buildRows(true));

export function nodeLabel(n: TreeNode, open: boolean) {
	const r = rollupOf(n);
	const parts = [n.label, n.kind, `${num(r.agents)} agents`];
	if (r.needsYou) parts.push(`${r.needsYou} need you`);
	if (r.busy) parts.push(`${r.busy} busy`);
	if (n.reason) parts.push(n.reason);
	if (n.kind !== "agent") parts.push(open ? "expanded" : "collapsed");
	return parts.join(", ");
}

export function openNode(n: TreeNode) {
	if (n.kind === "agent" && n.agent)
		navigate({ view: "agent", id: n.agent.id });
	else navigate({ view: "node", id: n.id });
}

export function openRow(row: Row) {
	switch (row.t) {
		case "attn":
			navigate({
				view: row.item.kind === "approval" ? "approval" : "agent",
				id: row.item.agent.id,
			});
			break;
		case "recent":
			navigate({ view: "agent", id: row.agent.id });
			break;
		case "pin":
			if (row.pin.agentId) navigate({ view: "agent", id: row.pin.agentId });
			else navigate({ view: "node", id: row.pin.id });
			break;
		case "node": {
			const n = nodes.get(row.id);
			if (n) openNode(n);
			break;
		}
		case "offline":
			setExpanded(OFFLINE, !row.open);
			break;
		case "subs":
			toggleSubagents(row.agentId);
			break;
		case "sub":
			navigate({ view: "subagent", id: row.sub.id });
			break;
		case "more":
			void loadMore(row.branch);
			break;
		case "section":
			row.more?.();
			break;
	}
}

/** A filter that matched nothing: no tree rows (and none still loading). */
export const noMatch = (rows: Row[], text: string) =>
	!!text &&
	!rows.some(
		(r) =>
			r.t === "node" ||
			r.t === "loading" ||
			r.t === "more" ||
			r.t === "offline",
	);
