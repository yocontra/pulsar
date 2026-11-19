/**
 * Typed hooks for every server read. Each one is a TanStack query on the
 * app's single client (passed explicitly, so no provider is needed) and
 * stays live: the event stream patches it while it covers the topic;
 * otherwise (stream down, topic without push) it polls. Polling pauses
 * while the tab is hidden; focus, reconnect and stream gaps refetch.
 * Refetches keep showing the previous data (no empty flashes).
 */
import {
	hashKey,
	keepPreviousData,
	type UseQueryResult,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import type {
	AgentRow,
	AgentSort,
	AskRequest,
	AttentionItem,
	FacetKey,
	TranscriptEvent,
	TreeGroup,
	TreeNode,
	TreeSort,
} from "../api/types.ts";
import { useNow } from "./clock.ts";
import { keys } from "./keys.ts";
import { type ApprovalSeen, OUTCOME_MS } from "./live.ts";
import type { ListData, TranscriptData } from "./patch.ts";
import {
	agentsPageFn,
	type Count,
	defs,
	fetchEarlierTranscript,
	fetchMoreTree,
	type LiveDef,
	transcriptDef,
} from "./queries.ts";
import { live, queryClient, watchTranscript } from "./runtime.ts";

export { keys, live, queryClient };

// ------------------------------------------------------------ plumbing

/** Whether the stream keeps this key live right now. */
export function useCovered(queryKey: readonly unknown[]): boolean {
	const hash = hashKey(queryKey);
	return useSyncExternalStore(
		(fn) => live.subscribeState(fn),
		() => live.isCovered(hash),
		() => false,
	);
}

/** A live query from a definition; `enabled: false` waits (e.g. no id yet). */
export function useLive<T>(
	def: LiveDef<T>,
	opts: { enabled?: boolean; keepPrevious?: boolean } = {},
): UseQueryResult<T> {
	const covered = useCovered(def.queryKey);
	return useQuery(
		{
			queryKey: def.queryKey,
			queryFn: def.queryFn,
			refetchInterval: covered ? false : def.poll,
			...(def.staleTime !== undefined ? { staleTime: def.staleTime } : {}),
			enabled: opts.enabled ?? true,
			...(opts.keepPrevious ? { placeholderData: keepPreviousData } : {}),
		},
		queryClient,
	) as UseQueryResult<T>;
}

export type ConnectionState = "live" | "reconnecting" | "offline";

/** For the chrome's indicator: the stream is live, reconnecting, or the network is gone. */
export function useConnection(): ConnectionState {
	return useSyncExternalStore(
		(fn) => {
			const off = live.subscribeState(fn);
			addEventListener("online", fn);
			addEventListener("offline", fn);
			return () => {
				off();
				removeEventListener("online", fn);
				removeEventListener("offline", fn);
			};
		},
		() => connectionState(live.state, navigator.onLine),
		() => "reconnecting",
	);
}

export function connectionState(
	stream: typeof live.state,
	online: boolean,
): ConnectionState {
	if (stream === "open") return "live";
	return online ? "reconnecting" : "offline";
}

/** Runs `fn` for each live event of a type (transcript batches, gaps, receipts…). */
export function useLiveEvent<K extends Parameters<typeof live.on>[0]>(
	type: K,
	fn: Parameters<typeof live.on<K>>[1],
) {
	const ref = useRef(fn);
	ref.current = fn;
	useEffect(
		() =>
			live.on(type, ((v: never) =>
				(ref.current as (x: never) => void)(v)) as never),
		[type],
	);
}

// ------------------------------------------------------------ reads

export const useHello = () => useLive(defs.hello());

/** The tree's top level for a grouping/filter/sort, plus paging. */
export function useTree(p: {
	group: TreeGroup;
	filter: string;
	sort: TreeSort;
}) {
	const def = defs.tree(queryClient, p.group, p.filter, p.sort);
	const q = useLive(def, { keepPrevious: true });
	const fetchMore = useCallback(
		() => fetchMoreTree(queryClient, def.queryKey),
		[hashKey(def.queryKey)],
	);
	return { ...q, fetchMore };
}

/** One branch's children; mount it only while the branch is expanded. */
export function useTreeChildren(
	nodeId: string,
	p: { filter: string; sort: TreeSort },
	enabled = true,
) {
	const def = defs.children(nodeId, p.filter, p.sort);
	const q = useLive<ListData<TreeNode>>(def, { enabled, keepPrevious: true });
	const fetchMore = useCallback(
		() => fetchMoreTree(queryClient, def.queryKey),
		[hashKey(def.queryKey)],
	);
	return { ...q, fetchMore };
}

/**
 * A cursor-paged list of agents for a selector. The first page stays live
 * over the stream (one `results` slot: the newest mounted list wins).
 */
export function useAgents(p: {
	selector: string;
	sort?: AgentSort;
	limit?: number;
	enabled?: boolean;
}) {
	const sort = p.sort ?? "attention";
	const limit = p.limit ?? 50;
	const queryKey = keys.agents(p.selector, sort, limit);
	const covered = useCovered(queryKey);
	const q = useInfiniteQuery(
		{
			queryKey,
			queryFn: agentsPageFn(p.selector, sort, limit),
			initialPageParam: null as string | null,
			getNextPageParam: (last) => last.nextCursor,
			refetchInterval: covered ? false : 2000,
			placeholderData: keepPreviousData,
			enabled: p.enabled ?? true,
		},
		queryClient,
	);
	const items = useMemo(
		() => q.data?.pages.flatMap((pg) => pg.items) ?? [],
		[q.data],
	);
	const first = q.data?.pages[0];
	return {
		...q,
		items,
		total: first?.total ?? 0,
		machines: first?.machines ?? 0,
		totals: first?.totals,
	};
}

/** Live match count, machines and wake totals for a selector (the builder). */
export const useAgentCount = (selector: string | null) =>
	useLive<Count>(defs.count(selector ?? ""), {
		enabled: selector !== null,
		keepPrevious: true,
	});

/** One agent's row (the session header); patched from every list that shows it. */
export const useAgent = (id: string | null) =>
	useLive<AgentRow>(defs.agent(id ?? ""), {
		enabled: id !== null,
	});

/** Who waits on the operator: approvals first, newest first. */
export const useAttention = () => useLive(defs.attention());

/** The needs-you items and their count (the badge). */
export function useNeedsYou(): { items: AttentionItem[]; count: number } {
	const { data } = useAttention();
	return useMemo(
		() => ({ items: data?.items ?? [], count: data?.items.length ?? 0 }),
		[data],
	);
}

export const useRecent = () => useLive(defs.recent());

export const useFacets = (p: {
	selector: string;
	facet: FacetKey;
	q?: string;
	top?: number;
	enabled?: boolean;
}) =>
	useLive(defs.facets(p.selector, p.facet, p.q ?? "", p.top ?? 20), {
		enabled: p.enabled ?? true,
		keepPrevious: true,
	});

export const useSearch = (q: string) =>
	useLive(defs.search(q), { enabled: q.trim() !== "", keepPrevious: true });

/** Receipts for one sent message; they stream in while mounted. */
export const useReceipts = (messageId: string | null) =>
	useLive(defs.receipts(messageId ?? ""), { enabled: messageId !== null });

/** Approvals as `approval` events showed them (with when each arrived). */
export function useApprovals(): ApprovalSeen[] {
	const { data } = useQuery(
		{
			queryKey: keys.approvals(),
			queryFn: () =>
				queryClient.getQueryData<ApprovalSeen[]>(keys.approvals()) ?? [],
			staleTime: Number.POSITIVE_INFINITY,
			initialData: [],
		},
		queryClient,
	);
	return data;
}

export const useApproval = (requestId: string | null) =>
	useLive(defs.approval(requestId ?? ""), { enabled: requestId !== null });

/**
 * The approval card for an agent: its pending prompt, or for a minute after
 * it ended, the outcome.
 */
export function useApprovalItem(agentId: string): AttentionItem | undefined {
	const { items } = useNeedsYou();
	const seen = useApprovals();
	const now = useNow();
	return approvalItemFrom(agentId, items, seen, now);
}

export function approvalItemFrom(
	agentId: string,
	attention: AttentionItem[],
	seen: ApprovalSeen[],
	now: number,
	findAgent: (id: string) => AgentRow | null = () => null,
): AttentionItem | undefined {
	const pending = attention.find((a) => a.agent.id === agentId && a.approval);
	if (pending) return pending;
	let ended: ApprovalSeen | undefined;
	for (const s of seen)
		if (
			s.approval.agentId === agentId &&
			s.approval.state !== "pending" &&
			now - s.at < OUTCOME_MS &&
			(!ended || s.at > ended.at)
		)
			ended = s;
	if (!ended) return undefined;
	const agent =
		findAgent(agentId) ??
		queryClient.getQueryData<AgentRow>(keys.agent(agentId)) ??
		null;
	if (!agent) return undefined;
	return {
		id: `ended:${ended.approval.requestId}`,
		kind: "approval",
		agent,
		title: ended.approval.outcome ?? "Approval",
		createdAt: ended.approval.createdAt,
		approval: ended.approval,
	};
}

/**
 * An agent's transcript: the newest page plus any older pages loaded, with
 * live events merged by id (replace in place, append new). A gap re-pages.
 */
export function useTranscript(agentId: string | null) {
	const def = transcriptDef(
		queryClient,
		agentId ?? "",
		() => live.flush(),
		watchTranscript,
		() => live.streamId,
	);
	const q = useLive<TranscriptData>(def, { enabled: agentId !== null });
	const loadEarlier = useCallback(
		() =>
			agentId
				? fetchEarlierTranscript(queryClient, agentId)
				: Promise.resolve(0),
		[agentId],
	);
	return {
		...q,
		events: q.data?.events ?? EMPTY_EVENTS,
		cursor: q.data?.cursor ?? null,
		available: q.data?.available ?? true,
		loadEarlier,
	};
}
const EMPTY_EVENTS: TranscriptEvent[] = [];

/** An agent's subagents, live while mounted; `enabled: false` waits. */
export function useSubagents(agentId: string | null, enabled = true) {
	return useLive(defs.subagents(agentId ?? ""), {
		enabled: enabled && agentId !== null,
	});
}

/** One subagent (its page): name, state, parent, where messages go. */
export const useSubagent = (id: string) => useLive(defs.subagent(id));

export const useSessions = () => useLive(defs.sessions());
export const usePasskeys = () => useLive(defs.passkeys());
export const usePushKey = () => useLive(defs.pushKey());

/** Who works on what (`POST /ask`; wakes nobody). Null: no question yet. */
export const useAsk = (req: AskRequest | null) =>
	useLive(defs.ask(req ?? { question: "" }), {
		enabled: req !== null && req.question.trim() !== "",
		keepPrevious: true,
	});

export { useNow };

/** Refetch every mounted read now (pull to refresh); resolves when done. */
export function refetchAll(): Promise<void> {
	return queryClient.invalidateQueries({ refetchType: "active" });
}
