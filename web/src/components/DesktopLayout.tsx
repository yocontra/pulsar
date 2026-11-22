import {
	HouseIcon,
	MegaphoneIcon,
	SearchIcon,
	SettingsIcon,
	SmartphoneIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TreeNode } from "../api/types.ts";
import { sessionless } from "../approval/sessionless.ts";
import { Kbd } from "../ds/index.ts";
import { lazy } from "../lib/lazy.tsx";
import { pageFor, pageProps, Slot } from "../lib/registry.tsx";
import { navigate, type Route, route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import {
	filter,
	hello,
	resetTree,
	selection,
	streamState,
} from "../lib/store.ts";
import { ProveNavItem } from "../prove/ProveNav.tsx";
import {
	Builder,
	IdsView,
	NeedsList,
	ScopeView,
	showPalette,
	showQr,
	showSettings,
} from "./chrome.tsx";
import { Home } from "./desktop/Home.tsx";
import { SideResizer } from "./desktop/SideResizer.tsx";
import { SessionHeaderSkeleton } from "./desktop/skeletons.tsx";
import { Toasts } from "./Toasts.tsx";
import { Tree } from "./Tree.tsx";
import { DesktopRow } from "./TreeDesktop.tsx";

// The session view with a skeleton of its header while the chunk loads.
const SessionDesktop = lazy<{
	id: string;
	approval?: boolean;
	changes?: { file: string | null };
}>(
	() => import("./desktop/SessionDesktop.tsx"),
	() => (
		<section className="session" aria-busy="true">
			<SessionHeaderSkeleton />
		</section>
	),
);

// A prompt with no conversation (the operator's), as a dialog over Home.
// It rides in the session chunk: no extra file, nothing in the first load.
const PromptDialog = lazy<{ id: string }>(
	() =>
		import("./desktop/SessionDesktop.tsx").then((m) => ({
			default: m.PromptDialog,
		})),
	() => <Home />,
);

// A subagent's transcript (`#/s/<id>`), under its parent agent.
const SubagentDesktop = lazy<{ id: string; mobile: boolean }>(
	// In the session chunk (it shares the conversation and composer).
	() =>
		import("./desktop/SessionDesktop.tsx").then((m) => ({
			default: m.SubagentView,
		})),
	() => (
		<section className="session" aria-busy="true">
			<SessionHeaderSkeleton />
		</section>
	),
);

const ContextMenu = lazy<{
	menu: { x: number; y: number; node: TreeNode };
	onClose: () => void;
}>(
	() => import("./desktopKeys.tsx").then((m) => ({ default: m.ContextMenu })),
	undefined,
	{ layer: true },
);

function MainPaneImpl({ r }: { r: Route }) {
	switch (r.view) {
		case "agent":
			return <SessionDesktop id={r.id} />;
		case "approval":
			return sessionless(r.id) ? (
				<PromptDialog id={r.id} />
			) : (
				<SessionDesktop id={r.id} approval />
			);
		case "subagent":
			return <SubagentDesktop id={r.id} mobile={false} />;
		case "changes":
			return <SessionDesktop id={r.id} changes={{ file: r.file ?? null }} />;
		case "node":
			return <ScopeView id={r.id} mobile={false} />;
		case "ids":
			return <IdsView ids={r.ids} mobile={false} />;
		case "needs":
			return <NeedsList mobile={false} />;
		case "page": {
			// A feature's page (lib/registry.tsx); Home when it has no desktop view.
			const Page = pageFor(r)?.desktop;
			return Page ? <Page {...pageProps(r)} /> : <Home />;
		}
		default:
			return <Home />;
	}
}

/** Live / reconnecting / offline, as a dot and a word in the sidebar footer. */
function ConnectionImpl() {
	const s = streamState.value;
	const live = s === "open";
	const word = live
		? "Live"
		: s === "connecting"
			? "Connecting…"
			: "Reconnecting…";
	return (
		<span
			className={`d-conn${live ? " live" : ""}`}
			title={live ? "Updates stream in live" : "Updates paused; retrying"}
		>
			<span className="d-conn-dot" aria-hidden="true" />
			{word}
		</span>
	);
}

function FilterBoxImpl() {
	const [text, setText] = useState(filter.value);
	useEffect(() => {
		const t = setTimeout(() => {
			if (text !== filter.value) {
				filter.value = text;
				resetTree();
			}
		}, 200);
		return () => clearTimeout(t);
	}, [text]);
	return (
		<label className="d-filter">
			<SearchIcon aria-hidden="true" />
			<input
				id="filter"
				className="d-input"
				type="search"
				value={text}
				placeholder="Filter machines, projects, agents"
				aria-label="Filter the tree"
				autoComplete="off"
				spellCheck={false}
				onChange={(e) => setText((e.target as HTMLInputElement).value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") {
						setText("");
						(e.target as HTMLInputElement).blur();
					}
				}}
			/>
			{text ? (
				<button
					type="button"
					className="d-filter-clear"
					aria-label="Clear filter"
					onClick={() => setText("")}
				>
					<XIcon />
				</button>
			) : (
				<Kbd className="d-filter-kbd" keys={["/"]} />
			)}
		</label>
	);
}

/** Keys kept while the shortcuts load (a burst of typing, not a backlog). */
const EARLY_KEYS = 20;

function DesktopImpl() {
	const r = route.value;
	const h = hello.value!;
	const filterRef = useRef<HTMLDivElement>(null);
	const [menu, setMenu] = useState<{
		x: number;
		y: number;
		node: TreeNode;
	} | null>(null);
	// Shortcuts and the context menu load right after first paint. The tree
	// can paint (from the last-screen snapshot) before they do: keys pressed
	// meanwhile are kept and handled once the shortcuts are in, not lost.
	useEffect(() => {
		let off: (() => void) | undefined;
		let live = true;
		const early: KeyboardEvent[] = [];
		const hold = (e: KeyboardEvent) => {
			if (early.length < EARLY_KEYS) early.push(e);
		};
		addEventListener("keydown", hold, true);
		void import("./desktopKeys.tsx").then((m) => {
			removeEventListener("keydown", hold, true);
			if (live) off = m.installDesktopKeys(filterRef, early);
		});
		return () => {
			live = false;
			removeEventListener("keydown", hold, true);
			off?.();
		};
	}, []);
	const sel = selection.value;
	return (
		<div className="d-app">
			<aside className="d-side" aria-label="Pool">
				<header className="d-brand">
					<img src="/icon.svg" alt="" width={22} height={22} />
					<div className="d-brand-text">
						<span className="d-brand-name">Pulsar</span>
						<span className="d-brand-sub">{h.machine}</span>
					</div>
					<Slot name="sidebar.header" mobile={false} />
					<button
						type="button"
						className="d-btn ghost sm icon"
						aria-label="Open on phone"
						title="Open on phone"
						onClick={() => (showQr.value = true)}
					>
						<SmartphoneIcon />
					</button>
				</header>
				<nav className="d-nav" aria-label="Main">
					<button
						type="button"
						className="d-nav-item"
						aria-current={r.view === "home" ? "page" : undefined}
						onClick={() => navigate({ view: "home" })}
					>
						<HouseIcon /> Home
					</button>
					<button
						type="button"
						className="d-nav-item"
						onClick={() => (showPalette.value = true)}
					>
						<SearchIcon /> Search <Kbd keys={["mod", "K"]} />
					</button>
					<button
						type="button"
						className="d-nav-item broadcast-btn"
						aria-current={r.view === "broadcast" ? "page" : undefined}
						onClick={() => navigate({ view: "broadcast", selector: "*" })}
					>
						<MegaphoneIcon /> Broadcast <Kbd keys={["mod", "shift", "B"]} />
					</button>
				</nav>
				<div className="d-filter-wrap" ref={filterRef}>
					<FilterBox />
				</div>
				<Tree
					rowView={DesktopRow}
					mobile={false}
					onContext={(e, node) => setMenu({ x: e.clientX, y: e.clientY, node })}
				/>
				{sel.size > 0 && (
					<div
						className="d-selbar selection-bar"
						role="region"
						aria-label="Selection"
					>
						<span className="d-selbar-count">{sel.size} selected</span>
						<button
							type="button"
							className="d-btn sm"
							onClick={() => (selection.value = new Set())}
						>
							Clear
						</button>
						<button
							type="button"
							className="d-btn sm primary"
							onClick={() => navigate({ view: "ids", ids: [...sel] })}
						>
							Message <Kbd keys={["B"]} />
						</button>
					</div>
				)}
				<footer className="d-side-foot">
					<Connection />
					<span className="spacer" />
					<ProveNavItem />
					<button
						type="button"
						className="d-btn ghost sm icon"
						aria-label="Settings"
						title="Settings"
						onClick={() => (showSettings.value = true)}
					>
						<SettingsIcon />
					</button>
				</footer>
				<SideResizer />
			</aside>
			<main className="d-main">
				<MainPane r={r.view === "broadcast" ? { view: "home" } : r} />
			</main>
			{r.view === "broadcast" && (
				<Builder selector={r.selector} mobile={false} />
			)}
			{menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
			<Toasts mobile={false} />
		</div>
	);
}

const MainPane = observer(MainPaneImpl);
const Connection = observer(ConnectionImpl);
const FilterBox = observer(FilterBoxImpl);
const Desktop = observer(DesktopImpl);
export default Desktop;
