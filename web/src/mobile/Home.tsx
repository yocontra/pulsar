/**
 * Home: needs-you at a glance, pinned, then machines (with their projects) as one
 * inset-grouped, virtualized list that expands in place. Large title that
 * condenses, a search field under it, pull to refresh, swipe actions and
 * long-press menus.
 */
import { CloudOffIcon, SparklesIcon, SquarePenIcon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { TreeNode } from "../api/types.ts";
import {
	mobileRows,
	noMatch,
	OFFLINE,
	type Row,
} from "../components/treeRows.ts";
import { Slot } from "../lib/registry.tsx";
import { navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import {
	branches,
	expanded,
	filter,
	hello,
	loadMore,
	nodes,
	noteInteraction,
	refreshAll,
	resetTree,
	setExpanded,
	streamState,
	toggleExpanded,
	togglePin,
	treeVersion,
} from "../lib/store.ts";
import { canStop, isPinned, messageGroup, openNeeds } from "./nav-actions.ts";

// Menus and the stop flow load on first use.
const actions = () => import("./actions.ts");
const agentMenu = (a: import("../api/types.ts").AgentRow) =>
	void actions().then((m) => m.agentMenu(a));
const groupMenu = (n: TreeNode) => void actions().then((m) => m.groupMenu(n));
const confirmStop = (a: import("../api/types.ts").AgentRow) =>
	void actions().then((m) => m.confirmStop(a));

import {
	IonButton,
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonSearchbar,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { type LazyIonic, useIonicLazy } from "./lazyIonic.ts";
import { useLongPress } from "./longpress.ts";
import {
	AgentRowView,
	GroupRowView,
	NeedsRowView,
	PinRowView,
	RowShell,
	statusText,
} from "./rows.tsx";
import { SkeletonRows } from "./skeletons.tsx";

export const HOME_TITLE = "Agents";

/* ------------------------------------------------------------ rows */

const inGroup = (r?: Row) => !!r && r.t !== "section";

function sectionLabel(r: Extract<Row, { t: "section" }>) {
	if (r.key === "s-needs") return "Needs You";
	if (r.key === "s-all") return "Machines";
	return r.label;
}

function SectionRow({
	r,
	first,
}: {
	r: Extract<Row, { t: "section" }>;
	first: boolean;
}) {
	const needs = r.key === "s-needs";
	return (
		<div className={`p-section${first ? " is-first" : ""}`} role="presentation">
			<h2>
				{sectionLabel(r)}
				{needs && r.count ? <span className="p-count">{r.count}</span> : null}
			</h2>
			{needs && r.more && (r.count ?? 0) > 2 && (
				<button type="button" onClick={r.more}>
					See All
				</button>
			)}
		</div>
	);
}

/** Wraps a row's cell in swipe actions once the lazy Ionic chunk is in. */
function Swipe({
	lz,
	start,
	end,
	onFull,
	children,
}: {
	lz: LazyIonic | null;
	start?: { label: string; color: string; run: () => void }[];
	end?: { label: string; color: string; run: () => void }[];
	onFull?: () => void;
	children: React.ReactNode;
}) {
	if (!lz || (!start?.length && !end?.length)) return <>{children}</>;
	const close = (e: React.SyntheticEvent) =>
		void (
			e.currentTarget.closest(
				"ion-item-sliding",
			) as HTMLIonItemSlidingElement | null
		)?.close();
	return (
		<lz.IonItemSliding>
			{children}
			{start?.length ? (
				<lz.IonItemOptions side="start">
					{start.map((o) => (
						<lz.IonItemOption
							key={o.label}
							color={o.color}
							onClick={(e: React.MouseEvent) => {
								close(e);
								o.run();
							}}
						>
							{o.label}
						</lz.IonItemOption>
					))}
				</lz.IonItemOptions>
			) : null}
			{end?.length ? (
				<lz.IonItemOptions side="end" onIonSwipe={() => onFull?.()}>
					{end.map((o, i) => (
						<lz.IonItemOption
							key={o.label}
							color={o.color}
							expandable={!!onFull && i === 0}
							onClick={(e: React.MouseEvent) => {
								close(e);
								o.run();
							}}
						>
							{o.label}
						</lz.IonItemOption>
					))}
				</lz.IonItemOptions>
			) : null}
		</lz.IonItemSliding>
	);
}

function NodeCell({
	id,
	depth,
	last,
	lz,
}: {
	id: string;
	depth: number;
	last: boolean;
	lz: LazyIonic | null;
}) {
	const n = nodes.get(id);
	const lp = useLongPress(() => {
		if (!n) return;
		if (n.agent) void agentMenu(n.agent);
		else void groupMenu(n);
	});
	if (!n) return null;
	const lines = last ? "none" : "inset";
	if (n.kind === "agent" && n.agent) {
		const a = n.agent;
		const pinned = isPinned(n.id);
		return (
			<div className="p-press" {...lp}>
				<Swipe
					lz={lz}
					start={[
						{
							label: pinned ? "Unpin" : "Pin",
							color: "warning",
							run: () => togglePin(n),
						},
					]}
					end={[
						{
							label: "Open",
							color: "primary",
							run: () => navigate({ view: "agent", id: a.id }),
						},
						...(canStop(a)
							? [
									{
										label: "Stop",
										color: "danger",
										run: () => void confirmStop(a),
									},
								]
							: []),
					]}
					onFull={() => navigate({ view: "agent", id: a.id })}
				>
					<IonItem
						button
						detail={false}
						lines={lines}
						role="treeitem"
						aria-level={depth + 1}
						aria-label={`${a.name}, ${statusText(a)}${a.activity ? `, ${a.activity}` : ""}`}
						data-agent={a.id}
						data-node={n.id}
						onClick={() => navigate({ view: "agent", id: a.id })}
					>
						<AgentRowView a={a} depth={depth} />
					</IonItem>
				</Swipe>
			</div>
		);
	}
	const open = expanded.value.has(n.id);
	return (
		<div className="p-press" {...lp}>
			<Swipe
				lz={lz}
				start={[
					{
						label: isPinned(n.id) ? "Unpin" : "Pin",
						color: "warning",
						run: () => togglePin(n),
					},
				]}
				end={[
					{ label: "Message", color: "primary", run: () => messageGroup(n) },
				]}
				onFull={() => messageGroup(n)}
			>
				<IonItem
					button
					detail={false}
					lines={lines}
					role="treeitem"
					aria-level={depth + 1}
					aria-expanded={open}
					aria-label={groupLabel(n, open)}
					data-node={n.id}
					onClick={() => {
						noteInteraction();
						toggleExpanded(n.id);
					}}
				>
					<GroupRowView n={n} depth={depth} />
				</IonItem>
			</Swipe>
		</div>
	);
}

function groupLabel(n: TreeNode, open: boolean) {
	const parts = [n.label, n.kind === "machine" ? "machine" : "project"];
	const needs = n.rollup?.needsYou ?? 0;
	if (needs) parts.push(`${needs} ${needs === 1 ? "needs" : "need"} you`);
	if (n.reason) parts.push(n.reason);
	parts.push(open ? "expanded" : "collapsed");
	return parts.join(", ");
}

/**
 * Load the next page of machines when its "more" row scrolls near. The row
 * drops this ref while a page loads and takes it again after, so each page
 * gets a fresh observer (the row itself stays mounted).
 */
function autoLoad(el: HTMLDivElement | null) {
	if (!el) return;
	const io = new IntersectionObserver(
		(es) => {
			if (es.some((e) => e.isIntersecting)) {
				io.disconnect();
				void loadMore("");
			}
		},
		{ rootMargin: "600px 0px" },
	);
	io.observe(el);
	return () => io.disconnect();
}

function RowView({
	row,
	first,
	last,
	lz,
}: {
	row: Row;
	first: boolean;
	last: boolean;
	lz: LazyIonic | null;
}) {
	const lines = last ? "none" : "inset";
	switch (row.t) {
		case "section":
			return <SectionRow r={row} first={first} />;
		case "attn":
			return (
				<div className="p-cell">
					<Swipe
						lz={lz}
						end={[
							{
								label: "Review",
								color: "warning",
								run: () => openNeeds(row.item),
							},
						]}
						onFull={() => openNeeds(row.item)}
					>
						<IonItem
							button
							detail
							lines={lines}
							className="p-attn"
							data-agent={row.item.agent.id}
							aria-label={`${row.item.kind === "approval" ? "Approval" : row.item.kind === "terminal" ? "Terminal prompt" : "Question"} from ${row.item.agent.name} on ${row.item.agent.machine}`}
							onClick={() => openNeeds(row.item)}
						>
							<NeedsRowView item={row.item} />
						</IonItem>
					</Swipe>
				</div>
			);
		case "pin": {
			const p = row.pin;
			const n = nodes.get(p.id);
			const agent = n?.agent ?? null;
			return (
				<div className="p-cell">
					<Swipe
						lz={lz}
						end={[
							{
								label: "Unpin",
								color: "warning",
								run: () => n && togglePin(n),
							},
						]}
					>
						<IonItem
							button
							detail={!p.agentId}
							lines={lines}
							data-node={p.id}
							aria-label={`${p.name}, pinned`}
							onClick={() =>
								p.agentId
									? navigate({ view: "agent", id: p.agentId })
									: navigate({ view: "node", id: p.id })
							}
						>
							<PinRowView label={p.name} agent={agent} />
						</IonItem>
					</Swipe>
				</div>
			);
		}
		case "node":
			return (
				<div
					className="p-cell"
					data-tree-node={row.id}
					data-expanded={
						nodes.get(row.id)?.kind === "agent"
							? undefined
							: String(expanded.value.has(row.id))
					}
				>
					<NodeCell id={row.id} depth={row.depth} last={last} lz={lz} />
				</div>
			);
		case "offline":
			return (
				<div className="p-cell" data-expanded={String(row.open)}>
					<IonItem
						button
						detail={false}
						lines={lines}
						aria-expanded={row.open}
						data-node={OFFLINE}
						onClick={() => setExpanded(OFFLINE, !row.open)}
					>
						<RowShell
							kind="group"
							lead={
								<span className="p-icon is-offline" aria-hidden="true">
									<CloudOffIcon />
								</span>
							}
							title={`${row.count} offline machines`}
							trail={
								<span className="p-disclose" aria-hidden="true">
									<svg
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="m9 18 6-6-6-6" />
									</svg>
								</span>
							}
						/>
					</IonItem>
				</div>
			);
		case "more":
			return (
				<div
					className="p-cell"
					ref={row.branch === "" && !row.loading ? autoLoad : undefined}
				>
					<IonItem
						button
						detail={false}
						lines={lines}
						disabled={row.loading}
						onClick={() => void loadMore(row.branch)}
					>
						<RowShell
							kind="plain"
							depth={row.depth}
							title={
								<span className="p-more">
									{row.loading
										? "Loading…"
										: `Show ${row.remaining > 0 ? `${row.remaining} ` : ""}more`}
								</span>
							}
						/>
					</IonItem>
				</div>
			);
		case "loading":
			return (
				<div className="p-cell">
					<SkeletonRows count={1} depth={row.depth} last={last} />
				</div>
			);
		default:
			return null;
	}
}

/* ------------------------------------------------------------ list */

function HomeListImpl() {
	const rows = mobileRows.value;
	const lz = useIonicLazy();
	return (
		<div className="p-list" role="tree" aria-label="Machines">
			{rows.map((row, i) => {
				const gf = inGroup(row) && !inGroup(rows[i - 1]);
				const gl = inGroup(row) && !inGroup(rows[i + 1]);
				return (
					<div
						key={row.key}
						className={`p-vrow is-${row.t}${gf ? " gf" : ""}${gl ? " gl" : ""}`}
					>
						<RowView row={row} first={i === 0} last={gl} lz={lz} />
					</div>
				);
			})}
			{noMatch(rows, filter.value) && (
				<div className="p-empty is-search">
					<h3>No results</h3>
					<p>No machines, projects or agents match “{filter.value}”.</p>
				</div>
			)}
		</div>
	);
}
const HomeList = observer(HomeListImpl);

/* ------------------------------------------------------------ page */

function InstallHint() {
	const [hidden, setHidden] = useState(() => {
		try {
			return (
				!!localStorage.getItem("pulsar.installHint") ||
				matchMedia("(display-mode: standalone)").matches ||
				// iOS 27's Home Screen app reports only navigator.standalone.
				(navigator as Navigator & { standalone?: boolean }).standalone ===
					true ||
				!/iPhone|iPad/.test(navigator.userAgent)
			);
		} catch {
			return true;
		}
	});
	if (hidden) return null;
	return (
		<aside className="p-tip" aria-label="Tip">
			<img src="/icon.svg" alt="" />
			<div>
				<strong>Add Pulsar to your Home Screen</strong>
				<span>
					Tap Share, then Add to Home Screen. Pulsar opens full screen and can
					notify you about approvals.
				</span>
			</div>
			<button
				type="button"
				aria-label="Dismiss tip"
				onClick={() => {
					try {
						localStorage.setItem("pulsar.installHint", "1");
					} catch {}
					setHidden(true);
				}}
			>
				<XIcon size={18} />
			</button>
		</aside>
	);
}

/**
 * Shown only when the live connection isn't normal (signal, not noise).
 * Reads the store's mirror of the stream state, not the data layer's
 * useConnection, so the data chunk stays off the first route.
 */
function useOnline() {
	const [on, setOn] = useState(() => navigator.onLine);
	useEffect(() => {
		const up = () => setOn(navigator.onLine);
		addEventListener("online", up);
		addEventListener("offline", up);
		return () => {
			removeEventListener("online", up);
			removeEventListener("offline", up);
		};
	}, []);
	return on;
}
function ConnectionBannerImpl() {
	const online = useOnline();
	const s = streamState.value;
	const c = !online
		? "offline"
		: s === "retrying" || s === "closed"
			? "reconnecting"
			: "live";
	if (c === "live") return null;
	return (
		<div className="p-banner" role="status">
			<CloudOffIcon />
			<span>
				<strong>{c === "offline" ? "Offline" : "Reconnecting…"}</strong>{" "}
				{c === "offline"
					? "Pulsar updates when your connection is back."
					: "What you see may be a few seconds old."}
			</span>
		</div>
	);
}
const ConnectionBanner = observer(ConnectionBannerImpl);

function SearchField() {
	const [text, setText] = useState(filter.peek());
	useEffect(() => {
		const t = setTimeout(() => {
			if (text !== filter.peek()) {
				filter.value = text;
				resetTree();
			}
		}, 250);
		return () => clearTimeout(t);
	}, [text]);
	return (
		<IonSearchbar
			className="p-search"
			placeholder="Search"
			aria-label="Filter the tree"
			value={text}
			showCancelButton="focus"
			onIonInput={(e) => setText(e.detail.value ?? "")}
			onIonClear={() => setText("")}
		/>
	);
}

function Refresher({ lz }: { lz: LazyIonic | null }) {
	if (!lz) return null;
	return (
		<lz.IonRefresher
			slot="fixed"
			onIonRefresh={(e: CustomEvent) => {
				const el = e.target as HTMLIonRefresherElement;
				void refreshAll().finally(() => el.complete());
			}}
		>
			<lz.IonRefresherContent />
		</lz.IonRefresher>
	);
}

function HomeImpl() {
	const lz = useIonicLazy();
	// branches is a plain Map: read the tree version so tree changes re-render
	// (a used read: the minifier drops bare `x.value;` statements).
	const version = treeVersion.value;
	const top = branches.get("");
	const loading =
		version < 0 ||
		!hello.value ||
		!top ||
		(top.loading && top.ids.length === 0);
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						{/* Settings is a tab (mobile/tabs.ts). Ask on the left balances the
						    feature buttons on the right, or the collapsed title runs under them. */}
						<IonButton
							aria-label="Ask"
							onClick={() => navigate({ view: "ask" })}
						>
							<SparklesIcon />
						</IonButton>
					</IonButtons>
					<IonTitle>{HOME_TITLE}</IonTitle>
					<IonButtons slot="end">
						<Slot name="sidebar.header" mobile />
						<IonButton
							aria-label="Broadcast…"
							onClick={() => navigate({ view: "broadcast", selector: "*" })}
						>
							<SquarePenIcon />
						</IonButton>
					</IonButtons>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="p-home" onTouchStart={noteInteraction}>
				<Refresher lz={lz} />
				<IonHeader collapse="condense">
					<IonToolbar>
						<IonTitle size="large">{HOME_TITLE}</IonTitle>
					</IonToolbar>
					<IonToolbar>
						<SearchField />
					</IonToolbar>
				</IonHeader>
				<div className="p-home-head">
					<ConnectionBanner />
					<InstallHint />
				</div>
				{loading ? <SkeletonRows count={9} section /> : <HomeList />}
			</IonContent>
		</>
	);
}

export default observer(HomeImpl);
