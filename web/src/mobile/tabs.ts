/**
 * The phone's tabs: Agents (`#/`), Needs You (`#/needs`), Usage (`#/usage`)
 * and Settings (`#/settings`), over lib/router's history stack.
 *
 * A tab other than Agents is its root route directly above Agents' (the
 * stack's first entry): `[home, needs, …]`. The navigation stack shows a
 * tab from its root (stack.tsx `pagesOf`), so pages pushed on a tab go back
 * to its root, and only a page pushed straight from Agents (or a deep link,
 * `[home, agent]`) goes back to Agents.
 *
 * - Switching tabs is not animated. History holds at most one tab entry
 *   above Agents: leaving Agents pushes it, switching between the other
 *   tabs replaces it, and going to Agents pops it. So Android's back from
 *   any other tab returns to Agents, and from Agents leaves the app.
 *   (Opened straight on a tab or a page, lib/router `seatHome` puts the
 *   Agents entry under it.) docs/app.md, "On a phone".
 * - Each tab keeps its root's scroll position only.
 * - Tapping the active tab scrolls its root to the top (or pops to it).
 */
import { hrefFor, navigate, type Route, stack } from "../lib/router.ts";
import { computed } from "../lib/signals.ts";

export type TabId = "agents" | "needs" | "usage" | "settings";

export const TABS: { id: TabId; route: Route; label: string }[] = [
	{ id: "agents", route: { view: "home" }, label: "Agents" },
	{ id: "needs", route: { view: "needs" }, label: "Needs You" },
	{ id: "usage", route: { view: "page", name: "usage" }, label: "Usage" },
	{ id: "settings", route: { view: "settings" }, label: "Settings" },
];

/** The tab a route is the root of, if any. */
export function tabOf(r: Route | undefined): TabId | null {
	if (!r) return null;
	const href = hrefFor(r);
	return TABS.find((t) => hrefFor(t.route) === href)?.id ?? null;
}

/** Index in `s` where the visible tab's pages start (0 or 1). */
export function tabStart(s: Route[]): number {
	const t = tabOf(s[1]);
	return s[0]?.view === "home" && t && t !== "agents" ? 1 : 0;
}

/** The tab that holds the stack's top page. */
export const activeTab = computed<TabId>(() => {
	const s = stack.value;
	// A tab's route on top is that tab, however it got there (a link that
	// set the hash): the bar shows and switches from there.
	const top = tabOf(s[s.length - 1]);
	if (top) return top;
	return tabStart(s) === 1 ? (tabOf(s[1]) ?? "agents") : "agents";
});

/** The top page is a tab's root: the tab bar shows. */
export const atTabRoot = computed(() => {
	const s = stack.value;
	return tabOf(s[s.length - 1]) !== null;
});

// ---------------------------------------------------------------- scroll

const scrollTops = new Map<TabId, number>();

/** The top page's scroller (its IonContent), once it has one. */
async function topScroller(): Promise<HTMLElement | null> {
	const content = document.querySelector<HTMLIonContentElement>(
		"ion-nav > .ion-page:last-child ion-content",
	);
	return content ? content.getScrollElement() : null;
}

function rememberScroll(tab: TabId) {
	void topScroller().then((el) => {
		if (el) scrollTops.set(tab, el.scrollTop);
	});
}

/** Put a tab root's scroll back once its page is the top one. */
function restoreScroll(tab: TabId) {
	const top = scrollTops.get(tab) ?? 0;
	if (top <= 0) return;
	const end = performance.now() + 1500;
	const tick = async () => {
		const el = await topScroller();
		if (el && activeTab.peek() === tab && el.scrollHeight > el.clientHeight) {
			el.scrollTop = top;
			return;
		}
		if (performance.now() < end) requestAnimationFrame(() => void tick());
	};
	requestAnimationFrame(() => void tick());
}

// ------------------------------------------------------------- switching

/** The tab bar's tap: switch tabs, or pop / scroll the active one. */
export function selectTab(id: TabId) {
	const s = stack.peek();
	const cur = activeTab.peek();
	const start = tabStart(s);
	if (id === cur) {
		const above = s.length - 1 - start;
		// lib/router follows history (popstate), without animating.
		if (above > 0 && !tabOf(s[s.length - 1])) history.go(-above);
		else
			void document
				.querySelector<HTMLIonContentElement>(
					"ion-nav > .ion-page:last-child ion-content",
				)
				?.scrollToTop(300);
		return;
	}
	rememberScroll(cur);
	const tab = TABS.find((t) => t.id === id);
	if (!tab) return;
	// Agents is the stack's first entry: go back to it. Leaving Agents
	// pushes the one tab entry; between other tabs it is replaced.
	if (id === "agents") {
		if (s.length > 1) history.go(-(s.length - 1));
	} else if (cur === "agents" && s.length === 1)
		navigate(tab.route, { animated: false });
	else navigate(tab.route, { replace: true });
	restoreScroll(id);
}
