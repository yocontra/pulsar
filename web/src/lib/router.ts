/**
 * Hash routes on a history-backed stack, so Android back and the in-app back
 * button behave the same. `#/a/<agentId>` session, `#/n/<nodeId>` scoped
 * composer, `#/broadcast?s=<selector>` builder, `#/needs` needs-you list,
 * `#/approval/<agentId>` approval card, `#/settings`, `#/ask` (phone).
 *
 * `stack` mirrors the history entries this tab pushed, for the phone's
 * navigation stack: screens below the top stay mounted (scroll kept) and the
 * back button names the screen it returns to.
 */
import { hrefFor, parseHash, type Route } from "./hash.ts";
import { signal } from "./signals.ts";

export { hrefFor, parseHash, type Route };

const HOME: Route = { view: "home" };
// Guarded: unit tests render components that import this outside a browser.
const first = parseHash(globalThis.location?.hash ?? "");
let depth =
	(globalThis.history?.state as { depth?: number } | null)?.depth ?? 0;

export const route = signal<Route>(first);
export const stack = signal<Route[]>(
	first.view === "home" ? [first] : [HOME, first],
);
/**
 * How the last change should animate on the phone: an in-app push or pop,
 * or none (replace, a reload, the browser's own back gesture, which already
 * animated, or a swipe-back that finished its own animation).
 */
export const motion = signal<"push" | "pop" | "none">("none");
let pendingPop: "pop" | "none" | null = null;

addEventListener("popstate", (e) => {
	const next = parseHash(location.hash);
	// `PopStateEvent` without naming it: the bun-typed tests reach this file too.
	const state = (e as Event & { state?: unknown }).state;
	const d = (state as { depth?: number } | null)?.depth ?? 0;
	const s = stack.value;
	// Index in `stack` of the entry history moved to (the stack starts at home).
	const top = s.length - 1;
	const base = top - depth;
	const at = Math.max(0, base + d);
	let ns =
		at < top
			? [...s.slice(0, at), next]
			: at > top
				? [...s, next]
				: [...s.slice(0, top), next];
	// After a reload deep in history the stack starts here: home stays under it.
	if (ns[0]?.view !== "home") ns = [HOME, ...ns];
	stack.value = ns;
	motion.value = at < top ? (pendingPop ?? "none") : "none";
	pendingPop = null;
	depth = d;
	route.value = next;
});

export function navigate(r: Route, opts: { replace?: boolean } = {}) {
	const href = hrefFor(r);
	if (href === location.hash || (href === "#/" && !location.hash)) {
		route.value = r;
		return;
	}
	if (opts.replace) {
		history.replaceState({ depth }, "", href);
		stack.value = [...stack.value.slice(0, -1), r];
		motion.value = "none";
	} else {
		history.pushState({ depth: ++depth }, "", href);
		stack.value = [...stack.value, r];
		motion.value = "push";
	}
	route.value = r;
}

/**
 * In-app back: pop the stack when we pushed, else go home. `animated: false`
 * when a swipe-back already moved the screen off. A `sub` entry (a view
 * inside the screen, like the broadcast's facet picker) goes with it.
 */
export function back(opts: { animated?: boolean } | object = {}) {
	const how = "animated" in opts && opts.animated === false ? "none" : "pop";
	if (depth > 0) {
		pendingPop = how;
		const sub = (history.state as { sub?: boolean } | null)?.sub;
		history.go(sub ? -2 : -1);
	} else {
		history.replaceState({ depth: 0 }, "", "#/");
		stack.value = [HOME];
		motion.value = how;
		route.value = HOME;
	}
}
