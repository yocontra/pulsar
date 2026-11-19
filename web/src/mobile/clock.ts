import { signal } from "../lib/signals.ts";

/**
 * One shared clock for relative times ("Idle 4m", "2m ago"): ticks every
 * 15 s while the page is visible, so rows re-render without refetching.
 */
export const now = signal(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
function start() {
	clearInterval(timer);
	now.value = Date.now();
	timer = setInterval(() => {
		now.value = Date.now();
	}, 15_000);
}
document.addEventListener("visibilitychange", () => {
	if (document.hidden) clearInterval(timer);
	else start();
});
start();
