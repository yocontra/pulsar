/**
 * Compatibility bridge: feeds lib/store.ts's signals from the query cache,
 * so components that still read the store stay live while they move to the
 * hooks. The cache is the only source of truth; the store keeps no stream
 * and fetches nothing itself. The bridge mounts observers for what the
 * store's screens show (tree, expanded branches, the open session, the
 * builder, watched receipts), which also puts those topics in the stream's
 * subscription.
 */

import { hashKey } from "@tanstack/react-query";
import { ApiError } from "../api/client.ts";
import type {
	AgentRow,
	AgentSort,
	AttentionList,
	Hello,
	SubagentRow,
	TreeNode,
} from "../api/types.ts";
import { route } from "../lib/router.ts";
import { effect } from "../lib/signals.ts";
import * as store from "../lib/store.ts";
import { putSubagents, subOpen } from "../lib/subagents.ts";
import { keys } from "./keys.ts";
import type { ApprovalSeen } from "./live.ts";
import { type Observed, observeAgents, observeLive } from "./observe.ts";
import type { ListData } from "./patch.ts";
import {
	applyHello,
	defs,
	expandNextTree,
	fetchMoreTree,
	type LiveDef,
} from "./queries.ts";
import { live, prefetchAgent, queryClient, startLive } from "./runtime.ts";
import { startUpdates } from "./update.ts";

const mounts = new Map<string, Observed>();
/** Compares /hello's build with this page's (data/update.ts). */
let checkUpdate = () => {};

/** Keeps a query mounted (an observer) until the returned function runs. */
function mount<T>(def: LiveDef<T>): () => void {
	const hash = hashKey(def.queryKey);
	if (mounts.has(hash)) return () => {};
	mounts.set(hash, observeLive(queryClient, live, def));
	return () => {
		mounts.get(hash)?.stop();
		mounts.delete(hash);
	};
}

/** Mounts one keyed set of queries, replacing the previous set on each run. */
function keyedMounts() {
	let current = new Map<string, () => void>();
	return (wanted: Map<string, () => () => void>) => {
		const next = new Map<string, () => void>();
		for (const [k, start] of wanted) next.set(k, current.get(k) ?? start());
		for (const [k, stop] of current) if (!next.has(k)) stop();
		current = next;
	};
}

// ------------------------------------------------------------ tree

function treeKey() {
	return keys.tree(store.TREE_GROUP, store.filter.peek(), store.sort.peek());
}

function syncBranch(
	branchId: string,
	d: ListData<TreeNode> | undefined,
	loading: boolean,
) {
	if (d) for (const n of d.items) store.putNode(n);
	store.branches.set(branchId, {
		ids: d?.items.map((n) => n.id) ?? store.branches.get(branchId)?.ids ?? [],
		nextCursor: d?.nextCursor ?? null,
		total: d?.total ?? store.branches.get(branchId)?.total ?? 0,
		loading,
	});
	store.bumpTree();
}

function onCacheEvent(key: readonly unknown[]) {
	const [name, a, b, c] = key as [string, string, string, string];
	const q = queryClient.getQueryCache().find({ queryKey: key, exact: true });
	if (!q) return;
	const data = q?.state.data;
	const loading =
		q?.state.status === "pending" && q.state.fetchStatus === "fetching";
	if (name === "tree") {
		if (
			a !== store.TREE_GROUP ||
			b !== store.filter.peek() ||
			c !== store.sort.peek()
		)
			return;
		syncBranch("", data as ListData<TreeNode> | undefined, loading);
		if (data) store.treeLoaded((data as ListData<TreeNode>).items);
	} else if (name === "children") {
		if (b !== store.filter.peek() || c !== store.sort.peek()) return;
		if (q?.state.status === "error" && data === undefined) {
			store.branches.delete(a);
			store.bumpTree();
			return;
		}
		syncBranch(a, data as ListData<TreeNode> | undefined, loading);
	} else if (name === "hello") {
		if (data) store.hello.value = data as Hello;
		if (data) checkUpdate();
		if (q?.state.status === "success") store.failure.value = null;
		else if (q?.state.status === "error") failed(q.state.error);
	} else if (name === "attention") {
		if (data) {
			store.attention.value = (data as AttentionList).items;
			store.setBadge((data as AttentionList).items.length);
		}
	} else if (name === "recent") {
		if (data) store.recent.value = (data as { items: AgentRow[] }).items;
	} else if (name === "approvals") {
		const m = new Map<string, ApprovalSeen>();
		for (const s of (data as ApprovalSeen[] | undefined) ?? [])
			m.set(s.approval.requestId, s);
		store.approvals.value = m;
	} else if (name === "subagents") {
		if (data) putSubagents(a, (data as ListData<SubagentRow>).items);
	} else if (name === "agent") {
		if (data) store.rememberAgent(data as AgentRow);
	} else if (name === "count") {
		const d = data as { total: number; machines: number } | undefined;
		if (d && a === store.builderQuery.peek())
			store.queryCount.value = {
				selector: a,
				total: d.total,
				machines: d.machines,
			};
	}
}

function failed(err: unknown) {
	if (err instanceof ApiError) store.handleError(err);
	else store.failure.value = { kind: "offline" };
}

// ------------------------------------------------------------ start

let started = false;

/** Starts the stream and the store's mirrors (once). */
export function startBridge(firstHello?: Promise<Hello>) {
	if (started) return;
	started = true;
	queryClient.getQueryCache().subscribe((e) => {
		if (e.type === "updated" || e.type === "added")
			onCacheEvent(e.query.queryKey);
	});
	live.subscribeState(() => {
		store.streamState.value = live.state;
		store.streamId.value = live.streamId;
	});
	live.on("receipts", (v) => store.emitReceipts(v));
	// A new build of the app (data/update.ts): /hello says which one the
	// daemon serves (the query, never the store's snapshot from the last
	// visit). A daemon restart (a new boot id) asks at once.
	checkUpdate = startUpdates(
		() => queryClient.getQueryData<Hello>(keys.hello())?.webBuild,
	);
	let bootId: string | null = null;
	live.on("ready", (r) => {
		if (bootId && r.bootId !== bootId)
			void queryClient.invalidateQueries({ queryKey: keys.hello() });
		bootId = r.bootId;
	});
	live.on("security", (v) => {
		// Every tab hears about passkey changes, so a surprise is noticed.
		store.showToast(v.message, "warn");
		store.securityVersion.value++;
	});

	// boot() asked for /hello while this chunk loaded: seed it, then keep it live.
	if (firstHello)
		void firstHello
			.then((h) => queryClient.setQueryData(keys.hello(), applyHello(h)))
			.catch(() => {})
			.finally(() => mount(defs.hello()));
	else mount(defs.hello());
	mount(defs.attention());
	mount(defs.recent());
	// The approvals log lives in the cache; mount it so it isn't collected.
	mount({
		queryKey: keys.approvals(),
		queryFn: async () =>
			queryClient.getQueryData<ApprovalSeen[]>(keys.approvals()) ?? [],
		poll: false,
		staleTime: Number.POSITIVE_INFINITY,
	});

	// The visible tree and its expanded branches. A device's first visit asks
	// for the default-open branches with the top level (one round trip).
	if (store.expansionPending()) expandNextTree("default");
	const treeMounts = keyedMounts();
	effect(() => {
		const g = store.TREE_GROUP;
		const f = store.filter.value;
		const s = store.sort.value;
		const wanted = new Map<string, () => () => void>();
		wanted.set(hashKey(keys.tree(g, f, s)), () =>
			mount(defs.tree(queryClient, g, f, s)),
		);
		for (const id of store.expanded.value)
			wanted.set(hashKey(keys.children(id, f, s)), () =>
				mount(defs.children(id, f, s)),
			);
		treeMounts(wanted);
		// Cached data (a filter cleared, a branch re-expanded) fires no
		// cache event: mirror it now.
		onCacheEvent(keys.tree(g, f, s));
		for (const id of store.expanded.peek())
			onCacheEvent(keys.children(id, f, s));
	});

	// The open session's row (and with it the session topic: row + transcript).
	const sessionMounts = keyedMounts();
	effect(() => {
		const r = route.value;
		const id =
			r.view === "agent" || r.view === "approval" || r.view === "changes"
				? r.id
				: null;
		const wanted = new Map<string, () => () => void>();
		if (id)
			wanted.set(id, () => {
				// The transcript starts loading now, while the session's chunks
				// download, not once its view mounts.
				prefetchAgent(id);
				return mount(defs.agent(id));
			});
		sessionMounts(wanted);
	});

	// Subagent lists the sidebar shows (an agent's disclosure is open).
	const subMounts = keyedMounts();
	effect(() => {
		const wanted = new Map<string, () => () => void>();
		for (const id of subOpen.value)
			wanted.set(id, () => mount(defs.subagents(id)));
		subMounts(wanted);
		for (const id of subOpen.peek()) onCacheEvent(keys.subagents(id));
	});

	// The builder's live count and preview page.
	const builderMounts = keyedMounts();
	effect(() => {
		const q = store.builderQuery.value;
		const res = store.builderResults.value;
		const wanted = new Map<string, () => () => void>();
		if (q !== null) wanted.set(`count:${q}`, () => mount(defs.count(q)));
		if (res) {
			const sort = res.sort ?? "attention";
			const limit = res.limit ?? 50;
			wanted.set(`results:${res.selector}:${sort}:${limit}`, () =>
				mountAgents(res.selector, sort, limit),
			);
		}
		builderMounts(wanted);
	});

	// Receipts the composer watches.
	const receiptMounts = keyedMounts();
	effect(() => {
		const wanted = new Map<string, () => () => void>();
		for (const id of store.receiptWatch.value.keys())
			wanted.set(id, () => mount(defs.receipts(id)));
		receiptMounts(wanted);
	});

	startLive();
}

function mountAgents(selector: string, sort: AgentSort, limit: number) {
	const queryKey = keys.agents(selector, sort, limit);
	const hash = hashKey(queryKey);
	if (mounts.has(hash)) return () => {};
	mounts.set(
		hash,
		observeAgents(queryClient, live, queryKey, { selector, sort, limit }),
	);
	return () => {
		mounts.get(hash)?.stop();
		mounts.delete(hash);
	};
}

// ------------------------------------------------------------ store actions

export function refetchTop() {
	return queryClient.invalidateQueries({ queryKey: treeKey(), exact: true });
}

export async function loadMore(branchId: string) {
	const f = store.filter.peek();
	const s = store.sort.peek();
	const key = branchId === "" ? treeKey() : keys.children(branchId, f, s);
	const b = store.branches.get(branchId);
	if (b) {
		b.loading = true;
		store.bumpTree();
	}
	try {
		await fetchMoreTree(queryClient, key);
	} catch (err) {
		store.handleError(err, true);
	}
	const after = store.branches.get(branchId);
	if (after) {
		after.loading = false;
		store.bumpTree();
	}
}

export function refreshAll() {
	return queryClient.invalidateQueries({ refetchType: "active" });
}
