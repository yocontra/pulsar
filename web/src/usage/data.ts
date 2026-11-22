/** Reads for the usage page and the session header's usage line. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { api } from "../api/client.ts";
import type { UsagePeriod } from "../api/types.ts";
import { queryClient, useCovered } from "../data/hooks.ts";
import { localTz } from "./model.ts";

/**
 * Fallback re-read (ms): `usage` notices keep this machine's numbers live
 * (data/live.ts); this covers a reconnecting stream and other machines'
 * session lines, which send no notice here.
 */
const POLL_MS = 60_000;

const usageKey = (period: UsagePeriod) => ["usage", period] as const;

/**
 * The report for a period, live: re-read on each `usage` and `limit`
 * notice. The previous period's report stays on screen while the next loads.
 */
export function useUsage(period: UsagePeriod) {
	const covered = useCovered(usageKey(period));
	return useQuery(
		{
			queryKey: usageKey(period),
			queryFn: () => api.usage({ period, tz: localTz() }),
			// Other machines' tokens come only from asking: poll while it shows any.
			refetchInterval: (q) =>
				!covered || (q.state.data?.machines.length ?? 0) > 1 ? POLL_MS : false,
			placeholderData: keepPreviousData,
			retry: 1,
		},
		queryClient,
	);
}

/** Every period's report re-prices after a price edit. */
export function invalidateUsage() {
	return queryClient.invalidateQueries({ queryKey: ["usage"] });
}

/**
 * One agent's usage, for the session header (quiet on errors): live from
 * `usage` notices for this machine's agents, a slow poll for another
 * machine's (a pool address) or while the stream is down.
 */
export function useAgentUsage(agentId: string, enabled = true) {
	const covered = useCovered(["agentUsage", agentId]) && !agentId.includes("/");
	return useQuery(
		{
			queryKey: ["agentUsage", agentId],
			queryFn: () => api.agentUsage(agentId),
			enabled,
			refetchInterval: covered ? false : 30_000,
			staleTime: 15_000,
			retry: false,
		},
		queryClient,
	);
}
