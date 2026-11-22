/**
 * Which mounted queries the stream keeps live. The daemon's subscription has
 * one slot each for the tree window, the open session, the builder's count
 * and one results page, plus lists of expanded nodes and receipts. The most
 * recently mounted query wins a single slot; a query that gets no slot is
 * not covered and polls instead.
 */
import { hashKey, type QueryKey } from "@tanstack/react-query";
import type {
	AgentSort,
	ChangesMode,
	Subscription,
	TreeGroup,
} from "../api/types.ts";

export interface Mounted {
	key: QueryKey;
	/** Mount order: larger is newer. */
	seq: number;
}

/** Reads that every stream hears without a subscription slot. */
const ALWAYS = new Set(["attention", "approvals", "approval"]);
/** Reads refreshed by `security` notices. */
const SECURITY = new Set(["passkeys", "sessions"]);

export const EMPTY_SUBSCRIPTION: Subscription = {
	expanded: [],
	window: null,
	session: null,
	query: null,
	results: null,
	receipts: [],
};

export function deriveSubscription(mounted: Mounted[]): {
	sub: Subscription;
	/** Hashes of the mounted queries the subscription keeps live. */
	covered: Set<string>;
} {
	const newest = [...mounted].sort((a, b) => b.seq - a.seq);
	const covered = new Set<string>();
	const of = (name: string) => newest.filter((m) => m.key[0] === name);
	const cover = (m: Mounted) => covered.add(hashKey(m.key));

	const tree = of("tree")[0];
	const group = tree?.key[1] as TreeGroup | undefined;
	const filter = (tree?.key[2] as string | undefined) ?? "";
	const window = group ? { group, ...(filter ? { filter } : {}) } : null;
	for (const m of of("tree"))
		if (m.key[1] === group && m.key[2] === filter) cover(m);

	const expanded: string[] = [];
	for (const m of of("children")) {
		// Children topics use the window's filter.
		if ((m.key[2] as string) !== filter) continue;
		const id = m.key[1] as string;
		if (!expanded.includes(id)) expanded.push(id);
		cover(m);
	}

	const sessionQuery = of("transcript")[0] ?? of("agent")[0];
	const session = (sessionQuery?.key[1] as string | undefined) ?? null;
	for (const m of [...of("transcript"), ...of("agent")])
		if (m.key[1] === session) cover(m);

	const count = of("count")[0];
	const query = (count?.key[1] as string | undefined) ?? null;
	for (const m of of("count")) if (m.key[1] === query) cover(m);

	const page = of("agents")[0];
	const results = page
		? {
				selector: page.key[1] as string,
				sort: page.key[2] as AgentSort,
				offset: 0,
				limit: page.key[3] as number,
			}
		: null;
	if (page)
		for (const m of of("agents")) if (sameKey(m.key, page.key)) cover(m);

	const receipts: string[] = [];
	for (const m of of("receipts")) {
		const id = m.key[1] as string;
		if (!receipts.includes(id)) receipts.push(id);
		cover(m);
	}

	// The open changes viewer (the newest one, if two are mounted).
	const viewer = of("changes")[0];
	const changes = viewer
		? {
				agent: viewer.key[1] as string,
				mode: viewer.key[2] as ChangesMode,
			}
		: null;
	if (viewer)
		for (const m of of("changes")) if (sameKey(m.key, viewer.key)) cover(m);

	// Subagent lists on screen (an expanded sidebar row, an agent page).
	const subagents: string[] = [];
	for (const m of of("subagents")) {
		const id = m.key[1] as string;
		if (!subagents.includes(id)) subagents.push(id);
		cover(m);
	}

	// Queue strips on screen (the composer of an open agent).
	const queue: string[] = [];
	for (const m of of("queue")) {
		const id = m.key[1] as string;
		if (!queue.includes(id)) queue.push(id);
		cover(m);
	}

	for (const m of mounted) {
		const name = m.key[0] as string;
		if (ALWAYS.has(name) || SECURITY.has(name)) cover(m);
	}

	return {
		sub: {
			expanded: expanded.sort(),
			window,
			session,
			query,
			results,
			receipts: receipts.sort(),
			// Only while a changes viewer is open (older subscriptions stay as they were).
			...(changes ? { changes } : {}),
			...(subagents.length ? { subagents: subagents.sort() } : {}),
			...(queue.length ? { queue: queue.sort() } : {}),
		},
		covered,
	};
}

function sameKey(a: QueryKey, b: QueryKey) {
	return hashKey(a) === hashKey(b);
}

/** Stable comparison for "did the subscription change". */
export const subscriptionKey = (s: Subscription) => JSON.stringify(s);
