/**
 * The phone's navigation stack: an IonNav that mirrors lib/router's history
 * stack. lib/router stays the only writer to history; this file only
 * reconciles IonNav's pages with it. Overlay routes (broadcast, group
 * composer) aren't pages: Overlays.tsx shows them as sheets. An approval
 * route is its agent's page with the prompt card focused.
 *
 * Swipe-back and the back button pop IonNav themselves; ionNavDidChange then
 * tells lib/router (history.back without a second animation).
 */
import { useEffect, useRef } from "react";
import { sessionless } from "../approval/sessionless.ts";
import { back, hrefFor, motion, type Route, stack } from "../lib/router.ts";
import { effect } from "../lib/signals.ts";
import { IonNav } from "./ionic.ts";
import { PageFor, preloadPage } from "./pages.tsx";

/** Routes shown as sheets over the page below them. */
export const isOverlay = (r: Route) =>
	r.view === "node" ||
	r.view === "broadcast" ||
	(r.view === "approval" && sessionless(r.id));

/** The page a route shows (an approval sits on its agent's page). */
function pageOf(r: Route): Route | null {
	if (r.view === "approval")
		return sessionless(r.id) ? null : { view: "agent", id: r.id };
	if (r.view === "node" || r.view === "broadcast") return null;
	return r;
}

/** The pages for a history stack, in order (consecutive duplicates merged). */
export function pagesOf(s: Route[]): Route[] {
	const out: Route[] = [];
	for (const r of s) {
		const p = pageOf(r);
		if (!p) continue;
		const prev = out[out.length - 1];
		if (prev && hrefFor(prev) === hrefFor(p)) continue;
		out.push(p);
	}
	return out;
}

const component = (r: Route) => () => <PageFor route={r} />;

export function PhoneNav() {
	const ref = useRef<HTMLIonNavElement>(null);
	useEffect(() => {
		const nav = ref.current;
		if (!nav) return;
		/** Page keys IonNav holds, as last reconciled. */
		let actual: string[] = [];
		let busy = false;
		let chain: Promise<void> = Promise.resolve();

		const reconcile = async () => {
			const want = pagesOf(stack.peek());
			const keys = want.map(hrefFor);
			let p = 0;
			while (p < actual.length && p < keys.length && actual[p] === keys[p]) p++;
			const animated = motion.peek() !== "none" && actual.length > 0;
			// Push a page whose chunk is in (briefly wait), so it animates in whole.
			await Promise.race([
				Promise.all(want.slice(p).map(preloadPage)).catch(() => {}),
				new Promise((r) => setTimeout(r, 600)),
			]);
			busy = true;
			try {
				if (p === actual.length && keys.length === p + 1 && p > 0)
					await nav.push(component(want[p]!), undefined, { animated });
				else if (p === keys.length && actual.length > p && p > 0)
					await nav.popTo(p - 1, { animated });
				else if (p !== actual.length || p !== keys.length)
					await nav.setPages(
						want.map((r) => ({ component: component(r) })),
						{ animated: false },
					);
				actual = keys;
			} finally {
				busy = false;
			}
		};
		const queue = (_depth: number) => {
			chain = chain.then(reconcile, reconcile);
		};

		// The user popped (swipe-back or the back button): follow in history.
		const onChange = async () => {
			if (busy) return;
			const len = await nav.getLength();
			if (busy || len >= actual.length) return;
			const popped = actual.length - len;
			actual = actual.slice(0, len);
			for (let i = 0; i < popped; i++) back({ animated: false });
		};
		nav.addEventListener("ionNavDidChange", onChange);
		// Pass the read along: a bare `stack.value;` is dropped by the minifier.
		const stop = effect(() => queue(stack.value.length));
		return () => {
			stop();
			nav.removeEventListener("ionNavDidChange", onChange);
		};
	}, []);
	return <IonNav ref={ref} animated swipeGesture />;
}
