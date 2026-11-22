/**
 * One event stream per tab drives the query cache. Events patch cached data
 * in place (setQueryData) or invalidate exact keys; the subscription is
 * derived from the mounted queries (topics.ts) and sent debounced. Plain TS
 * with injected dependencies: no DOM access at import.
 */
import { hashKey, type Query, type QueryClient } from "@tanstack/react-query";
import type {
	AgentRow,
	Approval,
	AttentionList,
	ReceiptsPage,
	ServerEvent,
	ServerEvents,
	SubagentRow,
	Subscription,
	TranscriptEvent,
	TreeNode,
} from "../api/types.ts";
import { keys } from "./keys.ts";
import {
	type AgentPages,
	applyListUpdate,
	applyResults,
	applyTranscriptLive,
	type ListData,
	patchAttentionRows,
	patchPlainRows,
	patchTreeRows,
	type TranscriptData,
} from "./patch.ts";
import { deriveSubscription, type Mounted, subscriptionKey } from "./topics.ts";

export type StreamState = "connecting" | "open" | "retrying" | "closed";

/** Opens the event stream (client.ts `openEvents`, or a fake in tests). */
export type Transport = (handlers: {
	onEvent: (e: ServerEvent) => void;
	onState: (s: "open" | "retrying" | "closed") => void;
}) => { close: () => void };

/** An approval as the last `approval` event showed it, with when it came. */
export interface ApprovalSeen {
	approval: Approval;
	at: number;
}
/** How long an ended approval keeps its card (showing the outcome). */
export const OUTCOME_MS = 60_000;

type Listeners = {
	transcript: { agentId: string; events: TranscriptEvent[] };
	receipts: ReceiptsPage;
	gap: ServerEvents["gap"];
	security: ServerEvents["security"];
	approval: Approval;
	ready: ServerEvents["ready"];
	query: ServerEvents["query"];
	notify: ServerEvents["notify"];
	launch: ServerEvents["launch"];
	limit: ServerEvents["limit"];
	machines: ServerEvents["machines"];
	git: ServerEvents["git"];
};

export interface LiveOptions {
	client: QueryClient;
	transport: Transport;
	subscribe: (streamId: string, sub: Subscription) => Promise<unknown>;
	/** Debounce for subscription changes (ms). */
	debounceMs?: number;
	/** Batches transcript events (one animation frame in the browser). */
	frame?: (fn: () => void) => void;
	now?: () => number;
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (t: unknown) => void;
}

export class LiveSync {
	readonly client: QueryClient;
	state: StreamState = "closed";
	streamId: string | null = null;

	private opts: Required<Omit<LiveOptions, "client">>;
	private conn: { close: () => void } | null = null;
	private mounted = new Map<string, Mounted>();
	private seq = 0;
	/** What the last acknowledged PUT covered (query hashes). */
	private acked = new Set<string>();
	private ackedKey = "";
	private sentKey = "";
	private pendingCovered = new Set<string>();
	private subTimer: unknown;
	private inflight: Promise<void> | null = null;
	private stateListeners = new Set<() => void>();
	private listeners: {
		[K in keyof Listeners]: Set<(v: Listeners[K]) => void>;
	} = {
		transcript: new Set(),
		receipts: new Set(),
		gap: new Set(),
		security: new Set(),
		approval: new Set(),
		ready: new Set(),
		query: new Set(),
		notify: new Set(),
		launch: new Set(),
		limit: new Set(),
		machines: new Set(),
		git: new Set(),
	};
	private transcriptBatch = new Map<string, TranscriptEvent[]>();
	private frameQueued = false;
	private unwatch: (() => void) | null = null;
	/** Bumped when the stream state or coverage changes. */
	version = 0;

	constructor(o: LiveOptions) {
		this.client = o.client;
		this.opts = {
			transport: o.transport,
			subscribe: o.subscribe,
			debounceMs: o.debounceMs ?? 250,
			frame: o.frame ?? ((fn) => setTimeout(fn, 16)),
			now: o.now ?? Date.now,
			setTimeout: o.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
			clearTimeout:
				o.clearTimeout ??
				((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
		};
		// Mounted queries (with observers) decide the subscription.
		for (const q of this.client.getQueryCache().getAll()) this.track(q);
		this.unwatch = this.client.getQueryCache().subscribe((e) => {
			if (
				e.type === "observerAdded" ||
				e.type === "observerRemoved" ||
				e.type === "observerOptionsUpdated"
			)
				this.track(e.query);
			else if (e.type === "removed") this.untrack(e.query.queryHash);
		});
	}

	// -------------------------------------------------------- lifecycle

	/** Opens the stream (again); no-op while one is open. */
	start() {
		if (this.conn) return;
		this.setState("connecting");
		this.conn = this.opts.transport({
			onEvent: (e) => this.onEvent(e),
			onState: (s) => {
				if (s === "retrying") {
					this.streamId = null;
					this.clearAck();
				}
				this.setState(s);
			},
		});
	}

	/** Closes the stream (a hidden tab); `start()` resumes with Last-Event-ID. */
	stop() {
		const c = this.conn;
		this.conn = null;
		this.streamId = null;
		this.clearAck();
		c?.close();
		this.setState("closed");
	}

	dispose() {
		this.stop();
		this.unwatch?.();
		this.opts.clearTimeout(this.subTimer);
	}

	get connected() {
		return this.state === "open";
	}

	/** Whether the stream keeps this query live (otherwise it polls). */
	isCovered(queryHash: string): boolean {
		return this.state === "open" && this.acked.has(queryHash);
	}

	subscribeState(fn: () => void): () => void {
		this.stateListeners.add(fn);
		return () => this.stateListeners.delete(fn);
	}

	on<K extends keyof Listeners>(
		type: K,
		fn: (v: Listeners[K]) => void,
	): () => void {
		this.listeners[type].add(fn);
		return () => this.listeners[type].delete(fn);
	}

	private emit<K extends keyof Listeners>(type: K, v: Listeners[K]) {
		for (const fn of [...this.listeners[type]]) fn(v);
	}

	private setState(s: StreamState) {
		if (this.state === s) return;
		this.state = s;
		this.changed();
	}

	private changed() {
		this.version++;
		for (const fn of [...this.stateListeners]) fn();
	}

	private clearAck() {
		this.ackedKey = "";
		this.sentKey = "";
		if (this.acked.size) {
			this.acked = new Set();
			this.changed();
		}
	}

	// -------------------------------------------------------- subscription

	private track(q: Query) {
		const hash = q.queryHash;
		// Mounted and enabled: a disabled observer (no id yet) asks for nothing.
		if (q.isActive()) {
			if (!this.mounted.has(hash))
				this.mounted.set(hash, { key: q.queryKey, seq: ++this.seq });
		} else if (!this.mounted.delete(hash)) return;
		this.scheduleSubscription();
	}

	private untrack(hash: string) {
		if (this.mounted.delete(hash)) this.scheduleSubscription();
	}

	/** The subscription the mounted queries ask for now. */
	current() {
		return deriveSubscription([...this.mounted.values()]);
	}

	private scheduleSubscription() {
		this.opts.clearTimeout(this.subTimer);
		if (!this.streamId) return;
		this.subTimer = this.opts.setTimeout(() => {
			void this.flush();
		}, this.opts.debounceMs);
	}

	/**
	 * Sends the subscription now (skipping the debounce). A transcript query
	 * calls this before fetching its first page, so no live event falls
	 * between the two.
	 */
	async flush(): Promise<void> {
		this.opts.clearTimeout(this.subTimer);
		const id = this.streamId;
		if (!id) return;
		const { sub, covered } = this.current();
		const key = subscriptionKey(sub);
		// Coverage can grow without a new PUT (a second query on a covered topic).
		if (key === this.ackedKey) {
			this.setAcked(covered);
			return;
		}
		if (key === this.sentKey && this.inflight) return this.inflight;
		this.sentKey = key;
		this.pendingCovered = covered;
		const run = this.opts
			.subscribe(id, sub)
			.then(() => {
				if (this.streamId !== id || this.sentKey !== key) return;
				this.ackedKey = key;
				this.setAcked(this.pendingCovered);
			})
			.catch(() => {
				if (this.sentKey === key) this.sentKey = "";
			})
			.finally(() => {
				if (this.inflight === run) this.inflight = null;
			});
		this.inflight = run;
		return run;
	}

	private setAcked(covered: Set<string>) {
		const same =
			covered.size === this.acked.size &&
			[...covered].every((h) => this.acked.has(h));
		if (same) return;
		this.acked = covered;
		this.changed();
	}

	// -------------------------------------------------------- events

	onEvent(e: ServerEvent) {
		const c = this.client;
		switch (e.type) {
			case "ready":
				this.streamId = e.data.streamId;
				this.clearAck();
				this.emit("ready", e.data);
				void this.flush();
				break;
			case "tree":
				this.eachData<ListData<TreeNode>>(
					(k) =>
						k[0] === "tree" && k[1] === e.data.group && k[2] === e.data.filter,
					(d) => applyListUpdate(d, e.data),
				);
				for (const n of e.data.items) if (n.agent) this.patchAgent(n.agent);
				break;
			case "children":
				this.eachData<ListData<TreeNode>>(
					(k) =>
						k[0] === "children" &&
						k[1] === e.data.nodeId &&
						k[2] === e.data.filter,
					(d) => applyListUpdate(d, e.data),
				);
				for (const n of e.data.items) if (n.agent) this.patchAgent(n.agent);
				break;
			case "subagents": {
				const data = e.data;
				this.eachData<ListData<SubagentRow>>(
					(k) => k[0] === "subagents" && k[1] === data.agentId,
					(d) => applyListUpdate(d, data),
				);
				for (const row of data.items)
					if (c.getQueryData(keys.subagent(row.id)))
						c.setQueryData<SubagentRow>(keys.subagent(row.id), (old) =>
							old ? { ...old, ...row } : row,
						);
				break;
			}
			case "agent":
				if (e.data.agent) this.patchAgent(e.data.agent);
				else void c.invalidateQueries({ queryKey: keys.agent(e.data.id) });
				break;
			case "results":
				this.eachData<AgentPages>(
					(k) =>
						k[0] === "agents" &&
						k[1] === e.data.selector &&
						k[2] === e.data.sort &&
						k[3] === e.data.limit &&
						e.data.offset === 0,
					(d) => applyResults(d, e.data),
				);
				for (const a of e.data.items) this.patchAgent(a);
				break;
			case "query":
				c.setQueryData(keys.count(e.data.selector), {
					total: e.data.total,
					machines: e.data.machines,
					totals: e.data.totals,
				});
				this.emit("query", e.data);
				break;
			case "attention": {
				const list: AttentionList = {
					items: e.data.items,
					total: e.data.total,
				};
				c.setQueryData(keys.attention(), list);
				for (const i of list.items) this.patchAgent(i.agent, "attention");
				break;
			}
			case "approval": {
				const a = e.data.approval;
				c.setQueryData(keys.approval(a.requestId), a);
				const now = this.opts.now();
				c.setQueryData<ApprovalSeen[]>(keys.approvals(), (prev = []) => [
					// Keep it small: drop what no card shows any more.
					...prev.filter(
						(s) =>
							s.approval.requestId !== a.requestId &&
							(s.approval.state === "pending" || now - s.at < OUTCOME_MS),
					),
					{ approval: a, at: now },
				]);
				this.emit("approval", a);
				break;
			}
			case "receipts":
				if ("missing" in e.data) break;
				c.setQueryData(keys.receipts(e.data.messageId), e.data);
				this.emit("receipts", e.data);
				break;
			case "transcript":
				this.queueTranscript(e.data.agent, e.data.events);
				break;
			case "queue":
				c.setQueryData(keys.queue(e.data.agentId), e.data);
				break;
			case "changes":
				c.setQueryData(keys.changes(e.data.agent, e.data.mode), e.data);
				if (e.data.mode === "worktree")
					c.setQueryData(keys.changesPeek(e.data.agent), e.data);
				break;
			case "notify":
				this.emit("notify", e.data);
				break;
			case "launch":
				// A launch from the app moved on (features/launch).
				this.emit("launch", e.data);
				break;
			case "limit":
				// A plan usage limit passed a threshold (features/limits); the
				// Usage page and limit chips show the new reading.
				void c.invalidateQueries({ queryKey: ["usage"] });
				void c.invalidateQueries({ queryKey: ["usageLimits"] });
				this.emit("limit", e.data);
				break;
			case "usage":
				// New session lines on this machine: token counts, context and
				// limit readings.
				void c.invalidateQueries({ queryKey: ["usage"] });
				void c.invalidateQueries({ queryKey: ["agentUsage"] });
				void c.invalidateQueries({ queryKey: ["usageLimits"] });
				break;
			case "git":
				invalidateGit(c, e.data.agentId);
				this.emit("git", e.data);
				break;
			case "machines":
				// A machine joined, left or changed version (features/diagnostics).
				this.emit("machines", e.data);
				break;
			case "security":
				void c.invalidateQueries({ queryKey: keys.passkeys() });
				void c.invalidateQueries({ queryKey: keys.sessions() });
				this.emit("security", e.data);
				break;
			case "gap":
				// Replay is gone: re-page that transcript, or refetch everything shown.
				if (e.data.topic === "transcript") {
					if (e.data.agent)
						void c.invalidateQueries({
							queryKey: keys.transcript(e.data.agent),
						});
				} else void c.invalidateQueries({ refetchType: "active" });
				this.emit("gap", e.data);
				break;
		}
	}

	private eachData<T>(
		match: (key: readonly unknown[]) => boolean,
		fn: (d: T) => T,
	) {
		for (const q of this.client.getQueryCache().getAll()) {
			if (!match(q.queryKey) || q.state.data === undefined) continue;
			const prev = q.state.data as T;
			const next = fn(prev);
			if (next !== prev) this.client.setQueryData(q.queryKey, next);
		}
	}

	/** Replaces an agent's row in every cached read that shows it. */
	patchAgent(row: AgentRow, skip?: string) {
		patchAgentRows(this.client, row, skip);
	}

	private queueTranscript(agentId: string, events: TranscriptEvent[]) {
		const batch = this.transcriptBatch.get(agentId);
		if (batch) batch.push(...events);
		else this.transcriptBatch.set(agentId, [...events]);
		if (this.frameQueued) return;
		this.frameQueued = true;
		this.opts.frame(() => this.flushTranscripts());
	}

	/** Applies queued transcript events (once per frame). */
	flushTranscripts() {
		this.frameQueued = false;
		const batches = this.transcriptBatch;
		this.transcriptBatch = new Map();
		for (const [agentId, events] of batches) {
			const key = keys.transcript(agentId);
			if (this.client.getQueryData(key) !== undefined)
				this.client.setQueryData<TranscriptData>(key, (d) =>
					d ? applyTranscriptLive(d, events) : d,
				);
			this.emit("transcript", { agentId, events });
			// The daemon marks dropped events with a gap line: re-page.
			if (events.some((e) => e.kind === "system" && e.text === "gap"))
				void this.client.invalidateQueries({ queryKey: key });
		}
	}
}

export const queryHash = (key: readonly unknown[]) => hashKey(key);

/**
 * An agent's git state moved: re-read its git status, PR card, PR review
 * and issue card (only the mounted ones fetch; review file patches are
 * keyed by the PR head and stay).
 */
export function invalidateGit(c: QueryClient, agentId: string) {
	for (const queryKey of [
		["git", "status", agentId],
		["git", "pr", agentId],
		["git", "review", agentId],
	])
		void c.invalidateQueries({ queryKey, exact: true });
	void c.invalidateQueries({ queryKey: ["issue", agentId] });
}

/** Replaces an agent's row in every cached read that shows it. */
export function patchAgentRows(c: QueryClient, row: AgentRow, skip?: string) {
	if (c.getQueryData(keys.agent(row.id)) !== undefined)
		c.setQueryData(keys.agent(row.id), row);
	for (const q of c.getQueryCache().getAll()) {
		const name = q.queryKey[0];
		const d = q.state.data;
		if (d === undefined || d === null || name === skip) continue;
		let next: unknown = d;
		if (name === "tree" || name === "children")
			next = patchTreeRows(d as ListData<TreeNode>, row);
		else if (name === "attention")
			next = patchAttentionRows(d as AttentionList, row);
		else if (name === "recent")
			next = patchPlainRows(d as { items: AgentRow[] }, row);
		else if (name === "agents") {
			const p = d as AgentPages;
			let hit = false;
			const pages = p.pages.map((pg) => {
				const n = patchPlainRows(pg, row);
				if (n !== pg) hit = true;
				return n as typeof pg;
			});
			if (hit) next = { ...p, pages };
		}
		if (next !== d) c.setQueryData(q.queryKey, next);
	}
}
