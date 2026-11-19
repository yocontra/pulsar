/**
 * Keeps a query mounted outside React (the store bridge), polling only while
 * the stream does not cover it. The interval is re-evaluated whenever the
 * stream's state or coverage changes, so a dropped stream starts polling
 * without waiting for a fetch.
 */
import {
	hashKey,
	InfiniteQueryObserver,
	type QueryClient,
	QueryObserver,
	type QueryObserverOptions,
} from "@tanstack/react-query";
import type { AgentSort, AgentsPage } from "../api/types.ts";
import type { LiveSync } from "./live.ts";
import { agentsPageFn, type LiveDef, POLL_MS } from "./queries.ts";

export interface Observed {
	stop: () => void;
	/** The interval in force now (false: the stream covers it). */
	interval: () => number | false | undefined;
}

type Observer = {
	options: { refetchInterval?: unknown };
	setOptions: (o: never) => void;
	subscribe: (fn: (r: { data?: unknown }) => void) => () => void;
	getCurrentResult: () => { data?: unknown };
	destroy: () => void;
};

function keepTuned(
	live: LiveSync,
	key: readonly unknown[],
	poll: number | false,
	observer: Observer,
	onData?: (d: unknown) => void,
): Observed {
	const hash = hashKey(key);
	const want = () => (live.isCovered(hash) ? false : poll);
	const off = observer.subscribe((r) => {
		if (r.data !== undefined) onData?.(r.data);
	});
	const cur = observer.getCurrentResult();
	if (cur.data !== undefined) onData?.(cur.data);
	const offState = live.subscribeState(() => {
		const next = want();
		if (observer.options.refetchInterval !== next)
			observer.setOptions({
				...observer.options,
				refetchInterval: next,
			} as never);
	});
	return {
		stop: () => {
			offState();
			off();
			observer.destroy();
		},
		interval: () =>
			observer.options.refetchInterval as number | false | undefined,
	};
}

export function observeLive<T>(
	client: QueryClient,
	live: LiveSync,
	def: LiveDef<T>,
	onData?: (d: T) => void,
): Observed {
	const observer = new QueryObserver(client, {
		queryKey: def.queryKey,
		queryFn: def.queryFn,
		refetchInterval: live.isCovered(hashKey(def.queryKey)) ? false : def.poll,
		...(def.staleTime !== undefined ? { staleTime: def.staleTime } : {}),
	} as QueryObserverOptions);
	return keepTuned(
		live,
		def.queryKey,
		def.poll,
		observer as unknown as Observer,
		onData as (d: unknown) => void,
	);
}

export function observeAgents(
	client: QueryClient,
	live: LiveSync,
	queryKey: readonly unknown[],
	p: { selector: string; sort: AgentSort; limit: number },
	poll: number | false = POLL_MS,
): Observed {
	const observer = new InfiniteQueryObserver<
		AgentsPage,
		Error,
		{ pages: AgentsPage[]; pageParams: (string | null)[] },
		readonly unknown[],
		string | null
	>(client, {
		queryKey,
		queryFn: agentsPageFn(p.selector, p.sort, p.limit),
		initialPageParam: null,
		getNextPageParam: (last) => last.nextCursor,
		refetchInterval: live.isCovered(hashKey(queryKey)) ? false : poll,
	});
	return keepTuned(live, queryKey, poll, observer as unknown as Observer);
}
