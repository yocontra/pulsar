/**
 * Route → page. Every page renders its own IonHeader and IonContent as
 * direct children of IonNav's page element (no IonPage wrapper), so the iOS
 * push transition can move the titles and back button.
 */

import { lazy } from "../lib/lazy.tsx";
import { prefetch } from "../lib/prefetch.ts";
import type { Route } from "../lib/router.ts";
import Home from "./Home.tsx";
import { PageSkeleton } from "./skeletons.tsx";

const page = <P extends object>(
	load: () => Promise<{ default: React.ComponentType<P> }>,
) => lazy(load);

const Agent = page<{ id: string }>(() => import("./AgentPage.tsx"));
const Needs = page<object>(() => import("./NeedsPage.tsx"));
// In the agent page's chunk (it shares the conversation and composer).
const Subagent = page<{ id: string }>(() =>
	import("./AgentPage.tsx").then((m) => ({ default: m.SubagentPage })),
);
const Ask = page<object>(() => import("./AskPage.tsx"));
const Settings = page<object>(() => import("./SettingsPage.tsx"));
const Ids = page<{ ids: string[] }>(() => import("./IdsPage.tsx"));
const Changes = page<{ id: string; file?: string }>(
	() => import("../changes/ChangesPage.tsx"),
);

/** Load a route's page chunk (the nav awaits it briefly before pushing). */
export function preloadPage(r: Route): Promise<unknown> {
	switch (r.view) {
		case "agent":
		case "approval":
			return Agent.preload();
		case "subagent":
			return Subagent.preload();
		case "needs":
			return Needs.preload();
		case "ask":
			return Ask.preload();
		case "settings":
			return Settings.preload();
		case "ids":
			return Ids.preload();
		case "changes":
			return Changes.preload();
		default:
			return Promise.resolve();
	}
}

/** Every page chunk, fetched in the background after the first paint. */
export function preloadPages() {
	prefetch([Agent, Needs, Ask, Settings, Ids].map((p) => p.preload));
}

export function PageFor({ route }: { route: Route }) {
	switch (route.view) {
		case "home":
			return <Home />;
		case "agent":
			return <Agent id={route.id} />;
		case "subagent":
			return <Subagent id={route.id} />;
		case "needs":
			return <Needs />;
		case "ask":
			return <Ask />;
		case "settings":
			return <Settings />;
		case "ids":
			return <Ids ids={route.ids} />;
		case "changes":
			return (
				<Changes id={route.id} {...(route.file ? { file: route.file } : {})} />
			);
		default:
			return <PageSkeleton title="" />;
	}
}
