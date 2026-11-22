import { randomBytes } from "node:crypto";
import type { PulsarService } from "../service/index.ts";
import {
	type AgentSort,
	encodeCursor,
	type TreeGroup,
} from "../service/views.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import type {
	ChangesMode,
	ChangesSummary,
	SubagentRow,
	Subscription,
} from "./wire.ts";

/**
 * Live updates for the app over Server-Sent Events.
 *
 * A browser tab holds one stream and replaces its subscription set with
 * `PUT /subscriptions/:streamId`. Each subscription maps to topics shared
 * by every stream that wants them; a topic's state is recomputed on a
 * coalescing tick (registry changes are not all announced on the event bus)
 * and only differences go out. Attention changes go out at once.
 *
 * Event ids are `<bootId>.<streamId>.<seq>`, so a reconnect with
 * `Last-Event-ID` finds its stream (kept for `retainMs` after a disconnect)
 * and gets the topic events it missed, or a fresh snapshot of a topic whose
 * events were pruned. A restarted daemon or an expired stream answers with
 * `gap` and a new stream; so does a stream whose client fell too far behind.
 *
 * The open session (`session`) also streams its live transcript as
 * `transcript {agent, events}` events: sent promptly (not on the tick), one
 * batch per turn, through the same bounded queue. Clients subscribe first,
 * then page `GET /agents/:id/transcript`, and merge by event id (a live
 * event replaces its id; a page never overwrites an id the client holds).
 *
 * The open changes viewer (`changes`) streams that agent's worktree summary
 * as `changes` events whenever it moves (git runs only while a connected
 * stream wants it); a new subscriber gets the last summary at once.
 */
export type { Subscription } from "./wire.ts";

export const EMPTY_SUBSCRIPTION: Subscription = {
	expanded: [],
	window: null,
	session: null,
	query: null,
	results: null,
	receipts: [],
	changes: null,
};

export interface HubOptions {
	/** How often registry changes are coalesced into events. */
	coalesceMs?: number;
	/** How long topic events and disconnected streams are kept for resume. */
	retainMs?: number;
	/** Events a stream may have unsent before it gets a `gap`. */
	queueMax?: number;
	/** Streams one login may hold (tabs, reconnects); the oldest goes first. */
	maxStreamsPerLogin?: number;
	keepaliveMs?: number;
}

type TopicKind =
	| "attention"
	| "tree"
	| "children"
	| "agent"
	| "query"
	| "results"
	| "receipts"
	| "transcript"
	| "changes"
	| "approvals"
	| "security"
	| "notify"
	| "launches"
	| "subagents";

interface TopicEvent {
	seq: number;
	at: number;
	event: string;
	data: unknown;
}

interface Topic {
	key: string;
	kind: TopicKind;
	args: string[];
	/** Comparison keys of what was last sent, by item id ("" for whole-topic state). */
	state: Map<string, string> | null;
	events: TopicEvent[];
	/** Highest seq pruned from `events`; resume before it needs a snapshot. */
	floor: number;
	/** Transcript topics: the tailer subscription, and live events batched for one turn. */
	off?: (() => void) | null;
	pending?: TranscriptEvent[];
	flushing?: boolean;
	/** Changes topics: the last summary sent. */
	last?: ChangesSummary | null;
	/** Remote subagent topics: the home node's last list. */
	remote?: SubagentRow[];
}

interface Connection {
	push(chunk: string): void;
	close(): void;
}

interface Stream {
	id: string;
	login: string;
	sub: Subscription;
	topics: Set<string>;
	/** Seq of the snapshot each topic started from on this stream. */
	since: Map<string, number>;
	conn: Connection | null;
	detachedAt: number;
	queue: string[];
	wake: (() => void) | null;
}

/** JSON with `lastSeen`/`lastActive` cut to the minute, so scans that only touch presence send nothing. */
function compareKey(value: unknown): string {
	return JSON.stringify(value, (k, v) =>
		(k === "lastSeen" || k === "lastActive") && typeof v === "number"
			? Math.floor(v / 60_000)
			: v,
	);
}

function topicKey(kind: TopicKind, ...args: string[]) {
	return JSON.stringify([kind, ...args]);
}

/** Topic keys a subscription needs. */
function topicsOf(sub: Subscription, login: string): string[] {
	// Every stream hears approvals as they change (no snapshot: `attention` has the pending ones).
	const keys = [
		topicKey("attention"),
		topicKey("approvals"),
		topicKey("security"),
		// Finished and failed turns of agents the operator acted on (src/service/turns.ts).
		topicKey("notify"),
		topicKey("launches"),
	];
	const filter = sub.window?.filter ?? "";
	if (sub.window) keys.push(topicKey("tree", sub.window.group, filter));
	for (const id of sub.expanded) keys.push(topicKey("children", id, filter));
	if (sub.session)
		keys.push(
			topicKey("agent", sub.session),
			topicKey("transcript", sub.session),
		);
	if (sub.query !== null) keys.push(topicKey("query", sub.query));
	if (sub.results) {
		const r = sub.results;
		keys.push(
			topicKey(
				"results",
				r.selector,
				r.sort ?? "attention",
				String(r.offset ?? 0),
				String(r.limit ?? 50),
			),
		);
	}
	if (sub.changes)
		keys.push(topicKey("changes", sub.changes.agent, sub.changes.mode));
	for (const id of sub.subagents ?? []) keys.push(topicKey("subagents", id));
	// Receipts are the user's own sends: the topic is per login.
	for (const id of sub.receipts) keys.push(topicKey("receipts", login, id));
	return keys;
}

const encoder = new TextEncoder();

export class EventHub {
	readonly bootId = randomBytes(6).toString("base64url");
	private seq = 0;
	private topics = new Map<string, Topic>();
	private streams = new Map<string, Stream>();
	private readonly service: PulsarService;
	private readonly coalesceMs: number;
	private readonly retainMs: number;
	private readonly queueMax: number;
	private readonly maxStreamsPerLogin: number;
	private readonly keepaliveMs: number;
	private timers: NodeJS.Timeout[] = [];
	private offBus: (() => void) | null = null;
	private offApprovals: (() => void) | null = null;
	private dirty = true;
	private lastSignature = "";
	private lastMessageWrites = -1;

	constructor(service: PulsarService, opts: HubOptions = {}) {
		this.service = service;
		this.coalesceMs = opts.coalesceMs ?? 500;
		this.retainMs = opts.retainMs ?? 5 * 60_000;
		this.queueMax = opts.queueMax ?? 256;
		this.maxStreamsPerLogin = opts.maxStreamsPerLogin ?? 32;
		this.keepaliveMs = opts.keepaliveMs ?? 15_000;
	}

	start() {
		const tick = setInterval(() => this.tick(), this.coalesceMs);
		const keepalive = setInterval(() => this.keepalive(), this.keepaliveMs);
		const gc = setInterval(() => this.gc(), Math.min(this.retainMs, 30_000));
		for (const t of [tick, keepalive, gc]) t.unref();
		this.timers = [tick, keepalive, gc];
		this.offBus = this.service.events.onAny((event) => {
			this.dirty = true;
			// Someone waits on the user: tell every tab now, not on the next tick.
			if (event === "attention") this.refresh(topicKey("attention"));
		});
		const offApproval = this.service.events.on("approval", (data) =>
			this.publish(topicKey("approvals"), "approval", data),
		);
		const offSecurity = this.service.events.on("security", (data) =>
			this.publish(topicKey("security"), "security", data),
		);
		const offNotify = this.service.events.on("notify", (data) =>
			this.publish(topicKey("notify"), "notify", data),
		);
		const offLaunch = this.service.events.on("launch", (data) =>
			this.publish(topicKey("launches"), "launch", data),
		);
		// Usage limit warnings ride the notify topic (every stream hears them).
		const offLimit = this.service.events.on("limit", (data) =>
			this.publish(topicKey("notify"), "limit", data),
		);
		this.offApprovals = () => {
			offApproval();
			offSecurity();
			offNotify();
			offLaunch();
			offLimit();
		};
	}

	stop() {
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.offBus?.();
		this.offBus = null;
		this.offApprovals?.();
		this.offApprovals = null;
		for (const s of this.streams.values()) s.conn?.close();
		this.streams.clear();
		for (const t of this.topics.values()) t.off?.();
		this.topics.clear();
	}

	get streamCount() {
		return this.streams.size;
	}

	/**
	 * Opens (or, with a matching `Last-Event-ID`, resumes) a stream for
	 * `login`. Returns the response body.
	 */
	open(login: string, lastEventId: string | null): ReadableStream<Uint8Array> {
		const parsed = this.parseEventId(lastEventId);
		const existing = parsed ? this.streams.get(parsed.streamId) : undefined;
		let stream: Stream;
		let resumed = false;
		if (existing && existing.login === login && parsed) {
			stream = existing;
			existing.conn?.close();
			resumed = true;
		} else {
			stream = {
				id: randomBytes(12).toString("base64url"),
				login,
				sub: EMPTY_SUBSCRIPTION,
				topics: new Set(),
				since: new Map(),
				conn: null,
				detachedAt: 0,
				queue: [],
				wake: null,
			};
			this.limitStreams(login);
			this.streams.set(stream.id, stream);
		}
		const body = this.connect(stream);
		// On a resume, `ready` carries the resume point: with the newest seq,
		// a drop before the replay below would skip the missed events.
		this.write(
			stream,
			"ready",
			{ streamId: stream.id, bootId: this.bootId, resumed },
			resumed && parsed ? parsed.seq : this.seq,
		);
		if (resumed && parsed) this.replay(stream, parsed.seq);
		else {
			if (lastEventId) this.write(stream, "gap", { reason: "expired" });
			this.setSubscription(stream.id, login, EMPTY_SUBSCRIPTION);
		}
		return body;
	}

	/**
	 * Keeps one login under its stream cap before it opens another: detached
	 * streams go first, then the oldest connected one (its tab reconnects
	 * with a gap). Map order is creation order.
	 */
	private limitStreams(login: string) {
		const mine = [...this.streams.values()].filter((s) => s.login === login);
		const excess = mine.length - this.maxStreamsPerLogin + 1;
		if (excess <= 0) return;
		const order = [
			...mine.filter((s) => !s.conn),
			...mine.filter((s) => s.conn),
		];
		for (const s of order.slice(0, excess)) {
			s.conn?.close();
			this.streams.delete(s.id);
		}
		this.gcTopics();
	}

	/**
	 * Replaces a stream's subscription set; new topics start with a snapshot.
	 * False if unknown. `opened`: the app's own subscription (what is on
	 * screen), not a prefetch's `watchSession`, so its open session counts as
	 * the operator opening that agent (finish/fail notifications follow it).
	 */
	setSubscription(
		streamId: string,
		login: string,
		sub: Subscription,
		opts: { opened?: boolean } = {},
	): boolean {
		const stream = this.streams.get(streamId);
		if (!stream || stream.login !== login) return false;
		const next = new Set(topicsOf(sub, login));
		if (opts.opened && sub.session) this.service.interest.note(sub.session);
		stream.sub = sub;
		for (const key of stream.topics)
			if (!next.has(key)) stream.since.delete(key);
		const added = [...next].filter((k) => !stream.topics.has(k));
		stream.topics = next;
		for (const key of added) this.snapshot(stream, key);
		this.gcTopics();
		return true;
	}

	/**
	 * Makes `agentId` the stream's open session (its row and live transcript),
	 * keeping the rest of its subscription: `GET /agents/:id/transcript?stream=`
	 * follows the transcript before it reads the page, so the app need not
	 * wait for its subscription round trip first. False if the stream is
	 * unknown or another login's.
	 */
	watchSession(streamId: string, login: string, agentId: string): boolean {
		const stream = this.streams.get(streamId);
		if (!stream || stream.login !== login) return false;
		if (stream.sub.session === agentId) return true;
		return this.setSubscription(streamId, login, {
			...stream.sub,
			session: agentId,
		});
	}

	private parseEventId(id: string | null) {
		if (!id) return null;
		const m = /^([\w-]+)\.([\w-]+)\.(\d+)$/.exec(id.trim());
		if (!m || m[1] !== this.bootId) return null;
		return { streamId: m[2]!, seq: Number(m[3]) };
	}

	private connect(stream: Stream): ReadableStream<Uint8Array> {
		stream.queue = [];
		stream.detachedAt = 0;
		let closed = false;
		const conn: Connection = {
			push: (chunk) => {
				if (closed) return;
				if (stream.queue.length >= this.queueMax) {
					// The client is too slow: drop what it has not read and say so.
					stream.queue = [];
					stream.queue.push(this.frame(stream, "gap", { reason: "overflow" }));
				} else stream.queue.push(chunk);
				stream.wake?.();
			},
			close: () => {
				if (closed) return;
				closed = true;
				stream.wake?.();
			},
		};
		stream.conn = conn;
		const detach = () => {
			closed = true;
			if (stream.conn === conn) {
				stream.conn = null;
				stream.detachedAt = Date.now();
				stream.queue = [];
				// A closed stream stops tailing transcripts nobody else watches.
				this.gcTopics();
			}
		};
		return new ReadableStream<Uint8Array>(
			{
				pull: async (controller) => {
					while (!closed && stream.queue.length === 0)
						await new Promise<void>((resolve) => {
							stream.wake = resolve;
						});
					stream.wake = null;
					if (closed) {
						detach();
						controller.close();
						return;
					}
					controller.enqueue(encoder.encode(stream.queue.shift()!));
				},
				cancel: () => detach(),
			},
			{ highWaterMark: 0 },
		);
	}

	private frame(stream: Stream, event: string, data: unknown, seq = this.seq) {
		return `id: ${this.bootId}.${stream.id}.${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	private write(stream: Stream, event: string, data: unknown, seq = this.seq) {
		stream.conn?.push(this.frame(stream, event, data, seq));
	}

	/**
	 * Missed topic events after `seq`, in seq order across topics (so a drop
	 * mid-replay resumes correctly), then fresh snapshots of topics whose
	 * events were pruned or that started after `seq`.
	 */
	private replay(stream: Stream, seq: number) {
		const missed: TopicEvent[] = [];
		const stale: string[] = [];
		for (const key of stream.topics) {
			const topic = this.topics.get(key);
			const since = stream.since.get(key) ?? Number.POSITIVE_INFINITY;
			if (!topic || since > seq || topic.floor > seq) stale.push(key);
			else for (const e of topic.events) if (e.seq > seq) missed.push(e);
		}
		missed.sort((a, b) => a.seq - b.seq);
		for (const e of missed) this.write(stream, e.event, e.data, e.seq);
		for (const key of stale) this.snapshot(stream, key, true);
	}

	private topic(key: string): Topic {
		let topic = this.topics.get(key);
		if (!topic) {
			const [kind, ...args] = JSON.parse(key) as [TopicKind, ...string[]];
			// Nothing before now is in its log: a resume from earlier resyncs.
			topic = { key, kind, args, state: null, events: [], floor: this.seq };
			this.topics.set(key, topic);
			if (kind === "transcript") this.tailTranscript(topic);
			if (kind === "changes") this.watchChanges(topic);
			if (kind === "subagents") this.watchSubagents(topic);
		}
		return topic;
	}

	/** One tailer subscription per watched transcript, shared by every stream. */
	private tailTranscript(topic: Topic) {
		const agentId = topic.args[0] ?? "";
		topic.pending = [];
		try {
			topic.off = this.service.transcripts.subscribe(agentId, (events) => {
				// A subagent call or sidechain record: its children changed.
				this.service.subagents.noteEvents(agentId, events);
				topic.pending!.push(...events);
				if (topic.flushing) return;
				topic.flushing = true;
				// Prompt, not on the coalescing tick; batched within one turn.
				setImmediate(() => this.flushTranscript(topic));
			});
		} catch {
			// An unknown agent: nothing to tail; the app pages and gets a 404.
			topic.off = null;
		}
	}

	/**
	 * A subagent list someone shows: local ones are listed now and kept
	 * current by the service (its `subagents` bus event makes the tick
	 * recompute); remote ones are fetched from the home node on each pool
	 * change.
	 */
	private watchSubagents(topic: Topic) {
		const id = topic.args[0] ?? "";
		const subs = this.service.subagents;
		if (this.service.registry.get(id)) {
			subs.watch(id);
			void subs.refresh(id).then(() => this.refresh(topic.key));
			return;
		}
		const load = () =>
			void subs.list(id).then(
				(list) => {
					if (this.topics.get(topic.key) !== topic) return;
					topic.remote = list.items;
					this.refresh(topic.key);
				},
				() => {},
			);
		load();
		topic.off = this.service.events.on("pool", load);
	}

	/** One worktree watch per open changes viewer, shared by every stream. */
	private watchChanges(topic: Topic) {
		const [agentId = "", mode = "worktree"] = topic.args;
		topic.last = null;
		try {
			topic.off = this.service.changes.watch(
				agentId,
				mode as ChangesMode,
				(summary) => {
					if (this.topics.get(topic.key) !== topic) return;
					topic.last = summary;
					this.publish(topic.key, "changes", summary);
				},
			);
		} catch {
			// An unknown agent: nothing to watch; the app's fetch gets a 404.
			topic.off = null;
		}
	}

	private flushTranscript(topic: Topic) {
		topic.flushing = false;
		const batch = topic.pending ?? [];
		topic.pending = [];
		if (this.topics.get(topic.key) !== topic || batch.length === 0) return;
		// A block that changed twice in one turn goes out once, as it is now.
		const byId = new Map<string, TranscriptEvent>();
		for (const e of batch) {
			byId.delete(e.id);
			byId.set(e.id, e);
		}
		const e: TopicEvent = {
			seq: ++this.seq,
			at: Date.now(),
			event: "transcript",
			data: { agent: topic.args[0], events: [...byId.values()] },
		};
		topic.events.push(e);
		for (const stream of this.streams.values())
			if (stream.topics.has(topic.key))
				this.write(stream, e.event, e.data, e.seq);
	}

	/**
	 * Sends one stream the whole current state of a topic. A transcript has no
	 * snapshot here (the app pages it over REST after subscribing); on a resume
	 * that cannot replay it, the stream gets a `gap` for it instead.
	 */
	private snapshot(stream: Stream, key: string, resuming = false) {
		const topic = this.topic(key);
		if (
			topic.kind === "approvals" ||
			topic.kind === "security" ||
			topic.kind === "notify" ||
			topic.kind === "launches"
		) {
			stream.since.set(key, ++this.seq);
			return;
		}
		if (topic.kind === "changes") {
			stream.since.set(key, ++this.seq);
			if (topic.last) this.write(stream, "changes", topic.last);
			return;
		}
		if (topic.kind === "transcript") {
			stream.since.set(key, ++this.seq);
			if (resuming)
				this.write(stream, "gap", {
					reason: "expired",
					topic: "transcript",
					agent: topic.args[0],
				});
			return;
		}
		const current = this.compute(topic);
		if (topic.state === null) topic.state = current.state;
		this.seq++;
		stream.since.set(key, this.seq);
		this.write(stream, current.event, { ...current.full, full: true });
	}

	/** Sends one event to a topic's streams at once (kept for resume). */
	private publish(key: string, event: string, data: unknown) {
		const topic = this.topics.get(key);
		if (!topic) return;
		const e: TopicEvent = { seq: ++this.seq, at: Date.now(), event, data };
		topic.events.push(e);
		for (const stream of this.streams.values())
			if (stream.topics.has(key)) this.write(stream, e.event, e.data, e.seq);
	}

	/** Recomputes one topic and sends what changed to its streams. */
	private refresh(key: string) {
		const topic = this.topics.get(key);
		if (
			!topic ||
			topic.kind === "transcript" ||
			topic.kind === "changes" ||
			topic.kind === "approvals" ||
			topic.kind === "security" ||
			topic.kind === "notify" ||
			topic.kind === "launches"
		)
			return;
		const next = this.compute(topic);
		const diff = next.diff(topic.state ?? new Map());
		topic.state = next.state;
		if (!diff) return;
		const e: TopicEvent = {
			seq: ++this.seq,
			at: Date.now(),
			event: next.event,
			data: { ...diff, full: false },
		};
		topic.events.push(e);
		for (const stream of this.streams.values())
			if (stream.topics.has(key)) this.write(stream, e.event, e.data, e.seq);
	}

	/**
	 * A topic's current state: the event name, its full payload, comparison
	 * keys, and a function giving the payload for what changed since `prev`
	 * (null when nothing did).
	 */
	private compute(topic: Topic): {
		event: string;
		full: Record<string, unknown>;
		state: Map<string, string>;
		diff: (prev: Map<string, string>) => Record<string, unknown> | null;
	} {
		const { views } = this.service.app;
		const whole = (event: string, payload: Record<string, unknown>) => {
			const state = new Map([["", compareKey(payload)]]);
			return {
				event,
				full: payload,
				state,
				diff: (prev: Map<string, string>) =>
					prev.get("") === state.get("") ? null : payload,
			};
		};
		const items = <T extends { id: string }>(
			event: string,
			head: Record<string, unknown>,
			list: T[],
		) => {
			const state = new Map(list.map((n) => [n.id, compareKey(n)]));
			const ids = list.map((n) => n.id);
			state.set("", JSON.stringify(ids));
			return {
				event,
				full: { ...head, items: list, total: list.length },
				state,
				diff: (prev: Map<string, string>) => {
					const changed = list.filter(
						(n) => prev.get(n.id) !== state.get(n.id),
					);
					const removed = [...prev.keys()].filter(
						(id) => id !== "" && !state.has(id),
					);
					const reordered = prev.get("") !== state.get("");
					if (!changed.length && !removed.length && !reordered) return null;
					return {
						...head,
						items: changed,
						removed,
						order: ids,
						total: list.length,
					};
				},
			};
		};
		const [a = "", b = "", c = "", d = ""] = topic.args;
		switch (topic.kind) {
			case "attention": {
				const r = views.attention();
				return whole("attention", { items: r.items, total: r.total });
			}
			case "tree":
				return items(
					"tree",
					{ group: a, filter: b },
					views.treeNodes(a as TreeGroup, b || undefined),
				);
			case "children":
				return items(
					"children",
					{ nodeId: a, filter: b },
					safe(() => views.childNodes(a, b || undefined), []),
				);
			case "agent": {
				const agent = this.service.registry.find(a);
				return whole("agent", {
					id: a,
					agent: agent && agent.status !== "gone" ? views.row(agent) : null,
				});
			}
			case "query": {
				const rows = views.matching(a);
				const totals: Record<string, number> = {};
				for (const r of rows) totals[r.wake] = (totals[r.wake] ?? 0) + 1;
				return whole("query", {
					selector: a,
					total: rows.length,
					machines: new Set(rows.map((r) => r.machineId)).size,
					totals,
				});
			}
			case "results": {
				const offset = Number(c) || 0;
				const limit = Number(d) || 50;
				const r = views.agents({
					selector: a,
					sort: b as AgentSort,
					limit: offset + limit,
				});
				return whole("results", {
					selector: a,
					sort: b,
					offset,
					limit,
					items: r.items.slice(offset),
					total: r.total,
					machines: r.machines,
				});
			}
			case "receipts": {
				const user = { kind: "human" as const, login: a, node: "" };
				const r = safe(
					() => this.service.app.receipts(user, b, { limit: 100 }),
					null,
				);
				return whole("receipts", {
					messageId: b,
					...(r
						? {
								...r,
								nextCursor:
									r.items.length < r.total
										? encodeCursor(r.items.length)
										: null,
							}
						: { missing: true }),
				});
			}
			case "subagents": {
				const list = this.service.registry.get(a)
					? this.service.subagents.cached(a)
					: (topic.remote ?? []);
				return items("subagents", { agentId: a }, list);
			}
			case "transcript":
				// Never recomputed: live events arrive from the tailer (see tailTranscript).
				return whole("transcript", { agent: a, events: [] });
			case "changes":
			case "approvals":
			case "security":
			case "notify":
			case "launches":
				// Never recomputed: events arrive from the service (see publish).
				return whole(topic.kind, {});
		}
	}

	private signature(): string {
		const parts: string[] = [
			String(this.service.registry.pool?.version() ?? 0),
		];
		for (const a of this.service.registry.all())
			parts.push(
				a.id,
				a.name,
				a.status,
				a.inbound,
				a.reach,
				a.project ?? "",
				a.branch ?? "",
				a.model ?? "",
				a.activity ?? "",
				a.machine ?? "",
				a.tags.join(","),
				String(Math.floor(a.lastSeen / 60_000)),
				this.service.registry.needsYou(a.id) ? "!" : "",
			);
		return parts.join("\u0000");
	}

	/** The coalescing tick: recompute live topics when anything may have changed. */
	private tick() {
		if (this.topics.size === 0) return;
		// Receipt states move without bus events (an inbox read): recompute the
		// watched ones when the store's messages or receipts changed; only
		// changes go out.
		const writes = this.service.store.messageWrites;
		if (writes !== this.lastMessageWrites) {
			this.lastMessageWrites = writes;
			for (const [key, topic] of this.topics)
				if (topic.kind === "receipts") this.refresh(key);
		}
		const sig = this.signature();
		if (!this.dirty && sig === this.lastSignature) return;
		this.dirty = false;
		this.lastSignature = sig;
		for (const key of [...this.topics.keys()]) this.refresh(key);
	}

	private keepalive() {
		for (const s of this.streams.values())
			if (s.conn && s.queue.length === 0) s.conn.push(": keepalive\n\n");
	}

	private gc() {
		const now = Date.now();
		for (const [id, s] of this.streams)
			if (!s.conn && s.detachedAt && now - s.detachedAt > this.retainMs)
				this.streams.delete(id);
		this.gcTopics();
		for (const topic of this.topics.values()) {
			while (
				topic.events.length &&
				(now - topic.events[0]!.at > this.retainMs ||
					topic.events.length > 1000)
			)
				topic.floor = topic.events.shift()!.seq;
		}
	}

	/**
	 * Drops topics no stream wants. A transcript topic also goes once no
	 * connected stream wants it (a detached stream gets a `gap` for it on
	 * resume), so a closed tab never keeps a file watched.
	 */
	private gcTopics() {
		const used = new Set<string>();
		const live = new Set<string>();
		for (const s of this.streams.values())
			for (const k of s.topics) {
				used.add(k);
				if (s.conn) live.add(k);
			}
		for (const [key, topic] of this.topics) {
			const keep =
				topic.kind === "transcript" || topic.kind === "changes"
					? live.has(key)
					: used.has(key);
			if (keep) continue;
			topic.off?.();
			this.topics.delete(key);
		}
	}
}

function safe<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}
