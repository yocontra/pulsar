// Must come first: TanStack decides "server or browser" when it loads.
import "./window-shim.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { focusManager, hashKey, QueryClient } from "@tanstack/react-query";
import { openEvents, ProveCancelled } from "../src/api/client.ts";
import type {
	AgentRow,
	AgentsPage,
	Approval,
	AttentionList,
	DecideResponse,
	SendRequest,
	SendResult,
	ServerEvent,
	StopResult,
	Subscription,
	TranscriptEvent,
	TreeNode,
} from "../src/api/types.ts";
import { keys } from "../src/data/keys.ts";
import { LiveSync, type Transport } from "../src/data/live.ts";
import {
	decideConfirmed,
	localId,
	QUEUE_WAIT_MS,
	sendWithRollback,
	stopConfirmed,
} from "../src/data/mutations.ts";
import { observeLive } from "../src/data/observe.ts";
import {
	applyListUpdate,
	applyTranscriptPage,
	type ListData,
	LOCAL_TTL_MS,
	reconcileLocal,
	type TranscriptData,
} from "../src/data/patch.ts";
import { isStopping, localSend } from "../src/data/pending.ts";
import { createPrefetcher } from "../src/data/prefetch.ts";
import { deriveSubscription } from "../src/data/topics.ts";

// ------------------------------------------------------------ fixtures

const row = (id: string, extra: Partial<AgentRow> = {}): AgentRow =>
	({
		id,
		name: id,
		machineId: "m1",
		machine: "studio",
		address: `m1/${id}`,
		state: "idle",
		stateSince: 0,
		needsYou: null,
		wake: "wakes",
		hasTranscript: true,
		canStop: true,
		...extra,
	}) as AgentRow;

const leaf = (id: string, extra: Partial<AgentRow> = {}): TreeNode => ({
	id: `n:${id}`,
	kind: "agent",
	label: id,
	selector: `id=${id}`,
	machineId: "m1",
	machine: "studio",
	project: null,
	link: null,
	rollup: null,
	childCount: 0,
	agent: row(id, extra),
});

const ev = (id: string, ts: number, extra: Partial<TranscriptEvent> = {}) =>
	({
		id,
		ts,
		role: "assistant",
		kind: "text",
		text: id,
		...extra,
	}) as TranscriptEvent;

/** A transport the test drives: emit events, drop and resume the stream. */
function fakeTransport() {
	let handlers: Parameters<Transport>[0] | null = null;
	let opens = 0;
	const transport: Transport = (h) => {
		handlers = h;
		opens++;
		return { close: () => h.onState("closed") };
	};
	return {
		transport,
		get opens() {
			return opens;
		},
		emit: (e: ServerEvent) => handlers?.onEvent(e),
		state: (s: "open" | "retrying" | "closed") => handlers?.onState(s),
	};
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/**
 * Waits for `cond`, however late a loaded machine runs the timers. Use it for
 * "this happens"; a fixed `tick` only for "this does not happen" (timers
 * fire late, never early: load can only make such a window quieter).
 */
async function until(cond: () => boolean, timeoutMs = 10_000, what = "it") {
	const end = performance.now() + timeoutMs;
	while (!cond()) {
		if (performance.now() > end)
			throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
		await tick(5);
	}
}

interface Rig {
	client: QueryClient;
	live: LiveSync;
	t: ReturnType<typeof fakeTransport>;
	subs: Subscription[];
}
const rigs: Rig[] = [];

function rig(): Rig {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 0 } },
	});
	client.mount();
	const t = fakeTransport();
	const subs: Subscription[] = [];
	const live = new LiveSync({
		client,
		transport: t.transport,
		subscribe: async (_id, sub) => {
			subs.push(sub);
		},
		debounceMs: 0,
		frame: (fn) => fn(),
	});
	const r = { client, live, t, subs };
	rigs.push(r);
	return r;
}

/** Opens the stream and waits for the subscription to be acknowledged. */
async function connect(r: Rig) {
	r.live.start();
	r.t.state("open");
	r.t.emit({
		type: "ready",
		data: { streamId: "s1", bootId: "b", resumed: false },
	});
	await tick(5);
}

afterEach(() => {
	for (const r of rigs.splice(0)) {
		r.live.dispose();
		r.client.unmount();
		r.client.clear();
	}
	focusManager.setFocused(undefined);
});

// ------------------------------------------------------------ patches

describe("stream events patch the right keys", () => {
	test("tree: rows patch in place, new agents insert by order, removed go", () => {
		const { client, live } = rig();
		const k = keys.tree("machines", "", "needs");
		const other = keys.tree("projects", "", "needs");
		client.setQueryData<ListData<TreeNode>>(k, {
			items: [leaf("a"), leaf("b")],
			nextCursor: null,
			total: 2,
		});
		client.setQueryData<ListData<TreeNode>>(other, {
			items: [leaf("a")],
			nextCursor: null,
			total: 1,
		});
		live.onEvent({
			type: "tree",
			data: {
				group: "machines",
				filter: "",
				full: false,
				items: [leaf("b", { state: "busy" }), leaf("new")],
				removed: ["n:a"],
				order: ["n:new", "n:b"],
				total: 2,
			},
		});
		const d = client.getQueryData<ListData<TreeNode>>(k)!;
		expect(d.items.map((n) => n.id)).toEqual(["n:new", "n:b"]);
		expect(d.items[1]!.agent!.state).toBe("busy");
		// Another grouping's tree is untouched (only the row would be patched).
		const o = client.getQueryData<ListData<TreeNode>>(other)!;
		expect(o.items.map((n) => n.id)).toEqual(["n:a"]);
	});

	test("an agent's row is patched in every read that shows it", () => {
		const { client, live } = rig();
		const a = row("a");
		client.setQueryData(keys.agent("a"), a);
		client.setQueryData(keys.recent(), { items: [a, row("b")] });
		client.setQueryData<ListData<TreeNode>>(keys.children("m1", "", "needs"), {
			items: [leaf("a")],
			nextCursor: null,
			total: 1,
		});
		const page: AgentsPage = {
			items: [a],
			total: 1,
			nextCursor: null,
			machines: 1,
			totals: { wakes: 1 } as AgentsPage["totals"],
		};
		client.setQueryData(keys.agents("*", "attention", 50), {
			pages: [page],
			pageParams: [null],
		});
		const recentBefore = client.getQueryData<{ items: AgentRow[] }>(
			keys.recent(),
		)!;
		live.onEvent({
			type: "agent",
			data: { id: "a", agent: row("a", { state: "busy" }), full: false },
		});
		expect(client.getQueryData<AgentRow>(keys.agent("a"))!.state).toBe("busy");
		const recent = client.getQueryData<{ items: AgentRow[] }>(keys.recent())!;
		expect(recent.items[0]!.state).toBe("busy");
		// Rows that did not change keep their identity (no needless re-render).
		expect(recent.items[1]).toBe(recentBefore.items[1]!);
		expect(
			client.getQueryData<ListData<TreeNode>>(keys.children("m1", "", "needs"))!
				.items[0]!.agent!.state,
		).toBe("busy");
		expect(
			client.getQueryData<{ pages: AgentsPage[] }>(
				keys.agents("*", "attention", 50),
			)!.pages[0]!.items[0]!.state,
		).toBe("busy");
	});

	test("attention, count, receipts, results and approvals land on their keys", () => {
		const { client, live } = rig();
		const item = {
			id: "x",
			kind: "approval" as const,
			agent: row("a", { state: "needs-you" }),
			title: "Approval",
			createdAt: 1,
		};
		live.onEvent({
			type: "attention",
			data: { items: [item], total: 1, full: true },
		});
		expect(client.getQueryData<AttentionList>(keys.attention())!.items).toEqual(
			[item],
		);
		live.onEvent({
			type: "query",
			data: {
				selector: "project=x",
				total: 3,
				machines: 2,
				totals: {} as never,
				full: true,
			},
		});
		expect(
			client.getQueryData<{ total: number }>(keys.count("project=x"))!.total,
		).toBe(3);
		live.onEvent({
			type: "receipts",
			data: {
				messageId: "m",
				full: true,
				message: { id: "m" } as never,
				totals: { delivered: 1 },
				items: [],
				total: 1,
				replies: [],
				nextCursor: null,
			},
		});
		expect(
			client.getQueryData<{ totals: object }>(keys.receipts("m"))!.totals,
		).toEqual({ delivered: 1 });
		client.setQueryData(keys.agents("*", "attention", 2), {
			pages: [
				{
					items: [row("a")],
					total: 1,
					machines: 1,
					nextCursor: null,
					totals: {},
				},
			],
			pageParams: [null],
		});
		live.onEvent({
			type: "results",
			data: {
				selector: "*",
				sort: "attention",
				offset: 0,
				limit: 2,
				items: [row("z"), row("a")],
				total: 2,
				machines: 1,
				full: false,
			},
		});
		const pages = client.getQueryData<{ pages: AgentsPage[] }>(
			keys.agents("*", "attention", 2),
		)!.pages;
		expect(pages[0]!.items.map((a) => a.id)).toEqual(["z", "a"]);
		const ap = { requestId: "r1", agentId: "a", state: "pending" } as Approval;
		live.onEvent({ type: "approval", data: { approval: ap } });
		live.onEvent({
			type: "approval",
			data: { approval: { ...ap, state: "allowed" } },
		});
		expect(client.getQueryData<Approval>(keys.approval("r1"))!.state).toBe(
			"allowed",
		);
		const log = client.getQueryData<{ approval: Approval }[]>(
			keys.approvals(),
		)!;
		expect(log.map((s) => s.approval.state)).toEqual(["allowed"]);
	});

	test("transcript events merge by id: replace in place, append new", () => {
		const { client, live } = rig();
		const k = keys.transcript("a");
		client.setQueryData<TranscriptData>(k, {
			events: [ev("1", 1), ev("2", 2, { text: "par" })],
			cursor: "c",
			available: true,
		});
		const seen: TranscriptEvent[][] = [];
		live.on("transcript", (v) => seen.push(v.events));
		live.onEvent({
			type: "transcript",
			data: {
				agent: "a",
				events: [ev("2", 2, { text: "partial" }), ev("3", 3)],
			},
		});
		const d = client.getQueryData<TranscriptData>(k)!;
		expect(d.events.map((e) => [e.id, e.text])).toEqual([
			["1", "1"],
			["2", "partial"],
			["3", "3"],
		]);
		expect(d.cursor).toBe("c");
		expect(seen).toHaveLength(1);
	});

	test("a newest page refreshes held blocks, except ones live events touched meanwhile", () => {
		const held: TranscriptData = {
			events: [
				ev("x", 1, { text: "par" }),
				ev("y", 2, { text: "live, newer" }),
			],
			cursor: "c",
			available: true,
		};
		const page = {
			events: [
				ev("x", 1, { text: "partial done" }),
				ev("y", 2, { text: "page, older" }),
			],
			cursor: "c2",
			available: true,
		};
		const next = applyTranscriptPage(held, page, false, new Set(["y"]));
		expect(next.events.map((e) => e.text)).toEqual([
			"partial done",
			"live, newer",
		]);
		// An older page never overwrites.
		const older = applyTranscriptPage(held, page, true, new Set());
		expect(older.events.map((e) => e.text)).toEqual(["par", "live, newer"]);
	});

	test("a page that says unavailable never hides a transcript we hold", () => {
		const held: TranscriptData = {
			events: [ev("x", 1)],
			cursor: null,
			available: true,
		};
		// An older home node answers `false` when its file lookup misses.
		const flap = { events: [], cursor: null, available: false };
		expect(applyTranscriptPage(held, flap, false, new Set()).available).toBe(
			true,
		);
		// Nothing held: the page decides (a harness without a transcript).
		expect(applyTranscriptPage(undefined, flap, false).available).toBe(false);
	});

	test("a full snapshot keeps the order the user sees", () => {
		const held: ListData<TreeNode> = {
			items: [leaf("a"), leaf("b"), leaf("c")],
			nextCursor: null,
			total: 3,
		};
		const next = applyListUpdate(held, {
			full: true,
			items: [leaf("c"), leaf("a"), leaf("d")],
			total: 3,
		});
		// Held rows keep their places; the new one goes after its server neighbour.
		expect(next.items.map((n) => n.id)).toEqual(["n:a", "n:d", "n:c"]);
	});
});

// ------------------------------------------------------------ subscription

describe("the subscription follows mounted queries", () => {
	test("slots: newest wins; disabled queries ask for nothing", async () => {
		const r = rig();
		await connect(r);
		const fn = async () => ({ items: [], nextCursor: null, total: 0 });
		const stops = [
			observeLive(r.client, r.live, {
				queryKey: keys.tree("machines", "x", "needs"),
				queryFn: fn,
				poll: false,
			}),
			observeLive(r.client, r.live, {
				queryKey: keys.children("node1", "x", "needs"),
				queryFn: fn,
				poll: false,
			}),
			observeLive(r.client, r.live, {
				queryKey: keys.agent("a1"),
				queryFn: async () => row("a1"),
				poll: false,
			}),
		];
		await tick(5);
		const last = r.subs.at(-1)!;
		expect(last.window).toEqual({ group: "machines", filter: "x" });
		expect(last.expanded).toEqual(["node1"]);
		expect(last.session).toBe("a1");
		for (const s of stops) s.stop();
		await tick(5);
		expect(r.subs.at(-1)).toEqual({
			expanded: [],
			window: null,
			session: null,
			query: null,
			results: null,
			receipts: [],
		});
	});

	test("derivation covers only the queries that got a slot", () => {
		const { sub, covered } = deriveSubscription([
			{ key: keys.count("a"), seq: 1 },
			{ key: keys.count("b"), seq: 2 },
			{ key: keys.hello(), seq: 3 },
			{ key: keys.attention(), seq: 4 },
		]);
		expect(sub.query).toBe("b");
		expect(covered.has(hashKey(keys.count("b")))).toBe(true);
		expect(covered.has(hashKey(keys.count("a")))).toBe(false);
		expect(covered.has(hashKey(keys.hello()))).toBe(false);
		expect(covered.has(hashKey(keys.attention()))).toBe(true);
	});
});

// ------------------------------------------------------------ fallbacks

describe("fallbacks", () => {
	test("gap → active queries refetch", async () => {
		const r = rig();
		await connect(r);
		let fetches = 0;
		const o = observeLive(r.client, r.live, {
			queryKey: keys.recent(),
			queryFn: async () => {
				fetches++;
				return { items: [] };
			},
			poll: false,
		});
		await tick(5);
		expect(fetches).toBe(1);
		r.t.emit({ type: "gap", data: { reason: "expired" } });
		await tick(5);
		expect(fetches).toBe(2);
		o.stop();
	});

	test("a transcript gap re-pages only that transcript", async () => {
		const r = rig();
		await connect(r);
		const counts = { a: 0, b: 0 };
		const mk = (id: "a" | "b") =>
			observeLive(r.client, r.live, {
				queryKey: keys.transcript(id),
				queryFn: async () => {
					counts[id]++;
					return { events: [], cursor: null, available: true };
				},
				poll: false,
			});
		const oa = mk("a");
		const ob = mk("b");
		await tick(5);
		r.t.emit({
			type: "gap",
			data: { reason: "overflow", topic: "transcript", agent: "a" },
		});
		await tick(5);
		expect(counts).toEqual({ a: 2, b: 1 });
		oa.stop();
		ob.stop();
	});

	test("disconnect → polling starts without waiting for a fetch; reconnect stops it", async () => {
		const r = rig();
		await connect(r);
		let fetches = 0;
		const o = observeLive(r.client, r.live, {
			queryKey: keys.attention(),
			queryFn: async () => {
				fetches++;
				return { items: [], total: 0 };
			},
			poll: 30,
		});
		await tick(10);
		// Covered by the stream: no polling.
		expect(o.interval()).toBe(false);
		const before = fetches;
		await tick(100);
		expect(fetches).toBe(before);
		r.t.state("retrying");
		// Polling is on at once, before any fetch...
		expect(o.interval()).toBe(30);
		// ...and it polls: two fetches with no stream event to cause them.
		await until(() => fetches >= before + 2, 10_000, "two polls");
		// Back: covered again once the new stream's subscription is acknowledged.
		r.t.state("open");
		r.t.emit({
			type: "ready",
			data: { streamId: "s2", bootId: "b", resumed: true },
		});
		await tick(5);
		expect(o.interval()).toBe(false);
		o.stop();
	}, 30_000);

	test("hidden → polling pauses; focus refetches", async () => {
		const r = rig();
		let fetches = 0;
		const o = observeLive(r.client, r.live, {
			queryKey: keys.hello(),
			queryFn: async () => {
				fetches++;
				return {} as never;
			},
			poll: 20,
		});
		// Visible: it polls (the first fetch, then at least one poll).
		await until(() => fetches >= 2, 10_000, "a poll");
		focusManager.setFocused(false);
		// A fetch counts when it starts, and none starts once hidden: the
		// count stops here. Five poll intervals later it has not moved.
		const paused = fetches;
		await tick(100);
		expect(fetches).toBe(paused);
		expect(o.interval()).toBe(20);
		focusManager.setFocused(true);
		// Focus itself refetches, with no timer: not just the poll resuming.
		await Promise.resolve();
		expect(fetches).toBeGreaterThan(paused);
		o.stop();
	}, 30_000);
});

// ------------------------------------------------------------ optimistic

describe("optimistic writes", () => {
	const seed = (client: QueryClient, extra: Partial<TranscriptData> = {}) =>
		client.setQueryData<TranscriptData>(keys.transcript("a"), {
			events: [ev("1", 1)],
			cursor: null,
			available: true,
			...extra,
		});
	const events = (client: QueryClient) =>
		client.getQueryData<TranscriptData>(keys.transcript("a"))!.events;
	const ok = (messageId = "m1"): SendResult => ({
		messageId,
		total: 1,
		machines: 1,
		breakdown: [],
		counts: {},
	});
	const echo = (
		live: LiveSync,
		id: string,
		messageId?: string,
		text = "hello",
	) =>
		live.onEvent({
			type: "transcript",
			data: {
				agent: "a",
				events: [
					ev(id, Date.now(), {
						role: "user",
						text,
						...(messageId ? { pulsar: { sender: "operator", messageId } } : {}),
					}),
				],
			},
		});
	const req = (clientId: string): SendRequest => ({
		ids: ["a"],
		body: "hello",
		clientId,
	});

	test("send: the line shows at once as sending, then sent with the message id", async () => {
		const { client } = rig();
		seed(client);
		let during = null as string | null;
		let shown = 0;
		await sendWithRollback(
			client,
			{ req: req("c_test0001"), agentId: "a" },
			async (r) => {
				shown = events(client).length;
				during = localSend(localId("c_test0001"))?.state ?? null;
				expect(r.clientId).toBe("c_test0001");
				return ok();
			},
		);
		expect(shown).toBe(2);
		expect(during).toBe("sending");
		expect(localSend(localId("c_test0001"))?.state).toBe("sent");
		expect(events(client)[1]!.pulsar?.messageId).toBe("m1");
	});

	test("send: every real send gets a client id; a dry run none", async () => {
		const { client } = rig();
		const seen: SendRequest[] = [];
		const f = async (r: SendRequest) => {
			seen.push(r);
			return ok();
		};
		await sendWithRollback(client, { req: { to: "*", body: "x" } }, f);
		await sendWithRollback(
			client,
			{ req: { to: "*", body: "x", dryRun: true } },
			f,
		);
		expect(seen[0]!.clientId).toMatch(/^c_[a-z0-9]{8,}$/);
		expect(seen[1]!.clientId).toBeUndefined();
	});

	test("send: echo after the response replaces the line by message id (no duplicate)", async () => {
		const { client, live } = rig();
		seed(client);
		await sendWithRollback(
			client,
			{ req: req("c_test0002"), agentId: "a" },
			async () => ok("m2"),
		);
		// An older identical text with another message id must not match.
		echo(live, "other", "m-other");
		expect(events(client).map((e) => e.id)).toEqual([
			"1",
			localId("c_test0002"),
			"other",
		]);
		echo(live, "real", "m2");
		expect(events(client).map((e) => e.id)).toEqual(["1", "other", "real"]);
	});

	test("send: echo before the response (slow network) leaves one line", async () => {
		const { client, live } = rig();
		seed(client);
		await sendWithRollback(
			client,
			{ req: req("c_test0003"), agentId: "a" },
			async () => {
				echo(live, "real", "m3");
				return ok("m3");
			},
		);
		expect(events(client).map((e) => e.id)).toEqual(["1", "real"]);
	});

	test("send: a failure keeps the line as failed; Retry resends with the same client id", async () => {
		const { client, live } = rig();
		seed(client);
		const ids: (string | undefined)[] = [];
		let fail = true;
		const f = async (r: SendRequest) => {
			ids.push(r.clientId);
			if (fail) throw new Error("offline");
			return ok("m4");
		};
		await expect(
			sendWithRollback(client, { req: req("c_test0004"), agentId: "a" }, f),
		).rejects.toThrow("offline");
		const id = localId("c_test0004");
		expect(localSend(id)).toMatchObject({ state: "failed", error: "offline" });
		expect(events(client).map((e) => e.id)).toEqual(["1", id]);
		// A failed line is never taken for a real one (it wasn't sent).
		echo(live, "unrelated", undefined);
		expect(events(client).map((e) => e.id)).toContain(id);
		fail = false;
		localSend(id)!.retry();
		await Bun.sleep(0);
		await Bun.sleep(0);
		expect(ids).toEqual(["c_test0004", "c_test0004"]);
		expect(localSend(id)?.state).toBe("sent");
		// The line seen while failed may have been the first attempt's echo
		// (a lost response): either way one "hello" shows, never two.
		expect(events(client).filter((e) => e.text === "hello")).toHaveLength(1);
	});

	test("send: discard removes a failed line", async () => {
		const { client } = rig();
		seed(client);
		await expect(
			sendWithRollback(
				client,
				{ req: req("c_test0005"), agentId: "a" },
				async () => {
					throw new Error("x");
				},
			),
		).rejects.toThrow();
		localSend(localId("c_test0005"))!.discard();
		expect(events(client).map((e) => e.id)).toEqual(["1"]);
		expect(localSend(localId("c_test0005"))).toBeNull();
	});

	test("send: a cancelled Prove Human or a 409 reconfirm removes the line", async () => {
		const { client } = rig();
		seed(client);
		await expect(
			sendWithRollback(
				client,
				{ req: req("c_test0006"), agentId: "a" },
				async () => {
					throw new ProveCancelled();
				},
			),
		).rejects.toThrow();
		await sendWithRollback(
			client,
			{ req: req("c_test0007"), agentId: "a" },
			async () => ({ ...ok(), reconfirm: "drift", drift: true }),
		);
		expect(events(client).map((e) => e.id)).toEqual(["1"]);
		expect(localSend(localId("c_test0006"))).toBeNull();
	});

	test("send: no line via a parent, or when the harness shares no transcript", async () => {
		const { client } = rig();
		seed(client, { available: false });
		await sendWithRollback(
			client,
			{ req: req("c_test0008"), agentId: "a" },
			async () => ok(),
		);
		seed(client);
		await sendWithRollback(
			client,
			{ req: { ...req("c_test0009"), viaParent: true }, agentId: "a" },
			async () => ok(),
		);
		expect(events(client).map((e) => e.id)).toEqual(["1"]);
	});

	test("send: sends to one agent go out in order", async () => {
		const { client } = rig();
		seed(client);
		const order: string[] = [];
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const first = sendWithRollback(
			client,
			{ req: { ...req("c_test0010"), body: "one" }, agentId: "a" },
			async () => {
				await gate;
				order.push("one");
				return ok("m10");
			},
		);
		const second = sendWithRollback(
			client,
			{ req: { ...req("c_test0011"), body: "two" }, agentId: "a" },
			async () => {
				order.push("two");
				return ok("m11");
			},
		);
		// Both show at once, in the order typed.
		expect(events(client).map((e) => e.text)).toEqual(["1", "one", "two"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["one", "two"]);
	});

	test("reconcile: a line in flight never expires; an accepted one does after the TTL", () => {
		const local = ev(localId("c_old"), 0, { role: "user", text: "hi" });
		const later = LOCAL_TTL_MS + 1;
		expect(reconcileLocal([local], later, () => "sending")).toHaveLength(1);
		expect(reconcileLocal([local], later, () => "failed")).toHaveLength(1);
		expect(reconcileLocal([local], later, () => "sent")).toHaveLength(0);
		expect(reconcileLocal([local], later, () => null)).toHaveLength(0);
	});

	test("stop: not optimistic; Stopping… until the daemon answers, then idle at once", async () => {
		const { client } = rig();
		const busy = row("a", { state: "busy" });
		client.setQueryData(keys.agent("a"), busy);
		client.setQueryData(keys.recent(), { items: [busy] });
		let during = { stopping: false } as { state?: string; stopping: boolean };
		await stopConfirmed(client, busy, async () => {
			during = {
				state: client.getQueryData<AgentRow>(keys.agent("a"))!.state,
				stopping: isStopping("a"),
			};
			return { agentId: "a", result: "interrupted", via: "test" } as StopResult;
		});
		expect(during).toEqual({ state: "busy", stopping: true });
		expect(isStopping("a")).toBe(false);
		expect(client.getQueryData<AgentRow>(keys.agent("a"))!.state).toBe("idle");
		expect(
			client.getQueryData<{ items: AgentRow[] }>(keys.recent())!.items[0]!
				.state,
		).toBe("idle");
	});

	test("stop: a failed or refused Stop leaves the row as it was", async () => {
		const { client } = rig();
		const busy = row("a", { state: "busy" });
		client.setQueryData(keys.agent("a"), busy);
		await expect(
			stopConfirmed(client, busy, async () => {
				throw new Error("Face ID cancelled");
			}),
		).rejects.toThrow();
		await stopConfirmed(
			client,
			busy,
			async () =>
				({ agentId: "a", result: "not-running", via: "test" }) as StopResult,
		);
		expect(client.getQueryData<AgentRow>(keys.agent("a"))!.state).toBe("busy");
		expect(isStopping("a")).toBe(false);
	});

	const attentionItem = {
		id: "x",
		kind: "approval" as const,
		agent: row("a"),
		title: "Approval",
		createdAt: 1,
		approval: { requestId: "r1" } as Approval,
	};

	test("decide: not optimistic; needs-you stays until the stream says it ended", async () => {
		const { client } = rig();
		client.setQueryData<AttentionList>(keys.attention(), {
			items: [attentionItem],
			total: 1,
		});
		let during = -1;
		const r = await decideConfirmed(
			client,
			{ requestId: "r1", decision: "allow-once" },
			async (_id, _d, opts) => {
				opts?.onStep?.("send");
				during = client.getQueryData<AttentionList>(keys.attention())!.items
					.length;
				return {
					won: true,
					approval: { requestId: "r1", outcome: "Allowed once" },
				} as DecideResponse;
			},
		);
		expect(during).toBe(1);
		expect(r.approval.outcome).toBe("Allowed once");
		expect(client.getQueryData<Approval>(keys.approval("r1"))?.outcome).toBe(
			"Allowed once",
		);
		// The card shows its outcome from the stream; the list is not cut early.
		expect(
			client.getQueryData<AttentionList>(keys.attention())!.items,
		).toHaveLength(1);
	});

	test("decide: a refused answer throws and changes nothing", async () => {
		const { client } = rig();
		client.setQueryData<AttentionList>(keys.attention(), {
			items: [attentionItem],
			total: 1,
		});
		await expect(
			decideConfirmed(
				client,
				{ requestId: "r1", decision: "allow-once" },
				async () => {
					throw new Error("refused");
				},
			),
		).rejects.toThrow("refused");
		expect(
			client.getQueryData<AttentionList>(keys.attention())!.items,
		).toHaveLength(1);
	});

	test("send: the same text sent again is not taken for the earlier echo", async () => {
		const { client, live } = rig();
		seed(client);
		await sendWithRollback(
			client,
			{ req: { ...req("c_test0020"), body: "ok" }, agentId: "a" },
			async () => ok("m20"),
		);
		echo(live, "real20", "m20", "ok");
		expect(events(client).map((e) => e.id)).toEqual(["1", "real20"]);
		// Again "ok", in flight; a live event lands before its response.
		let during: string[] = [];
		await sendWithRollback(
			client,
			{ req: { ...req("c_test0021"), body: "ok" }, agentId: "a" },
			async () => {
				live.onEvent({
					type: "transcript",
					data: { agent: "a", events: [ev("x", Date.now())] },
				});
				during = events(client).map((e) => e.id);
				return ok("m21");
			},
		);
		expect(during).toEqual(["1", "real20", localId("c_test0021"), "x"]);
		echo(live, "real21", "m21", "ok");
		expect(events(client).map((e) => e.id)).toEqual([
			"1",
			"real20",
			"x",
			"real21",
		]);
	});

	test("send: a hung send holds later ones to the same agent for at most QUEUE_WAIT_MS", () => {
		expect(QUEUE_WAIT_MS).toBeLessThanOrEqual(15_000);
	});
});

describe("prefetch", () => {
	test("loads the row and transcript once, caps in-flight fetches, adds no observer", async () => {
		const { client } = rig();
		const calls: string[] = [];
		const realFetch = globalThis.fetch;
		const gates: (() => void)[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const u = String(input);
			calls.push(u.replace(/^.*\/api\/v1/, ""));
			await new Promise<void>((r) => gates.push(r));
			const body = u.includes("/transcript")
				? { events: [ev("e1", 1)], cursor: null, available: true }
				: row(u.split("/agents/")[1]!.split("?")[0]!.split("/")[0]!);
			return new Response(JSON.stringify(body), {
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;
		try {
			const prefetch = createPrefetcher(client, async () => {});
			expect(prefetch("a", 0)).toBe(true);
			expect(prefetch("a", 1)).toBe(false); // fresh
			expect(prefetch("b", 2)).toBe(true);
			expect(prefetch("c", 3)).toBe(false); // two in flight
			await Bun.sleep(5);
			for (const g of gates.splice(0)) g();
			await Bun.sleep(5);
			for (const g of gates.splice(0)) g();
			await Bun.sleep(5);
			expect(calls.filter((c) => c.startsWith("/agents/a"))).toHaveLength(2);
			expect(
				client.getQueryData<TranscriptData>(keys.transcript("a"))?.events[0]
					?.id,
			).toBe("e1");
			expect(client.getQueryData<AgentRow>(keys.agent("a"))?.id).toBe("a");
			expect(
				client
					.getQueryCache()
					.find({ queryKey: keys.transcript("a") })
					?.getObserversCount(),
			).toBe(0);
			expect(prefetch("c", 4)).toBe(true);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});

// ------------------------------------------------------------ transport

describe("event transport (fetch stream)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	test("parses frames, then resumes with Last-Event-ID after a drop", async () => {
		const calls: (string | null)[] = [];
		let n = 0;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			const h = init.headers as Record<string, string>;
			calls.push(h["Last-Event-ID"] ?? null);
			const first = n++ === 0;
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					const enc = new TextEncoder();
					if (first) {
						c.enqueue(
							enc.encode(
								'id: b.s1.1\nevent: ready\ndata: {"streamId":"s1","bootId":"b","resumed":false}\n\n',
							),
						);
						c.enqueue(enc.encode('id: b.s1.2\nevent: gap\ndata: {"reason":'));
						c.enqueue(enc.encode('"expired"}\n\n'));
						c.close();
					}
				},
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		const got: ServerEvent[] = [];
		const states: string[] = [];
		const conn = openEvents({
			onEvent: (e) => got.push(e),
			onState: (s) => states.push(s),
		});
		// The retry comes about a second after the drop, however loaded.
		await until(() => calls.length >= 2, 10_000, "the reconnect");
		conn.close();
		expect(got.map((e) => e.type)).toEqual(["ready", "gap"]);
		expect(states.slice(0, 2)).toEqual(["open", "retrying"]);
		expect(calls[0]).toBeNull();
		expect(calls[1]).toBe("b.s1.2");
	}, 30_000);

	test("a silent (half-open) stream is reopened", async () => {
		let calls = 0;
		globalThis.fetch = (async (_url: string, init: RequestInit) => {
			calls++;
			// Opens, says one keepalive, then nothing: never closes.
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode(": keepalive\n\n"));
					init.signal?.addEventListener("abort", () =>
						c.error(new DOMException("aborted", "AbortError")),
					);
				},
			});
			return new Response(body, { status: 200 });
		}) as typeof fetch;
		const states: string[] = [];
		const conn = openEvents(
			{ onEvent: () => {}, onState: (s) => states.push(s) },
			50,
		);
		await until(() => calls >= 2, 10_000, "the reconnect");
		conn.close();
		expect(states.slice(0, 2)).toEqual(["open", "retrying"]);
	}, 30_000);
});

describe("failure kinds", () => {
	test("only not_owner (or a code-less 403) is the wrong-account screen", async () => {
		const { failureKind, retryAfterMs } = await import("../src/api/client.ts");
		const body = (code?: string) =>
			code ? { error: { code, message: "" } } : null;
		expect(failureKind(403, body("not_owner"))).toBe("forbidden");
		expect(failureKind(403, null)).toBe("forbidden");
		expect(failureKind(403, body("bad_origin"))).toBe("http");
		expect(failureKind(503, body("identity_unavailable"))).toBe("http");
		expect(failureKind(503, null)).toBe("daemon-down");
		const h = (v: string | null) => ({
			headers: new Headers(v ? { "Retry-After": v } : {}),
		});
		expect(retryAfterMs(h("2"), 500)).toBe(2000);
		expect(retryAfterMs(h(null), 500)).toBe(500);
		expect(retryAfterMs(h("999"), 500)).toBe(15_000);
	});
});
