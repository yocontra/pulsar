/**
 * Which agents show their subagents in the desktop sidebar, and the lists
 * the data bridge mirrors from the query cache (data/bridge.ts). Collapsed
 * by default; the disclosure under an agent row opens it. No React here, so
 * the tree rows can read it.
 */
import type {
	SubagentCounts,
	SubagentRow,
	SubagentState,
} from "../api/types.ts";
import { nameKey } from "./agent-color.ts";
import { heldFor, plural, stateLabel } from "./format.ts";
import { signal } from "./signals.ts";

/**
 * "Show idle and finished subagents" (Settings), per device: off by default, so the
 * sidebar and the phone's agent page list only running ones. A
 * finished one stays reachable from its parent's transcript card.
 */
const SHOW_KEY = "pulsar.showFinishedSubagents";

function readShow(): boolean {
	try {
		return localStorage.getItem(SHOW_KEY) === "1";
	} catch {
		return false;
	}
}

export const showInactive = signal<boolean>(readShow());

export function setShowInactive(on: boolean) {
	try {
		if (on) localStorage.setItem(SHOW_KEY, "1");
		else localStorage.removeItem(SHOW_KEY);
	} catch {}
	showInactive.value = on;
}

// Another tab on this device changed it.
if (typeof addEventListener === "function")
	addEventListener("storage", (e: Event) => {
		// A StorageEvent (typed loosely: the tests' lib has no DOM).
		const key = (e as Event & { key?: string | null }).key;
		if (key === SHOW_KEY || key === null) showInactive.value = readShow();
	});

/** The rows to list: all, or only those currently running. */
export function visibleSubagents(
	rows: SubagentRow[],
	show: boolean,
): SubagentRow[] {
	return show ? rows : rows.filter((r) => r.state === "running");
}

/**
 * The disclosure's label for an agent's counts, or null when it shows
 * nothing. The collapsed count and expanded list use the same filter.
 */
export function subagentsLabel(
	counts: SubagentCounts | undefined,
	show: boolean,
): string | null {
	if (!counts || counts.total <= 0) return null;
	const { total, running } = counts;
	if (show)
		return `${plural(total, "subagent")}${running ? ` · ${running} running` : ""}`;
	return running > 0 ? plural(running, "running subagent") : null;
}

/** Agents whose subagent rows are open. */
export const subOpen = signal<ReadonlySet<string>>(new Set());

/** Each open agent's subagents, as last fetched; absent while the first page loads. */
export const subLists = new Map<string, SubagentRow[]>();

/** Bumped when `subLists` changes, so rows rebuild. */
export const subVersion = signal(0);

export function setSubagentsOpen(agentId: string, open: boolean) {
	const next = new Set(subOpen.value);
	if (open) next.add(agentId);
	else next.delete(agentId);
	subOpen.value = next;
}

export const toggleSubagents = (agentId: string) =>
	setSubagentsOpen(agentId, !subOpen.value.has(agentId));

export function putSubagents(agentId: string, rows: SubagentRow[]) {
	subLists.set(agentId, rows);
	subVersion.value++;
}

/**
 * Display order: running first, then newest; a nested subagent right under
 * the one that started it, one level deeper.
 */
export function orderSubagents(
	rows: SubagentRow[],
): Array<{ sub: SubagentRow; level: number }> {
	const rank = (r: SubagentRow) => (r.state === "running" ? 0 : 1);
	const sorted = [...rows].sort(
		(a, b) => rank(a) - rank(b) || b.startedAt - a.startedAt,
	);
	const ids = new Set(rows.map((r) => r.id));
	const kids = new Map<string, SubagentRow[]>();
	const top: SubagentRow[] = [];
	for (const r of sorted) {
		if (r.parentSubId && ids.has(r.parentSubId)) {
			const list = kids.get(r.parentSubId) ?? [];
			list.push(r);
			kids.set(r.parentSubId, list);
		} else top.push(r);
	}
	const out: Array<{ sub: SubagentRow; level: number }> = [];
	const seen = new Set<string>();
	const add = (r: SubagentRow, level: number) => {
		if (seen.has(r.id)) return;
		seen.add(r.id);
		out.push({ sub: r, level });
		for (const k of kids.get(r.id) ?? []) add(k, Math.min(level + 1, 3));
	};
	for (const r of top) add(r, 0);
	return out;
}

/** Show a role only if it adds information to the subagent name. */
export function subagentRole(sub: SubagentRow): string | null {
	const role = sub.agentType?.trim();
	return role && nameKey(role) !== nameKey(sub.name) ? role : null;
}

export const STATE_WORD: Record<SubagentState, string> = {
	running: "Running",
	idle: "Idle",
	done: "Done",
};

/** "Running", "Idle 2m" or "Finished 4m ago". */
export function subagentStateText(sub: SubagentRow, now?: number): string {
	if (sub.state === "running") return STATE_WORD.running;
	const at = sub.finishedAt ?? sub.updatedAt;
	if (sub.state !== "done") return stateLabel(STATE_WORD[sub.state], at, now);
	// Never "0s": under a minute it just finished.
	const held = heldFor(at, now);
	return held ? `Finished ${held} ago` : "Finished just now";
}
