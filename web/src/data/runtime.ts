/**
 * The app's single QueryClient and event stream, and the browser wiring:
 * hidden tabs pause polling and close the stream after 10 s, coming back
 * resumes it (Last-Event-ID) and refetches; going online refetches.
 */
import {
	focusManager,
	onlineManager,
	QueryClient,
} from "@tanstack/react-query";
import { ApiError, api, openEvents } from "../api/client.ts";
import type { TranscriptEvent } from "../api/types.ts";
import { LiveSync } from "./live.ts";
import { createPrefetcher, installPrefetch } from "./prefetch.ts";

export function createQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				// Stale-while-revalidate: cached data shows while a refetch runs.
				staleTime: 1000,
				gcTime: 5 * 60_000,
				refetchOnWindowFocus: true,
				refetchOnReconnect: true,
				refetchIntervalInBackground: false,
				// A 4xx is an answer; retry only what may pass on a second try.
				retry: (n, err) =>
					n < 1 && !(err instanceof ApiError && err.kind === "http"),
				retryDelay: 500,
			},
			mutations: { retry: false },
		},
	});
}

export const queryClient = createQueryClient();

export const live = new LiveSync({
	client: queryClient,
	transport: openEvents,
	subscribe: (id, sub) => api.subscribe(id, sub).then((reply) => reply.ok),
	frame: (fn) =>
		typeof requestAnimationFrame === "function"
			? requestAnimationFrame(fn)
			: setTimeout(fn, 16),
});

/** Live transcript events for one agent (transcriptDef's `watch`). */
export const watchTranscript = (
	agentId: string,
	fn: (events: TranscriptEvent[]) => void,
): (() => void) =>
	live.on("transcript", (v) => {
		if (v.agentId === agentId) fn(v.events);
	});

/** Loads an agent's row and transcript ahead of opening it (prefetch.ts). */
export const prefetchAgent = createPrefetcher(
	queryClient,
	() => live.flush(),
	watchTranscript,
	() => live.streamId,
);

/** How long a hidden tab keeps its stream open. */
const HIDDEN_CLOSE_MS = 10_000;
let started = false;

/** Opens the stream and wires visibility/online handling (once). */
export function startLive() {
	if (started) return;
	started = true;
	// Subscribes the client to focus and online changes (the provider would).
	queryClient.mount();
	live.start();
	if (typeof document === "undefined") return;
	installPrefetch(document, prefetchAgent);
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	document.addEventListener("visibilitychange", () => {
		clearTimeout(hideTimer);
		if (document.hidden) {
			hideTimer = setTimeout(() => live.stop(), HIDDEN_CLOSE_MS);
		} else if (live.state === "closed") {
			// Resume with Last-Event-ID; the focus refetch covers the rest.
			live.start();
		}
	});
	onlineManager.subscribe((online) => {
		if (online && live.state !== "open") {
			live.stop();
			live.start();
		}
	});
}

export { focusManager, onlineManager };
