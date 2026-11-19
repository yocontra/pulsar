/** Reads for the usage page and the session header's usage line. */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client.ts";
import type { UsagePeriod, UsageReport } from "../api/types.ts";
import { queryClient } from "../data/hooks.ts";
import { localTz } from "./model.ts";

/** Session files grow while agents work: re-read this often while open (ms). */
const POLL_MS = 60_000;

const usageKey = (period: UsagePeriod) => ["usage", period] as const;

/**
 * The report for a period. The previous period's report stays on screen
 * while the next loads; `refresh` reads new session lines on the daemon
 * first (it answers within a few seconds either way).
 */
export function useUsage(period: UsagePeriod) {
	const [refreshing, setRefreshing] = useState(false);
	const q = useQuery(
		{
			queryKey: usageKey(period),
			queryFn: () => api.usage({ period, tz: localTz() }),
			refetchInterval: POLL_MS,
			placeholderData: keepPreviousData,
			retry: 1,
		},
		queryClient,
	);
	const refresh = async () => {
		setRefreshing(true);
		try {
			const r = await api.usage({ period, tz: localTz(), refresh: true });
			queryClient.setQueryData<UsageReport>(usageKey(period), r);
		} finally {
			setRefreshing(false);
		}
	};
	return { ...q, refresh, refreshing };
}

/** Every period's report re-prices after a price edit. */
export function invalidateUsage() {
	return queryClient.invalidateQueries({ queryKey: ["usage"] });
}

/** One agent's usage, for the session header (slow poll, quiet on errors). */
export function useAgentUsage(agentId: string, enabled = true) {
	return useQuery(
		{
			queryKey: ["agentUsage", agentId],
			queryFn: () => api.agentUsage(agentId),
			enabled,
			refetchInterval: 30_000,
			staleTime: 15_000,
			retry: false,
		},
		queryClient,
	);
}
