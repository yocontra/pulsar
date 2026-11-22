/**
 * Message search: Cmd-K's "In messages" group, the find bar in a session
 * (session.header slot), and the phone's search page (`#/search`, opened
 * from Home's header). Metadata and lazy chunks only.
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
			<span>
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

// The phone opens search from Home's header; the desktop has Cmd-K.
const LazyOpen = lazy(() => import("./OpenSearch.tsx"));
registerSlot("sidebar.header", {
	id: "search.open",
	only: "phone",
	component: () => (
		<Suspense fallback={null}>
			<LazyOpen />
		</Suspense>
	),
});

const loadPage = () => import("./SearchPage.tsx");
const Page = Object.assign(lazy(loadPage), { preload: loadPage });
registerPage({ name: "search", phone: Page });
