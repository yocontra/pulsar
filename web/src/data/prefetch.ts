/**
 * Opening an agent feels instant: its row and newest transcript page load
 * into the cache when the pointer rests on its row (desktop, after a short
 * hover) or a finger lands on it (phone). One delegated listener covers
 * every element with `data-agent="<id>"` or `data-prefetch-agent="<id>"`.
 * A prefetch adds no observer, so the stream subscription does not change.
 */
import type { QueryClient } from "@tanstack/react-query";
import { defs, transcriptDef } from "./queries.ts";

/** A prefetch younger than this is not repeated (the session refetches anyway). */
export const PREFETCH_FRESH_MS = 15_000;
/** Hover this long before prefetching (a pointer passing over rows doesn't). */
export const HOVER_MS = 90;
/** At most this many prefetches in flight: a slow daemon isn't flooded. */
export const MAX_IN_FLIGHT = 2;

export function createPrefetcher(
	client: QueryClient,
	flush: () => Promise<void>,
	watch?: Parameters<typeof transcriptDef>[3],
	stream?: Parameters<typeof transcriptDef>[4],
) {
	let inFlight = 0;
	const recent = new Map<string, number>();
	return function prefetchAgent(id: string, now = Date.now()): boolean {
		if (!id || inFlight >= MAX_IN_FLIGHT) return false;
		const last = recent.get(id);
		if (last !== undefined && now - last < PREFETCH_FRESH_MS) return false;
		recent.set(id, now);
		if (recent.size > 200) recent.delete(recent.keys().next().value!);
		inFlight++;
		const agent = defs.agent(id);
		const t = transcriptDef(client, id, flush, watch, stream);
		void Promise.allSettled([
			client.prefetchQuery({
				queryKey: agent.queryKey,
				queryFn: agent.queryFn,
				staleTime: PREFETCH_FRESH_MS,
			}),
			client.prefetchQuery({
				queryKey: t.queryKey,
				queryFn: t.queryFn,
				staleTime: PREFETCH_FRESH_MS,
			}),
		]).finally(() => {
			inFlight--;
		});
		return true;
	};
}

const agentOf = (t: EventTarget | null): string | null => {
	if (!(t instanceof Element)) return null;
	const el = t.closest<HTMLElement>("[data-agent],[data-prefetch-agent]");
	return el?.dataset.agent ?? el?.dataset.prefetchAgent ?? null;
};

/** Wires the document: hover intent on mouse, touchstart on touch. */
export function installPrefetch(
	doc: Document,
	prefetch: (id: string) => boolean,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let over: string | null = null;
	doc.addEventListener("pointerover", (e) => {
		if (e.pointerType !== "mouse") return;
		const id = agentOf(e.target);
		if (id === over) return;
		over = id;
		clearTimeout(timer);
		if (id) timer = setTimeout(() => prefetch(id), HOVER_MS);
	});
	doc.addEventListener(
		"touchstart",
		(e) => {
			const id = agentOf(e.target);
			if (id) prefetch(id);
		},
		{ passive: true },
	);
	// Keyboard focus (arrow keys through the tree) counts as intent too.
	doc.addEventListener("focusin", (e) => {
		const id = agentOf(e.target);
		if (id) prefetch(id);
	});
}
