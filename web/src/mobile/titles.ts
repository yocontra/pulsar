import { hrefFor, type Route, stack } from "../lib/router.ts";
import { findAgent } from "../lib/store.ts";
import { pagesOf } from "./stack.tsx";
import { TABS } from "./tabs.ts";

export function pageTitle(r: Route): string {
	switch (r.view) {
		case "home":
			return "Agents";
		case "agent":
		case "approval":
			return findAgent(r.id)?.name ?? "Agent";
		case "subagent":
			return "Subagent";
		case "needs":
			return "Needs You";
		case "ask":
			return "Ask";
		case "settings":
			return "Settings";
		case "ids":
			return "Selected";
		case "changes":
			return r.file ? (r.file.split("/").pop() ?? "Diff") : "Changes";
		default:
			// A tab's root page (Usage).
			return TABS.find((t) => hrefFor(t.route) === hrefFor(r))?.label ?? "";
	}
}

/** The back button's label for a page: the title of the page below it. */
export function backTitle(r: Route): string {
	const pages = pagesOf(stack.value);
	const i = pages.findIndex((p) => hrefFor(p) === hrefFor(r));
	const prev = i > 0 ? pages[i - 1] : pages[pages.length - 2];
	const t = prev ? pageTitle(prev) : "Back";
	// iOS shortens long back titles to "Back".
	return t.length > 12 ? "Back" : t;
}
