/** Plan usage limits in the app: the read of every machine's limits and the settings. */
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/client.ts";
import { queryClient } from "../../data/hooks.ts";

export * from "./text.ts";

export const limitsKey = ["usageLimits"] as const;

/** Every machine's limits and the warning settings (slow poll). */
export function useLimits() {
	return useQuery(
		{
			queryKey: limitsKey,
			queryFn: () => api.usageLimits(),
			staleTime: 60_000,
			refetchInterval: 120_000,
			retry: false,
		},
		queryClient,
	);
}
