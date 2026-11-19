/**
 * Message search: Cmd-K's "In messages" group, the find bar in a session
 * (session.header slot), and the phone's search page (`#/search`, opened
 * from Home's header). Metadata and lazy chunks only.
 */
import { type ComponentType, lazy, Suspense } from "react";
import {
	registerPage,
	registerPaletteProvider,
	registerSlot,
	type SlotProps,
} from "../../lib/registry.tsx";

registerPaletteProvider({
	id: "search.messages",
	group: "In messages",
	order: 100,
	search: async (q, signal) =>
		(await import("./palette.tsx")).messageResults(q, signal),
});

const LazyFind = lazy(() => import("./FindBar.tsx"));
const Find: ComponentType<SlotProps["session.header"]> = (props) => (
	<Suspense fallback={null}>
		<LazyFind {...props} />
	</Suspense>
);
registerSlot("session.header", { id: "search.find", component: Find });

// The phone opens search from Home's header; the desktop has Cmd-K.
const LazyOpen = lazy(() => import("./OpenSearch.tsx"));
registerSlot("sidebar.header", {
	id: "search.open",
	component: ({ mobile }) =>
		mobile ? (
			<Suspense fallback={null}>
				<LazyOpen />
			</Suspense>
		) : null,
});

const loadPage = () => import("./SearchPage.tsx");
const Page = Object.assign(lazy(loadPage), { preload: loadPage });
registerPage({ name: "search", phone: Page });
