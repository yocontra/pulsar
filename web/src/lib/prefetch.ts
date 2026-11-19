/**
 * Background chunk prefetch that can't take the app down. While any runs,
 * the boot guard (public/boot.js) ignores chunk errors in a booted app: a
 * prefetch cut off by a network blip, a navigation or a reload is not a
 * failed app, and must not reload it under the operator. What failed to
 * prefetch loads when it is used, with its own Retry (lib/lazy.tsx).
 */
declare global {
	interface Window {
		__pulsarPrefetching?: number;
	}
}

export function prefetch(loads: Array<() => Promise<unknown>>): void {
	window.__pulsarPrefetching = (window.__pulsarPrefetching ?? 0) + 1;
	void Promise.allSettled(loads.map((load) => load())).then(() => {
		window.__pulsarPrefetching = Math.max(
			0,
			(window.__pulsarPrefetching ?? 1) - 1,
		);
	});
}
