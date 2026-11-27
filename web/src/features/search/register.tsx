/**
 * Message search: Cmd-K's "In messages" group, the find bar in a session
 * (session.header slot), Home's "In messages" section on the phone
 * (home.search slot) and its search page (`#/search`, "See all" there). Metadata and lazy chunks only.
 */
import { SearchIcon } from "lucide-react";
import { type ComponentType, createElement, lazy, Suspense } from "react";
import {
	registerPage,
	registerPaletteProvider,
	registerSlot,
	type SlotProps,
} from "../../lib/registry.tsx";

registerPaletteProvider({
	id: "search.sessions",
	group: "Saved conversations on this machine",
	order: 90,
	search: async (q, signal) =>
		(await import("./palette.tsx")).savedResults(q, signal),
});

registerPaletteProvider({
	id: "search.messages",
	group: "In messages",
	order: 100,
	search: async (q, signal) =>
		(await import("./palette.tsx")).messageResults(q, signal),
});

const LazyFind = lazy(() => import("./FindBar.tsx"));

/**
 * The Find button as it looks before its chunk loads: same markup and size,
 * inert, so the header's other actions don't move when the real one lands
 * (a tooltip or click aimed at them would miss). The phone uses the bare
 * `ion-button` element, which PhoneApp has already defined.
 */
function FindPlaceholder({ mobile }: { mobile: boolean }) {
	if (mobile)
		return (
			<span className="p-find-btn">
				{createElement(
					"ion-button",
					{ "aria-label": "Find in messages", disabled: true },
					<SearchIcon />,
				)}
			</span>
		);
	return (
		<span>
			<button
				type="button"
				className="d-btn sm msr-toggle"
				aria-label="Find in messages"
				disabled
			>
				<SearchIcon aria-hidden="true" />
				<span className="d-btn-label">Find</span>
			</button>
		</span>
	);
}

const Find: ComponentType<SlotProps["session.header"]> = (props) => (
	<Suspense fallback={<FindPlaceholder mobile={props.mobile} />}>
		<LazyFind {...props} />
	</Suspense>
);
registerSlot("session.header", { id: "search.find", component: Find });

// The phone searches messages from Home's search field (its "In messages"
// section); the desktop has Cmd-K.
const LazyHome = lazy(() => import("./HomeResults.tsx"));
registerSlot("home.search", {
	id: "search.messages",
	component: (props) => (
		<Suspense fallback={null}>
			<LazyHome {...props} />
		</Suspense>
	),
});

const loadPage = () => import("./SearchPage.tsx");
const Page = Object.assign(lazy(loadPage), { preload: loadPage });
registerPage({ name: "search", phone: Page });
