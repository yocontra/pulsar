/**
 * Pure functions that apply stream events to cached query data.
 */
import type {
	AgentRow,
	AgentsPage,
	AttentionList,
	ListUpdate,
	Page,
	TranscriptEvent,
	TreeNode,
} from "../api/types.ts";
import { mergeHistory, mergeLive } from "../session/items.ts";
import { LOCAL_PREFIX, localBaseline, localHeld } from "./pending.ts";

/** A flat, growing list (the tree and its branches). */
export type ListData<T> = Page<T>;

/**
 * Applies a `tree`/`children` update without moving rows the operator sees:
 * changed rows patch in place, removed rows go, new rows go in where the
 * server's `order` puts them (relative to their neighbours). A `full`
 * snapshot also removes held rows it lacks when we hold the whole list.
 */
export function applyListUpdate<T extends { id: string }>(
	held: ListData<T>,
	u: ListUpdate<T>,
): ListData<T> {
	const changed = new Map(u.items.map((n) => [n.id, n]));
	const order = u.full ? u.items.map((n) => n.id) : u.order;
	const removed = new Set(
		u.full
			? held.nextCursor === null
				? held.items.filter((n) => !changed.has(n.id)).map((n) => n.id)
				: []
			: u.removed,
	);
	let items = held.items
		.filter((n) => !removed.has(n.id))
		.map((n) => {
			const c = changed.get(n.id);
			// Live updates may carry only the changed fields' node; keep the rest.
			return c ? { ...n, ...c } : n;
		});
	const heldIds = new Set(items.map((n) => n.id));
	const position = new Map(order.map((id, i) => [id, i]));
	// The last held row in server order: past it, a paged list has not loaded.
	let lastHeld = -1;
	for (const id of heldIds)
		lastHeld = Math.max(lastHeld, position.get(id) ?? -1);
	for (const [id, node] of changed) {
		if (heldIds.has(id)) continue;
		const at = position.get(id);
		if (at === undefined) continue;
		if (held.nextCursor !== null && at > lastHeld) continue;
		// Insert after the nearest earlier row (in server order) that we hold.
		let after = -1;
		for (let i = at - 1; i >= 0 && after < 0; i--) {
			const prev = order[i]!;
			if (heldIds.has(prev)) after = items.findIndex((n) => n.id === prev);
		}
		items = [...items.slice(0, after + 1), node, ...items.slice(after + 1)];
		heldIds.add(id);
	}
	return { items, nextCursor: held.nextCursor, total: u.total };
}

/** Replaces `row` wherever a list holds it; returns the same object when nothing changed. */
export function patchRows<T>(
	list: T[],
	get: (item: T) => AgentRow | null | undefined,
	set: (item: T, row: AgentRow) => T,
	row: AgentRow,
): T[] {
	let hit = false;
	const next = list.map((item) => {
		const cur = get(item);
		if (!cur || cur.id !== row.id || cur === row) return item;
		hit = true;
		return set(item, row);
	});
	return hit ? next : list;
}

export const patchTreeRows = (d: ListData<TreeNode>, row: AgentRow) => {
	const items = patchRows(
		d.items,
		(n) => n.agent,
		(n, a) => ({ ...n, agent: a }),
		row,
	);
	return items === d.items ? d : { ...d, items };
};

export const patchAttentionRows = (d: AttentionList, row: AgentRow) => {
	const items = patchRows(
		d.items,
		(i) => i.agent,
		(i, a) => ({ ...i, agent: a }),
		row,
	);
	return items === d.items ? d : { ...d, items };
};

export const patchPlainRows = (d: { items: AgentRow[] }, row: AgentRow) => {
	const items = patchRows(
		d.items,
		(a) => a,
		(_, a) => a,
		row,
	);
	return items === d.items ? d : { ...d, items };
};

/** The cursor-paged agent list (useInfiniteQuery's shape). */
export interface AgentPages {
	pages: AgentsPage[];
	pageParams: (string | null)[];
}

/** A `results` event replaces the first page (the topic covers offset 0). */
export function applyResults(
	d: AgentPages,
	e: { items: AgentRow[]; total: number; machines: number },
): AgentPages {
	const [first, ...rest] = d.pages;
	if (!first) return d;
	return {
		...d,
		pages: [
			{ ...first, items: e.items, total: e.total, machines: e.machines },
			...rest,
		],
	};
}

// ------------------------------------------------------------ transcripts

export interface TranscriptData {
	events: TranscriptEvent[];
	/** Older history: pass back for the previous page; null at the start. */
	cursor: string | null;
	available: boolean;
}

export { LOCAL_PREFIX };
export const isLocal = (e: TranscriptEvent) => e.id.startsWith(LOCAL_PREFIX);

/**
 * An optimistic line the daemon accepted but never echoed goes after this
 * long. Long: a busy agent or an offline machine echoes late, and the sent
 * message must not vanish from the conversation meanwhile.
 */
export const LOCAL_TTL_MS = 10 * 60_000;

/**
 * Drops optimistic lines once the real line arrived, or once they are
 * older than LOCAL_TTL_MS. A real line matches by its Pulsar message id
 * when the local line has one (stamped when the daemon accepted the send);
 * otherwise by text (a user or peer text event containing the same text,
 * no older than 10 s before the optimistic one) when the real line carries
 * no message id another local line claims, and was not shown yet when the
 * local line was added (`baseline`: the same text sent before). `held`
 * says which lines are still in flight (never expired) or failed (never
 * expired or matched).
 */
export function reconcileLocal(
	events: TranscriptEvent[],
	now = Date.now(),
	held: (id: string) => "sending" | "sent" | "failed" | null = localHeld,
	baseline: (id: string) => ReadonlySet<string> | undefined = localBaseline,
): TranscriptEvent[] {
	if (!events.some(isLocal)) return events;
	const real = events.filter(
		(e) =>
			!isLocal(e) &&
			(e.role === "user" || e.role === "peer") &&
			e.kind === "text",
	);
	const claimed = new Set(
		events
			.filter((e) => isLocal(e) && e.pulsar?.messageId)
			.map((e) => e.pulsar!.messageId!),
	);
	const used = new Set<string>();
	const next = events.filter((e) => {
		if (!isLocal(e)) return true;
		const state = held(e.id);
		if (state === "failed") return true;
		const mid = e.pulsar?.messageId;
		const byId = mid
			? real.find((r) => !used.has(r.id) && r.pulsar?.messageId === mid)
			: undefined;
		const text = e.text.trim();
		const before = baseline(e.id);
		const match =
			byId ??
			real.find(
				(r) =>
					!used.has(r.id) &&
					!before?.has(r.id) &&
					!(r.pulsar?.messageId && claimed.has(r.pulsar.messageId)) &&
					(!mid || !r.pulsar?.messageId) &&
					r.ts >= e.ts - 10_000 &&
					r.text.includes(text),
			);
		if (match) {
			used.add(match.id);
			return false;
		}
		return state === "sending" || now - e.ts <= LOCAL_TTL_MS;
	});
	return next.length === events.length ? events : next;
}

/** Live events: replace by id, append new ones (session/items.ts rules). */
export function applyTranscriptLive(
	d: TranscriptData,
	live: TranscriptEvent[],
): TranscriptData {
	return { ...d, events: reconcileLocal(mergeLive(d.events, live).events) };
}

/** A history page: add only ids we lack, never overwrite (session/items.ts rules). */
export function applyTranscriptPage(
	d: TranscriptData | undefined,
	page: {
		events: TranscriptEvent[];
		cursor: string | null;
		available: boolean;
	},
	older: boolean,
	/**
	 * The newest page only: ids that live events touched while it was in
	 * flight. Every other id the page shares with what we hold takes the
	 * page's copy: a cached transcript (a revisit, a prefetch) got no live
	 * events while closed, so a block that grew or a call that got its
	 * result meanwhile must not stay stale.
	 */
	touched?: ReadonlySet<string>,
): TranscriptData {
	let held = d?.events ?? [];
	if (!older && touched && held.length) {
		const fresh = new Map(page.events.map((e) => [e.id, e]));
		held = held.map((e) => (touched.has(e.id) ? e : (fresh.get(e.id) ?? e)));
	}
	const ids = new Set(page.events.map((e) => e.id));
	const newestTs = Math.max(
		0,
		...held.filter((e) => !isLocal(e)).map((e) => e.ts),
	);
	// A newest page that shares nothing with a held transcript newer than its
	// start skipped a stretch (a gap): start over from that page.
	if (
		!older &&
		d &&
		page.events.length > 0 &&
		held.some((e) => !isLocal(e)) &&
		!held.some((e) => ids.has(e.id)) &&
		Math.min(...page.events.map((e) => e.ts)) > newestTs
	)
		return {
			events: reconcileLocal(mergeHistory(held.filter(isLocal), page.events)),
			cursor: page.cursor,
			available: page.available,
		};
	const events = reconcileLocal(mergeHistory(held, page.events));
	return {
		events,
		// The newest page refreshes what we hold; keep the older cursor we reached.
		cursor: older || !d ? page.cursor : d.cursor,
		available: page.available,
	};
}
