/**
 * Query definitions shared by the hooks and the store bridge: key, fetcher
 * and how often to poll when the stream does not keep the read live.
 */
import type { QueryClient } from "@tanstack/react-query";
import { api, dropStaleSession, setSessionPersist } from "../api/client.ts";
import type {
	AgentRow,
	AgentSort,
	Approval,
	AttentionList,
	FacetKey,
	Hello,
	SubagentRow,
	TranscriptEvent,
	TreeGroup,
	TreeNode,
	TreeSort,
	Wake,
} from "../api/types.ts";
import { e2eNumber } from "../lib/e2e.ts";
import { keys } from "./keys.ts";
import {
	type AgentPages,
	applyTranscriptLive,
	applyTranscriptPage,
	type ListData,
	type TranscriptData,
} from "./patch.ts";

/** Polling when the stream is down or a read has no push (ms). */
export const POLL_MS = 2000;

export interface LiveDef<T> {
	queryKey: readonly unknown[];
	queryFn: (ctx: { signal: AbortSignal }) => Promise<T>;
	/** Poll interval when not covered by the stream; false: never poll. */
	poll: number | false;
	staleTime?: number;
}

/** Tree pages: refetches keep at least as many rows as are loaded. */
const TREE_PAGE = 100;
const TREE_MAX = 500;

let treeExpand: string | null = null;
/**
 * The next top-level tree fetch also asks for these branches' children
 * (once): `default` on a device's first visit, so the branches the app opens
 * by default paint with the top level. public/preload.js asks the same.
 */
export function expandNextTree(expand: string | null) {
	treeExpand = expand;
}

export interface Count {
	total: number;
	machines: number;
	totals: Record<Wake, number>;
}

/** What /hello says about this browser's passkey session; returns `h`. */
export function applyHello(h: Hello): Hello {
	// A token the daemon no longer knows (expired, revoked): drop it, so the
	// next action opens Prove Human instead of sending unverified.
	dropStaleSession(h);
	setSessionPersist(h.persistSession === true);
	return h;
}

export const defs = {
	hello: (): LiveDef<Hello> => ({
		queryKey: keys.hello(),
		queryFn: async () => applyHello(await api.hello()),
		// No push: features and counts change rarely.
		poll: 10_000,
	}),
	attention: (): LiveDef<AttentionList> => ({
		queryKey: keys.attention(),
		queryFn: () => api.attention(),
		poll: POLL_MS,
	}),
	recent: (): LiveDef<{ items: AgentRow[] }> => ({
		queryKey: keys.recent(),
		queryFn: () => api.recent(),
		poll: POLL_MS,
	}),
	tree: (
		client: QueryClient,
		group: TreeGroup,
		filter: string,
		sort: TreeSort,
	): LiveDef<ListData<TreeNode>> => {
		const queryKey = keys.tree(group, filter, sort);
		return {
			queryKey,
			queryFn: async () => {
				const held = client.getQueryData<ListData<TreeNode>>(queryKey);
				const limit = Math.min(
					TREE_MAX,
					Math.max(TREE_PAGE, held?.items.length ?? 0),
				);
				const expand = group === "machines" && !filter ? treeExpand : null;
				treeExpand = null;
				const { expanded, ...top } = await api.tree({
					group,
					filter,
					sort,
					limit,
					cursor: null,
					expand,
				});
				// The included branches seed their own queries (unless already held).
				for (const [id, p] of Object.entries(expanded ?? {})) {
					const key = keys.children(id, filter, sort);
					if (client.getQueryData(key) === undefined)
						client.setQueryData<ListData<TreeNode>>(key, {
							items: p.items,
							total: p.total,
							nextCursor: p.nextCursor,
						});
				}
				return top;
			},
			poll: POLL_MS,
		};
	},
	children: (
		nodeId: string,
		filter: string,
		sort: TreeSort,
	): LiveDef<ListData<TreeNode>> => ({
		queryKey: keys.children(nodeId, filter, sort),
		queryFn: () => api.children(nodeId, { filter, sort }),
		poll: POLL_MS,
	}),
	agent: (id: string): LiveDef<AgentRow> => ({
		queryKey: keys.agent(id),
		queryFn: () => api.agent(id),
		poll: POLL_MS,
	}),
	subagents: (agentId: string): LiveDef<ListData<SubagentRow>> => ({
		queryKey: keys.subagents(agentId),
		queryFn: async () => {
			const l = await api.subagents(agentId);
			return { items: l.items, total: l.total, nextCursor: null };
		},
		poll: 5000,
	}),
	subagent: (id: string): LiveDef<SubagentRow> => ({
		queryKey: keys.subagent(id),
		queryFn: () => api.subagent(id),
		poll: 5000,
	}),
	count: (selector: string): LiveDef<Count> => ({
		queryKey: keys.count(selector),
		queryFn: async ({ signal }) => {
			const p = await api.agents({ selector, limit: 1 }, signal);
			return { total: p.total, machines: p.machines, totals: p.totals };
		},
		poll: POLL_MS,
	}),
	approval: (requestId: string): LiveDef<Approval> => ({
		queryKey: keys.approval(requestId),
		queryFn: () => api.approval(requestId),
		poll: POLL_MS,
	}),
	receipts: (messageId: string) => ({
		queryKey: keys.receipts(messageId),
		queryFn: () => api.receipts(messageId),
		poll: POLL_MS,
	}),
	facets: (selector: string, facet: FacetKey, q = "", top = 20) => ({
		queryKey: keys.facets(selector, facet, q, top),
		queryFn: ({ signal }: { signal: AbortSignal }) =>
			api.facets({ selector, facet, q, top }, signal),
		poll: 5000 as const,
	}),
	search: (q: string) => ({
		queryKey: keys.search(q),
		queryFn: ({ signal }: { signal: AbortSignal }) => api.search(q, signal),
		poll: 5000 as const,
	}),
	sessions: () => ({
		queryKey: keys.sessions(),
		queryFn: () => api.sessions(),
		poll: 10_000 as const,
	}),
	passkeys: () => ({
		queryKey: keys.passkeys(),
		queryFn: () => api.passkeys(),
		poll: 10_000 as const,
	}),
	pushKey: () => ({
		queryKey: keys.pushKey(),
		queryFn: () => api.pushKey(),
		poll: false as const,
		staleTime: Number.POSITIVE_INFINITY,
	}),
};

/**
 * The newest transcript page, merged into what we hold (older pages and
 * live events stay; the page refreshes the rest, see applyTranscriptPage). Subscribes first (`flush`), so live events that land
 * between the subscription and the page merge in by id.
 */
export function transcriptDef(
	client: QueryClient,
	agentId: string,
	flush: () => Promise<void>,
	/** Calls back with live events for this agent; returns off. */
	watch?: (
		agentId: string,
		fn: (events: TranscriptEvent[]) => void,
	) => () => void,
	/** The open event stream's id, if any (the page then subscribes it). */
	stream?: () => string | null,
): LiveDef<TranscriptData> {
	const queryKey = keys.transcript(agentId);
	return {
		queryKey,
		queryFn: async () => {
			const touched = new Map<string, TranscriptEvent>();
			const off = watch?.(agentId, (events) => {
				for (const event of events) touched.set(event.id, event);
			});
			try {
				// The daemon follows the transcript for this stream before it reads
				// the page (`?stream=`), so the page need not wait for the
				// subscription's round trip: both go out at once. No stream yet:
				// the page alone (the stream's ready re-subscribes).
				const id = stream?.() ?? null;
				const [, p] = await Promise.all([
					id ? flush().catch(() => {}) : flush(),
					api.transcript(agentId, null, id),
				]);
				const merged = applyTranscriptPage(
					client.getQueryData<TranscriptData>(queryKey),
					p,
					false,
					new Set(touched.keys()),
				);
				// Before the first page there may be no query data to patch.
				return touched.size
					? applyTranscriptLive(merged, [...touched.values()])
					: merged;
			} finally {
				off?.();
			}
		},
		// An end-to-end test may ask sooner (`__pulsarE2E.transcriptPollMs`).
		poll: e2eNumber("transcriptPollMs") ?? POLL_MS,
	};
}

/** Fetches the next page of a tree branch ("" is the top level) into the cache. */
export async function fetchMoreTree(
	client: QueryClient,
	queryKey: readonly unknown[],
): Promise<void> {
	const held = client.getQueryData<ListData<TreeNode>>(queryKey);
	if (!held?.nextCursor) return;
	const [name, a, filter, sort] = queryKey as [
		string,
		string,
		string,
		TreeSort,
	];
	const page =
		name === "tree"
			? await api.tree({
					group: a as TreeGroup,
					filter,
					sort,
					cursor: held.nextCursor,
					limit: TREE_PAGE,
				})
			: await api.children(a, { cursor: held.nextCursor, filter, sort });
	client.setQueryData<ListData<TreeNode>>(queryKey, (d) => {
		if (!d) return d;
		const seen = new Set(d.items.map((n) => n.id));
		return {
			items: [...d.items, ...page.items.filter((n) => !seen.has(n.id))],
			nextCursor: page.nextCursor,
			total: page.total,
		};
	});
}

/**
 * Fetches the previous (older) transcript page into the cache; resolves
 * with how many events it added (0: none, or no older page).
 */
export async function fetchEarlierTranscript(
	client: QueryClient,
	agentId: string,
): Promise<number> {
	const key = keys.transcript(agentId);
	const held = client.getQueryData<TranscriptData>(key);
	if (!held?.cursor) return 0;
	const p = await api.transcript(agentId, held.cursor);
	const before = client.getQueryData<TranscriptData>(key)?.events.length ?? 0;
	client.setQueryData<TranscriptData>(key, (d) =>
		applyTranscriptPage(d, p, true),
	);
	return (
		(client.getQueryData<TranscriptData>(key)?.events.length ?? 0) - before
	);
}

export const agentsPageFn =
	(selector: string, sort: AgentSort, limit: number) =>
	({ pageParam, signal }: { pageParam: string | null; signal: AbortSignal }) =>
		api.agents({ selector, sort, limit, cursor: pageParam }, signal);

export type { AgentPages };
