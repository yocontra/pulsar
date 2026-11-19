/**
 * One shared clock for relative times ("4m", "Idle 40m"): ticks once a
 * second while the page is visible; no refetch. A module of its own (no
 * TanStack) so initial routes can tick without loading the query layer.
 */
import { useSyncExternalStore } from "react";

let now = Date.now();
const ticks = new Set<() => void>();
let clock: ReturnType<typeof setInterval> | undefined;

function tickSubscribe(fn: () => void) {
	ticks.add(fn);
	if (!clock) {
		now = Date.now();
		clock = setInterval(() => {
			if (typeof document !== "undefined" && document.hidden) return;
			now = Date.now();
			for (const t of [...ticks]) t();
		}, 1000);
	}
	return () => {
		ticks.delete(fn);
		if (!ticks.size) {
			clearInterval(clock);
			clock = undefined;
		}
	};
}

/** The current time, ticking once a second from one shared clock (relative times; no refetch). */
export function useNow(): number {
	return useSyncExternalStore(
		tickSubscribe,
		() => now,
		() => now,
	);
}
