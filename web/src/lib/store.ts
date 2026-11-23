/**
 * The app's signal store, kept as a compatibility surface while components
 * move to the realtime data layer (web/src/data). The data layer's query
 * cache is the only source of truth: its bridge (data/bridge.ts) feeds these
 * signals and owns the one event stream. New code should use the hooks in
 * web/src/data instead. This module stays in the entry chunk; the data
 * layer loads lazily from boot() (the entry's size budget).
 */
import {
	ApiError,
	api,
	type FailureKind,
	onPeerSession,
} from "../api/client.ts";
import type {
	AgentRow,
	Approval,
	AttentionItem,
	Feature,
	Hello,
	ReceiptsPage,
	Subscription,
	TreeNode,
} from "../api/types.ts";
import { reachable, reloadApp } from "./reach.ts";
import { effect, signal } from "./signals.ts";
import {
	clearSnapshot,
	makeSnapshot,
	readSnapshot,
	type SnapshotBranch,
	writeSnapshot,
} from "./snapshot.ts";

type Bridge = typeof import("../data/bridge.ts");
let bridgeLoad: Promise<Bridge> | null = null;
/** The data layer (a lazy chunk), loaded once. */
export function dataLayer(): Promise<Bridge> {
	bridgeLoad ??= import("../data/bridge.ts");
	return bridgeLoad;
}
/** Runs `fn` with the data layer; queued until it has loaded. */
function withData(fn: (b: Bridge) => unknown) {
	void dataLayer().then(fn);
}

// ------------------------------------------------------------ persistence

function load<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(`pulsar.${key}`);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}
function save(key: string, value: unknown) {
	try {
		const s = JSON.stringify(value);
		// Keep the offline cache small (plan budget: 200 KB).
		if (s.length < 200_000) localStorage.setItem(`pulsar.${key}`, s);
	} catch {}
}

// ------------------------------------------------------------ app state

export const hello = signal<Hello | null>(null);
/** A short status line at the bottom of the screen; clears itself. */
export const toast = signal<{ text: string; tone: "ok" | "warn" } | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** `ms: 0` keeps it until the next toast (a pending "Stopping…"). */
export function showToast(text: string, tone: "ok" | "warn" = "ok", ms = 4000) {
	clearTimeout(toastTimer);
	toast.value = { text, tone };
	if (ms)
		toastTimer = setTimeout(() => {
			toast.value = null;
		}, ms);
}

/** Whether the daemon serves a feature (`stop`, `approvals`, ...). */
export const can = (f: Feature) => hello.value?.features.includes(f) ?? false;
export const failure = signal<{ kind: FailureKind; detail?: string } | null>(
	null,
);
export const streamState = signal<
	"connecting" | "open" | "retrying" | "closed"
>("connecting");
export const attention = signal<AttentionItem[]>([]);
/** Bumped on every `security` notice: open settings refetch passkeys. */
export const securityVersion = signal(0);

/** The installed app's icon badge: who waits on you (where the browser supports it). */
export function setBadge(count: number) {
	const n = navigator as Navigator & {
		setAppBadge?: (n: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
	try {
		void (count ? n.setAppBadge?.(count) : n.clearAppBadge?.())?.catch(
			() => {},
		);
	} catch {}
}

/** Approvals as the `approval` SSE event last showed them, by request id, with when it arrived. */
export const approvals = signal<
	Map<string, { approval: Approval; at: number }>
>(new Map());
/** How long an ended approval keeps its card (showing the outcome). */
const OUTCOME_MS = 60_000;

/**
 * The approval card for an agent: its pending prompt, or for a minute after
 * it ended, the outcome ("Answered on studio", "Allowed once by you…").
 */
export function approvalItem(agentId: string): AttentionItem | undefined {
	const pending = attention.value.find(
		(a) => a.agent.id === agentId && a.approval,
	);
	if (pending) return pending;
	const now = Date.now();
	let ended: Approval | undefined;
	let endedAt = 0;
	for (const { approval: a, at } of approvals.value.values())
		if (
			a.agentId === agentId &&
			a.state !== "pending" &&
			now - at < OUTCOME_MS &&
			at > endedAt
		) {
			ended = a;
			endedAt = at;
		}
	const agent = ended && findAgent(agentId);
	if (!ended || !agent) return undefined;
	return {
		id: `ended:${ended.requestId}`,
		kind: "approval",
		agent,
		title: ended.outcome ?? "Approval",
		createdAt: ended.createdAt,
		approval: ended,
	};
}
/** The agent's wait on a prompt only its terminal can answer (shown read-only). */
export function terminalItem(agentId: string): AttentionItem | undefined {
	return attention.value.find(
		(a) => a.agent.id === agentId && a.kind === "terminal",
	);
}
export const recent = signal<AgentRow[]>([]);

export type Sort = "needs" | "busy" | "recent" | "name";
/**
 * The tree always groups machines → projects → agents (a machine row already
 * holds its projects). The API's `group` parameter stays "machines".
 */
export const TREE_GROUP = "machines" as const;
export const filter = signal("");
export const sort = signal<Sort>(load<Sort>("sort", "needs"));

export interface Pin {
	id: string;
	kind: TreeNode["kind"];
	name: string;
	selector: string;
	agentId?: string;
}
export const pins = signal<Pin[]>(load<Pin[]>("pins", []));
effect(() => save("pins", pins.value));
effect(() => save("sort", sort.value));

export function togglePin(n: TreeNode) {
	const has = pins.value.some((p) => p.id === n.id);
	pins.value = has
		? pins.value.filter((p) => p.id !== n.id)
		: [
				...pins.value,
				{
					id: n.id,
					kind: n.kind,
					name: n.label,
					selector: n.selector,
					agentId: n.agent?.id,
				},
			];
}

/** Multi-selected agent ids (Cmd/Shift-click, x/Space). */
export const selection = signal<Set<string>>(new Set());
export function toggleSelect(id: string) {
	const s = new Set(selection.value);
	if (s.has(id)) s.delete(id);
	else s.add(id);
	selection.value = s;
}

// ------------------------------------------------------------ tree

interface Branch {
	ids: string[];
	nextCursor: string | null;
	total: number;
	loading: boolean;
}
export const nodes = new Map<string, TreeNode>();
/** Agent id → its tree node id (node ids are opaque). */
const agentNodes = new Map<string, string>();
/** Bridge only: stores a node from the cache. */
export function putNode(n: TreeNode) {
	const prev = nodes.get(n.id);
	// Live updates may carry only the changed node; keep what the page had.
	nodes.set(n.id, prev ? { ...prev, ...n } : n);
	if (n.agent) agentNodes.set(n.agent.id, n.id);
}
export function agentNode(agentId: string): TreeNode | undefined {
	const id = agentNodes.get(agentId);
	return id ? nodes.get(id) : undefined;
}
export const branches = new Map<string, Branch>();
/** Bumped on any tree change; components read it to re-render. */
export const treeVersion = signal(0);
let bumpQueued = false;
/** Bridge only: one re-render per microtask for any number of tree changes. */
export function bumpTree() {
	if (bumpQueued) return;
	bumpQueued = true;
	queueMicrotask(() => {
		bumpQueued = false;
		treeVersion.value++;
	});
}

const expandedKey = () => `expanded.${TREE_GROUP}`;
export const expanded = signal<Set<string>>(
	new Set(load<string[] | null>(expandedKey(), null) ?? []),
);
let expansionRemembered = load<string[] | null>(expandedKey(), null) !== null;
effect(() => save(`expanded.${TREE_GROUP}`, [...expanded.value]));

let lastInteraction = 0;
export function noteInteraction() {
	lastInteraction = Date.now();
}

/** Refetch the tree's top level (it also stays live over the stream). */
export function loadTop(_opts: { silent?: boolean } = {}) {
	withData((b) => b.refetchTop());
}

/** No branch was ever opened or closed on this device (its first visit). */
export function expansionPending() {
	return !expansionRemembered && !filter.peek();
}

/** Bridge only: the top level arrived. */
export function treeLoaded(top: TreeNode[]) {
	liveTree = true;
	applyDefaultExpansion(top);
	if (!filter.peek()) save("lastKnown", top.slice(0, 60));
}

function applyDefaultExpansion(top: TreeNode[]) {
	if (expansionRemembered || filter.peek()) return;
	expansionRemembered = true;
	const h = hello.peek();
	const small = h ? h.machines <= 3 || h.agents <= 30 : false;
	const next = new Set(expanded.peek());
	for (const n of top) if (n.link === "local" || small) next.add(n.id);
	for (const p of pins.peek()) if (p.kind !== "agent") next.add(p.id);
	expanded.value = next;
}

export function loadMore(branchId: string) {
	const b = branches.get(branchId);
	if (!b || b.loading || !b.nextCursor) return;
	// Loading from now, not from when the data layer runs: a second call in
	// between fetched the same page again, and the first to finish cleared
	// `loading` while the other ran, so the "more" row's one-shot observer
	// was never set again and the list stopped loading.
	b.loading = true;
	bumpTree();
	withData((d) => d.loadMore(branchId));
}

export function setExpanded(id: string, open: boolean) {
	const next = new Set(expanded.value);
	if (open) next.add(id);
	else next.delete(id);
	expanded.value = next;
	if (open && !branches.has(id)) {
		branches.set(id, { ids: [], nextCursor: null, total: 0, loading: true });
		bumpTree();
	}
}
export const toggleExpanded = (id: string) =>
	setExpanded(id, !expanded.value.has(id));

/** The filter changed: reload from the top. */
export function resetTree() {
	nodes.clear();
	agentNodes.clear();
	branches.clear();
	expanded.value = new Set(load<string[] | null>(expandedKey(), null) ?? []);
	expansionRemembered = load<string[] | null>(expandedKey(), null) !== null;
	bumpTree();
}

// Re-sorting waits ≥5 s after the last scroll/touch and only refetches order;
// live events patch rows in place without moving them.
setInterval(() => {
	if (document.hidden || failure.value || Date.now() - lastInteraction < 5000)
		return;
	if (branches.get("")?.loading) return;
	loadTop({ silent: true });
}, 15000);

// ------------------------------------------------------------ errors

export function handleError(err: unknown, soft = false) {
	if (!(err instanceof ApiError)) return;
	if (err.kind === "http" || (soft && err.code === "unreachable")) return;
	failure.value = { kind: err.kind, detail: err.message };
}

export const lastKnown = (): TreeNode[] => load<TreeNode[]>("lastKnown", []);

// ------------------------------------------------------------ snapshot

/** The tree came from the daemon this page load (not the snapshot). */
let liveTree = false;

// A revisit paints the last screen at once (lib/snapshot.ts); the live reads
// replace each part as it lands (the bridge keeps a branch's ids until its
// query has data).
const snap = readSnapshot(sort.peek());
if (snap) {
	hello.value = snap.hello;
	attention.value = snap.attention;
	recent.value = snap.recent;
	for (const n of snap.nodes) putNode(n);
	for (const [id, b] of Object.entries(snap.branches))
		branches.set(id, { ...b, loading: false });
	bumpTree();
}

let snapTimer: ReturnType<typeof setTimeout> | undefined;
effect(() => {
	const h = hello.value;
	const f = failure.value;
	// Read every signal the snapshot holds, so any change saves it again.
	const parts = [attention.value, recent.value, treeVersion.value];
	if (f?.kind === "forbidden") {
		clearSnapshot();
		return;
	}
	if (!h || filter.value || !liveTree || !parts) return;
	clearTimeout(snapTimer);
	snapTimer = setTimeout(saveSnapshot, 1000);
});

function saveSnapshot() {
	const h = hello.peek();
	if (!h || filter.peek() || failure.peek()) return;
	const open: Record<string, SnapshotBranch> = {};
	const keep = new Set<string>();
	const take = (id: string) => {
		const b = branches.get(id);
		if (!b || b.loading) return;
		const ids = b.ids.slice(0, 100);
		open[id] = { ids, nextCursor: b.nextCursor, total: b.total };
		for (const i of ids) keep.add(i);
	};
	take("");
	if (!open[""]) return;
	for (const id of [...expanded.peek()].slice(0, 20)) take(id);
	writeSnapshot(
		makeSnapshot({
			sort: sort.peek(),
			hello: h,
			attention: attention.peek(),
			recent: recent.peek(),
			nodes: [...keep].flatMap((id) => nodes.get(id) ?? []),
			branches: open,
		}),
	);
}

// ------------------------------------------------------------ live stream

type Listener<T> = (v: T) => void;
const receiptListeners = new Set<Listener<ReceiptsPage>>();
export const queryCount = signal<{
	selector: string;
	total: number;
	machines: number;
} | null>(null);
export function onReceipts(fn: Listener<ReceiptsPage>) {
	receiptListeners.add(fn);
	return () => receiptListeners.delete(fn);
}
/** Bridge only: fan receipts out to the listeners above. */
export function emitReceipts(v: ReceiptsPage) {
	for (const fn of receiptListeners) fn(v);
}

/** Agent rows seen by open sessions (fed from the cache's agent queries). */
export const agentRows = signal<Map<string, AgentRow>>(new Map());

export function rememberAgent(a: AgentRow) {
	if (agentRows.peek().get(a.id) === a) return;
	const m = new Map(agentRows.peek());
	m.set(a.id, a);
	agentRows.value = m;
}

export const streamId = signal<string | null>(null);

/** The broadcast builder's selector and preview page (kept live by the bridge). */
export const builderQuery = signal<string | null>(null);
export const builderResults = signal<Subscription["results"]>(null);
/** Bridge only: message ids whose receipts are on screen, with watcher counts. */
export const receiptWatch = signal<Map<string, number>>(new Map());

export function watchReceipts(messageId: string) {
	const m = new Map(receiptWatch.value);
	m.set(messageId, (m.get(messageId) ?? 0) + 1);
	receiptWatch.value = m;
	return () => {
		const n = new Map(receiptWatch.value);
		const c = (n.get(messageId) ?? 1) - 1;
		if (c <= 0) n.delete(messageId);
		else n.set(messageId, c);
		receiptWatch.value = n;
	};
}

// ------------------------------------------------------------ boot

/** Refetch everything on screen (pull to refresh, a gap). */
export async function refreshAll() {
	const b = await dataLayer();
	await b.refreshAll();
}

// Another tab proved or signed out: show this tab's session as it is now.
onPeerSession(() => void refreshAll());

export async function boot() {
	// /hello and the data layer's chunk load in parallel (first paint waits on hello).
	const first = api.hello();
	first.catch(() => {});
	const b = await dataLayer();
	b.startBridge(first);
}

// ------------------------------------------------------------ unreachable

// The daemon unreachable (off Tailscale): a chunk that failed for it
// (public/boot.js, which reloads once the daemon answers) or a stream that
// stays down (data/bridge.ts) shows the offline screen, never "didn't load".
let chunkOffline = false;
addEventListener("pulsar:offline", () => {
	chunkOffline = true;
	if (!failure.peek()) failure.value = { kind: "offline" };
});

/** Retry from a failure screen. */
export async function retry() {
	// Still unreachable: keep the screen (it tries again by itself).
	if (!(await reachable())) return;
	// A failed import is cached: reload past the cached shell.
	if (chunkOffline) return reloadApp();
	failure.value = null;
	await refreshAll();
}

/** Look up an agent row anywhere we've seen it. */
export function findAgent(id: string): AgentRow | null {
	return (
		agentRows.value.get(id) ??
		agentNode(id)?.agent ??
		attention.value.find((a) => a.agent.id === id)?.agent ??
		recent.value.find((a) => a.id === id) ??
		null
	);
}
