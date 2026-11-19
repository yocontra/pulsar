/**
 * Pulsar's realtime data layer: TanStack Query driven by the event stream.
 * Import hooks from here. This module is a lazy chunk (the entry stays in
 * its size budget): layouts and the store's boot() load it.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { queryClient } from "./runtime.ts";

export * from "./hooks.ts";
export type { ApprovalSeen, StreamState } from "./live.ts";
export * from "./mutations.ts";
export type { ListData, TranscriptData } from "./patch.ts";
export { isLocal } from "./patch.ts";
export * from "./pending.ts";
export type { Count } from "./queries.ts";
export { POLL_MS } from "./queries.ts";
export { prefetchAgent, startLive } from "./runtime.ts";

/** Optional: hooks pass the client explicitly; this enables useQueryClient(). */
export function DataProvider({ children }: { children: ReactNode }) {
	return createElement(QueryClientProvider, { client: queryClient }, children);
}
