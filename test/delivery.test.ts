/**
 * Durable, at-least-once delivery (docs/delivery.md). Tests of new behavior
 * are `test.todo` until the implementation lands (`bun test --todo` runs
 * them); guards that already hold (compatibility, no redelivery where none is
 * due) run now.
 * Agents talk to the daemon only through `client.call`, so the tests do not
 * depend on the store's (sync or async) API.
 */
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { join } from "node:path";
import { DaemonClient } from "../src/client.ts";
import { Daemon, type DaemonOptions } from "../src/daemon.ts";
import { DRIVERS } from "../src/harnesses/index.ts";
import type { HarnessDriver, Scanned } from "../src/harnesses/types.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
	Registration,
} from "../src/types.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";
import { registration, roundTrip, startDaemon, until } from "./helpers.ts";

setDefaultTimeout(15_000);

type SendResult = { message: Message; receipts: Receipt[] };
/** What a redelivery adds to a message (Phase 2: on `DeliveredMessage`). */
type Attempted = DeliveredMessage & { attempt?: number; maxAttempts?: number };
/** A receipt with Phase 2's fields; states are plain strings until types.ts grows. */
type Tracked = Omit<Receipt, "state"> & {
	state: string;
	attempt?: number;
	result?: string | null;
};
type WaitResult = {
	event: string;
	message?: DeliveredMessage;
	receipt?: Tracked;
};

/** Short timers so redelivery happens within a test. */
const FAST = {
	tickMs: 25,
	ackTimeoutMs: 300,
	leaseMs: 400,
	backoffMs: 50,
	maxAttempts: 3,
	ttlMs: 60_000,
};
const OPTS: DaemonOptions = { delivery: FAST };

let daemon: Daemon;
let home: string;
let cleanup: () => void;
const clients: Array<{ close: () => void }> = [];

beforeEach(async () => {
	({ daemon, home, cleanup } = await startDaemon(OPTS));
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.close();
	await daemon.stop();
	cleanup();
});

let fakePid = 910_000;

/**
 * A pi-extension agent. `pid` is the session generation: the same session id
 * with another pid is the same session after a restart (Claude/Codex resume).
 * `acks` says the client can ack (the new MCP server declares it in hello).
 */
async function session(
	sessionId: string,
	opts: { pid?: number; acks?: boolean; over?: Partial<Registration> } = {},
) {
	const client = new DaemonClient();
	await client.connect(false);
	clients.push(client);
	// Listen before hello: a redelivery is pushed as soon as the session registers.
	const pushes: Array<{ message: Attempted; text: string }> = [];
	client.on("push", (d) =>
		pushes.push(d as { message: Attempted; text: string }),
	);
	const hello = await client.call<{ agent: PublicAgent }>("hello", {
		protocol: PROTOCOL_VERSION,
		registration: registration({
			sessionId,
			pid: opts.pid ?? fakePid++,
			...(opts.acks ? { capabilities: ["acks"] } : {}),
			...opts.over,
		}),
	});
	return {
		client,
		agent: hello.agent,
		pushes,
		call: <T>(method: string, p: Record<string, unknown> = {}) =>
			client.call<T>(method, p),
		/** The session's process ends (its connection closes; the agent goes gone). */
		kill: async () => {
			client.close();
			await until(() => !daemon.live().some((a) => a.id === hello.agent.id));
		},
	};
}

async function receiptOf(
	asker: { call: <T>(m: string, p?: Record<string, unknown>) => Promise<T> },
	messageId: string,
) {
	const h = await asker.call<{
		receipts: Tracked[];
	}>("history", { messageId });
	return h.receipts[0]!;
}

/** A asks B (tracked: expectReply, one recipient) and starts waiting for the reply. */
async function ask(
	a: Awaited<ReturnType<typeof session>>,
	to: string,
	body: string,
	timeoutSeconds = 10,
) {
	const sent = await a.call<SendResult>("send", {
		to,
		body,
		expectReply: true,
		priority: "urgent",
	});
	const waiting = a.call<WaitResult>("wait", {
		for: `reply:${sent.message.id}`,
		timeoutSeconds,
	});
	// A test that fails before awaiting it must not leave an unhandled rejection.
	waiting.catch(() => {});
	await roundTrip(a.client);
	return { id: sent.message.id, sent, waiting };
}

describe("redelivery after a session restart", () => {
	test("B's session dies after delivery, before ack: redelivered when it resumes; A's ask gets the reply", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_501 });
		const q = await ask(a, b.agent.name, "which port?");
		await until(() => b.pushes.length === 1);
		expect(b.pushes[0]!.message.attempt ?? 1).toBe(1);

		await b.kill();
		// The state stays what the session reached; the detail says why it waits.
		const waitingDetail = await receiptOf(a, q.id);
		expect(waitingDetail.state).toBe("sent");
		expect(waitingDetail.detail).toMatch(/come back/);

		// Same session id, new process: Claude/Codex resume.
		const b2 = await session("s-b", { pid: 910_502 });
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		const again = b2.pushes.find((p) => p.message.id === q.id)!;
		expect(again.message.attempt).toBe(2);
		expect(again.text).toMatch(/attempt 2 of 3/);
		expect(again.text).toMatch(/check before you redo it/);

		await b2.call("reply", { messageId: q.id, body: "8443" });
		const answer = await q.waiting;
		expect(answer.event).toBe("reply");
		expect(answer.message!.body).toBe("8443");
		expect((await receiptOf(a, q.id)).state).toBe("replied");
	});

	test("a reconnect of the same process is not a restart: no second push, attempt stays 1", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_601 });
		const q = await ask(a, b.agent.name, "still 1?");
		await until(() => b.pushes.length === 1);
		await b.kill();
		const b2 = await session("s-b", { pid: 910_601 });
		await roundTrip(b2.client);
		await new Promise((r) => setTimeout(r, FAST.backoffMs * 4));
		expect(b2.pushes.filter((p) => p.message.id === q.id)).toHaveLength(0);
		expect((await receiptOf(a, q.id)).attempt ?? 1).toBe(1);
	});

	test("an untracked message (no expectReply) is not redelivered after a restart", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_701 });
		const sent = await a.call<SendResult>("send", {
			to: b.agent.name,
			body: "fyi only",
		});
		await until(() => b.pushes.length === 1);
		await b.kill();
		const b2 = await session("s-b", { pid: 910_702 });
		await roundTrip(b2.client);
		await new Promise((r) => setTimeout(r, FAST.backoffMs * 4));
		expect(b2.pushes.some((p) => p.message.id === sent.message.id)).toBe(false);
	});

	test("a group ask is not tracked: non-answerers are not redelivered or dead-lettered", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { over: { project: "grp" } });
		const c = await session("s-c", { over: { project: "grp" } });
		const sent = await a.call<SendResult>("send", {
			to: "project=grp",
			body: "anyone?",
			expectReply: true,
		});
		await until(() => b.pushes.length === 1 && c.pushes.length === 1);
		await b.call("reply", { messageId: sent.message.id, body: "me" });
		await c.kill();
		await session("s-c", { over: { project: "grp" } });
		await new Promise((r) => setTimeout(r, FAST.ackTimeoutMs * 2));
		const h = await a.call<{ receipts: Tracked[] }>("history", {
			messageId: sent.message.id,
		});
		expect(h.receipts.map((r) => r.state).sort()).not.toContain("dead");
	});

	test("a group ask acked by one recipient gets no lease: no redelivery after another answers", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true, over: { project: "grp2" } });
		const c = await session("s-c", { acks: true, over: { project: "grp2" } });
		const sent = await a.call<SendResult>("send", {
			to: "project=grp2",
			body: "anyone?",
			expectReply: true,
		});
		await until(() => b.pushes.length === 1 && c.pushes.length === 1);
		await b.call("msg.ack", { messageId: sent.message.id });
		await c.call("reply", { messageId: sent.message.id, body: "me" });
		await new Promise((r) => setTimeout(r, FAST.leaseMs * 3));
		expect(
			b.pushes.filter((p) => p.message.id === sent.message.id),
		).toHaveLength(1);
	});
});

describe("sessions without a pid", () => {
	test("re-hellos of the same process are not restarts", async () => {
		const a = await session("s-a");
		const over = { pid: null, meta: { gen: "proc-1" } };
		const b = await session("s-np", { over });
		const q = await ask(a, b.agent.name, "one?");
		await until(() => b.pushes.length === 1);
		for (let i = 0; i < 3; i++) {
			await (i === 0 ? b : await session("s-np", { over })).kill();
		}
		const back = await session("s-np", { over });
		await roundTrip(back.client);
		await new Promise((r) => setTimeout(r, FAST.backoffMs * 4));
		expect(back.pushes.filter((p) => p.message.id === q.id)).toHaveLength(0);
		const r = await receiptOf(a, q.id);
		expect(r.attempt ?? 1).toBe(1);
		expect(r.detail ?? "").not.toMatch(/come back/);
	});

	test("a new client process (another nonce) is a restart", async () => {
		const a = await session("s-a");
		const b = await session("s-np2", {
			over: { pid: null, meta: { gen: "p1" } },
		});
		const q = await ask(a, b.agent.name, "two?");
		await until(() => b.pushes.length === 1);
		await b.kill();
		const b2 = await session("s-np2", {
			over: { pid: null, meta: { gen: "p2" } },
		});
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		expect(b2.pushes[0]!.message.attempt).toBe(2);
	});
});

describe("a scanned session pushed through its harness driver", () => {
	test("idle release picks up a replacement scan row and an edit during handoff", async () => {
		const opened = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const pushed: string[] = [];
		let status: Scanned["status"] = "busy";
		const scan = {
			intervalMs: 60_000,
			sessions: (): Scanned[] => [
				{
					harness: "turn-boundary",
					sessionId: "c1",
					pid: process.pid,
					cwd: null,
					status,
					meta: {},
				},
			],
		};
		const driver: HarnessDriver = {
			id: "turn-boundary",
			label: "Turn boundary fixture",
			matchProcess: () => false,
			scan,
			push: {
				canPush: () => true,
				canSteer: () => true,
				deliver: async (_agent, text) => {
					pushed.push(text);
					if (pushed.length === 1) {
						opened.resolve();
						await finish.promise;
					}
					return { ok: true, via: "fixture" };
				},
			},
		};
		DRIVERS.push(driver);
		try {
			const { registry, router } = daemon.service;
			await registry.runScan(driver.id, scan);
			const target = registry.get(`${driver.id}:c1`)!;
			const a = await session("s-a");
			const send = (body: string) =>
				a.call<SendResult>("send", {
					to: target.name,
					body,
					priority: "normal",
				});
			await send("First staged prompt");
			const second = await send("Original second prompt");
			target.status = "idle";
			const releasing = router.releaseNextTurn(target);
			await opened.promise;
			status = "idle";
			await registry.runScan(driver.id, scan);
			expect(registry.get(target.id)).not.toBe(target);
			daemon.store.setMessageBody(second.message.id, "Edited second prompt");
			finish.resolve();
			await releasing;
			expect(pushed).toHaveLength(2);
			expect(pushed[1]).toContain("Edited second prompt");
			expect(pushed[1]).not.toContain("Original second prompt");
		} finally {
			finish.resolve();
			DRIVERS.splice(DRIVERS.indexOf(driver), 1);
		}
	});

	test("an uncertain native handoff ends delivery without replay", async () => {
		let attempts = 0;
		const scan = {
			intervalMs: 60_000,
			sessions: (): Scanned[] => [
				{
					harness: "uncertain-handoff",
					sessionId: "c1",
					pid: process.pid,
					cwd: null,
					status: "busy",
					meta: {},
				},
			],
		};
		const driver: HarnessDriver = {
			id: "uncertain-handoff",
			label: "Uncertain handoff fixture",
			matchProcess: () => false,
			scan,
			push: {
				canPush: () => true,
				deliver: async () => {
					attempts++;
					return {
						ok: false,
						uncertain: true,
						via: "fixture",
						detail: "Reply lost.",
					};
				},
			},
		};
		DRIVERS.push(driver);
		try {
			const { registry, router } = daemon.service;
			await registry.runScan(driver.id, scan);
			const target = registry.get(`${driver.id}:c1`)!;
			const a = await session("s-a");
			const q = await ask(a, target.name, "uncertain");
			expect(q.sent.receipts).toMatchObject([
				{ state: "nacked", detail: "Delivery unknown: Reply lost." },
			]);
			expect(await q.waiting).toMatchObject({ event: "nacked" });
			await router.flushQueued(target);
			expect(attempts).toBe(1);
		} finally {
			DRIVERS.splice(DRIVERS.indexOf(driver), 1);
		}
	});

	test("the session restarts under the same id: redelivered through the driver", async () => {
		const pushed: string[] = [];
		let found: Scanned[] = [];
		const scan = { intervalMs: 60_000, sessions: () => found };
		const fake: HarnessDriver = {
			id: "fakeh",
			label: "Fake harness",
			matchProcess: () => false,
			scan,
			push: {
				canPush: (agent) => agent.harness === "fakeh",
				deliver: async (_agent, text) => {
					pushed.push(text);
					return { ok: true, via: "fake" };
				},
			},
		};
		DRIVERS.push(fake);
		try {
			const registry = daemon.service.registry;
			const row = (pid: number): Scanned => ({
				harness: "fakeh",
				sessionId: "c1",
				pid,
				cwd: null,
				status: "idle",
				meta: {},
			});
			// Live pids: the registry drops scanned sessions whose process is gone.
			found = [row(process.pid)];
			await registry.runScan("fakeh", scan);
			const target = registry.get("fakeh:c1")!;
			const a = await session("s-a");
			const q = await ask(a, target.name, "scanned?");
			await until(() => pushed.some((t) => t.includes(q.id)));
			// The process ends: the scanner no longer sees it.
			found = [];
			await new Promise((r) => setTimeout(r, 5));
			await registry.runScan("fakeh", scan);
			expect(registry.get("fakeh:c1")?.status).toBe("gone");
			// Resumed: same session id, new process.
			found = [row(process.ppid)];
			await registry.runScan("fakeh", scan);
			await until(() =>
				pushed.some((t) => t.includes(q.id) && t.includes("attempt 2 of 3")),
			);
			expect(pushed.filter((t) => t.includes(q.id))).toHaveLength(2);
		} finally {
			DRIVERS.splice(DRIVERS.indexOf(fake), 1);
		}
	});
});

describe("pi/omp: a resumed session under a new pid", () => {
	test("tracked messages follow the resume key to the new agent", async () => {
		const a = await session("s-a");
		const key = { sessionId: null, resumeKey: "pi:3f2a" };
		const b = await session("", { pid: 911_001, over: key });
		const q = await ask(a, b.agent.name, "still on it?");
		await until(() => b.pushes.length === 1);
		await b.kill();
		const b2 = await session("", { pid: 911_002, over: key });
		expect(b2.agent.id).not.toBe(b.agent.id);
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		expect(b2.pushes[0]!.message.attempt).toBe(2);
		await b2.call("reply", { messageId: q.id, body: "yes" });
		expect((await q.waiting).message!.body).toBe("yes");
	});

	test("the extension can report the key after hello", async () => {
		const a = await session("s-a");
		const b = await session("", { pid: 911_101, over: { sessionId: null } });
		await b.call("resume_key", { key: "omp:9c1" });
		const q = await ask(a, b.agent.name, "x?");
		await until(() => b.pushes.length === 1);
		await b.kill();
		const b2 = await session("", {
			pid: 911_102,
			over: { sessionId: null, resumeKey: "omp:9c1" },
		});
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
	});
});

describe("ack, lease and done", () => {
	test("B acks, then goes quiet past the lease: redelivered with attempt 2", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "migrate the table");
		await until(() => b.pushes.length === 1);
		await b.call("msg.ack", { messageId: q.id });
		expect((await receiptOf(a, q.id)).state).toBe("acked");
		await until(
			() => b.pushes.filter((p) => p.message.id === q.id).length === 2,
			FAST.leaseMs * 4,
		);
		expect(b.pushes[1]!.message.attempt).toBe(2);
	});

	test("acking again renews the lease", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "long job");
		await until(() => b.pushes.length === 1);
		for (let i = 0; i < 4; i++) {
			await b.call("msg.ack", { messageId: q.id });
			await new Promise((r) => setTimeout(r, FAST.leaseMs / 2));
		}
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(1);
	});

	test("a redelivery whose sender has left is framed with the sender's name, never as the terminal", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_811, acks: true });
		const q = await ask(a, b.agent.name, "deploy it");
		await until(() => b.pushes.length === 1);
		await b.call("msg.ack", { messageId: q.id });
		await b.kill();
		await a.kill();
		// The sweep forgets A a minute after it went.
		daemon.service.registry.delete(a.agent.id);
		const b2 = await session("s-b", { pid: 910_812, acks: true });
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		const text = b2.pushes.find((p) => p.message.id === q.id)!.text;
		expect(text).toContain(`[pulsar] ${a.agent.name}`);
		expect(text).not.toContain("the terminal");
	});

	test("B acks then crashes before done: redelivered to the resumed session", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_801, acks: true });
		const q = await ask(a, b.agent.name, "deploy it");
		await until(() => b.pushes.length === 1);
		await b.call("msg.ack", { messageId: q.id });
		await b.kill();
		const b2 = await session("s-b", { pid: 910_802, acks: true });
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		expect(b2.pushes[0]!.message.attempt).toBe(2);
	});

	test("not acked within the ack timeout: redelivered, but only to clients that can ack", async () => {
		const a = await session("s-a");
		const canAck = await session("s-b", { acks: true });
		const legacy = await session("s-c");
		const q1 = await ask(a, canAck.agent.name, "q1");
		const q2 = await ask(a, legacy.agent.name, "q2");
		await until(
			() => canAck.pushes.filter((p) => p.message.id === q1.id).length === 2,
			FAST.ackTimeoutMs * 4,
		);
		expect(legacy.pushes.filter((p) => p.message.id === q2.id)).toHaveLength(1);
	});

	test("the ack timer does not run while the recipient is busy", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		await b.call("set_status", { status: "busy" });
		const q = await ask(a, b.agent.name, "when you can");
		await until(() => b.pushes.length === 1);
		await new Promise((r) => setTimeout(r, FAST.ackTimeoutMs * 2));
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(1);
		await b.call("set_status", { status: "idle" });
		await until(
			() => b.pushes.filter((p) => p.message.id === q.id).length === 2,
			FAST.ackTimeoutMs * 4,
		);
	});

	test("done with a result settles A's ask and is terminal", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "run the suite");
		await until(() => b.pushes.length === 1);
		await b.call("msg.ack", { messageId: q.id });
		await b.call("msg.done", { messageId: q.id, result: "412 passed" });
		const answer = await q.waiting;
		expect(answer.event).toBe("reply");
		expect(answer.message!.body).toContain("412 passed");
		const r = await receiptOf(a, q.id);
		expect(r.state).toBe("done");
		await new Promise((x) => setTimeout(x, FAST.leaseMs * 2));
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(1);
	});

	test("done with a result is recorded even when the result can't be sent (the asker left)", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "run the suite");
		await until(() => b.pushes.length === 1);
		await b.call("msg.ack", { messageId: q.id });
		await a.kill();
		await until(
			() => daemon.service.registry.get(a.agent.id)?.status === "gone",
		);
		await expect(
			b.call("msg.done", { messageId: q.id, result: "412 passed" }),
		).rejects.toMatchObject({ code: "gone" });
		const r = daemon.service.store
			.receiptsFor(q.id)
			.find((x) => x.agentId === b.agent.id);
		expect(r?.state).toBe("done");
		// Done is done: no lease redelivery of finished work.
		await new Promise((x) => setTimeout(x, FAST.leaseMs * 2));
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(1);
	});
});

describe("nack", () => {
	test("nack retry=true: redelivered after backoff with the next attempt", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "later please");
		await until(() => b.pushes.length === 1);
		await b.call("msg.nack", { messageId: q.id, reason: "busy", retry: true });
		await until(
			() => b.pushes.filter((p) => p.message.id === q.id).length === 2,
		);
		expect(b.pushes[1]!.message.attempt).toBe(2);
	});

	test("nack without retry is terminal; A's ask resolves at once with the reason", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "delete prod", 30);
		await until(() => b.pushes.length === 1);
		const started = Date.now();
		await b.call("msg.nack", { messageId: q.id, reason: "not allowed" });
		const answer = await q.waiting;
		expect(Date.now() - started).toBeLessThan(5000);
		expect(answer.event).toBe("nacked");
		expect(answer.receipt!.result ?? answer.receipt!.detail).toContain(
			"not allowed",
		);
		expect((await receiptOf(a, q.id)).state).toBe("nacked");
	});
});

describe("dead letters", () => {
	test("after maxAttempts: dead, A's ask resolves early, A gets a notice", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "never answered", 8);
		const answer = await q.waiting;
		expect(answer.event).toBe("dead");
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(
			FAST.maxAttempts,
		);
		const r = await receiptOf(a, q.id);
		expect(r.state).toBe("dead");
		expect(r.attempt).toBe(FAST.maxAttempts);
		const inbox = await a.call<{ messages: DeliveredMessage[] }>("inbox");
		expect(
			inbox.messages.some(
				(m) => m.from.name === "pulsar" && m.body.includes(q.id),
			),
		).toBe(true);
	});

	test("a recipient that never comes back expires at the ttl", async () => {
		await daemon.stop();
		cleanup();
		({ daemon, home, cleanup } = await startDaemon({
			delivery: { ...FAST, ttlMs: 500 },
		}));
		const a = await session("s-a");
		const b = await session("s-b");
		const q = await ask(a, b.agent.name, "hello?", 8);
		await until(() => b.pushes.length === 1);
		await b.kill();
		const answer = await q.waiting;
		expect(answer.event).toBe("dead");
		expect((await receiptOf(a, q.id)).state).toBe("expired");
	});
});

describe("idempotency", () => {
	test("a late extension ack does not move a replied receipt back", async () => {
		const a = await session("s-a");
		const b = await session("s-b");
		const q = await ask(a, b.agent.name, "x?");
		await until(() => b.pushes.length === 1);
		await b.call("reply", { messageId: q.id, body: "y" });
		await b.call("ack", { messageId: q.id, via: "extension" });
		expect((await receiptOf(a, q.id)).state).toBe("replied");
	});

	test("done twice and an identical reply twice change nothing the second time", async () => {
		const a = await session("s-a");
		const b = await session("s-b", { acks: true });
		const q = await ask(a, b.agent.name, "answer once");
		await until(() => b.pushes.length === 1);
		const first = await b.call<SendResult>("reply", {
			messageId: q.id,
			body: "42",
		});
		const second = await b.call<SendResult>("reply", {
			messageId: q.id,
			body: "42",
		});
		expect(second.message.id).toBe(first.message.id);
		await b.call("msg.done", { messageId: q.id });
		await b.call("msg.done", { messageId: q.id });
		const thread = await a.call<{ messages: Message[] }>("history", {
			messageId: q.id,
		});
		expect(thread.messages.filter((m) => m.replyTo === q.id)).toHaveLength(1);
	});

	test("a different second reply is a normal follow-up", async () => {
		const a = await session("s-a");
		const b = await session("s-b");
		const q = await ask(a, b.agent.name, "status?");
		await until(() => b.pushes.length === 1);
		await b.call("reply", { messageId: q.id, body: "running" });
		await q.waiting;
		await b.call("reply", { messageId: q.id, body: "finished" });
		// The ask settled on the first reply; the follow-up is pushed as usual.
		await until(() => a.pushes.some((p) => p.message.body === "finished"));
	});
});

describe("daemon restart mid-flight", () => {
	test("receipts, attempts and due times survive; a resumed session gets the redelivery", async () => {
		// Same socket and database: a restart of this machine's daemon.
		const reopen = () =>
			new Daemon({
				socket: join(home, "bus.sock"),
				db: join(home, "pulsar.db"),
				scan: false,
				remote: { mode: "off" },
				...OPTS,
			});
		const a = await session("s-a");
		const b = await session("s-b", { pid: 910_901 });
		const q = await ask(a, b.agent.name, "survive the restart", 30);
		await until(() => b.pushes.length === 1);
		for (const c of clients.splice(0)) c.close();
		await daemon.stop();
		daemon = reopen();
		expect(await daemon.start()).toBe(true);

		const a2 = await session("s-a");
		const before = await receiptOf(a2, q.id);
		expect(before.state).toBe("sent");
		expect(before.attempt ?? 1).toBe(1);
		// A's MCP server re-issues its wait after the reconnect.
		const waiting = a2.call<WaitResult>("wait", {
			for: `reply:${q.id}`,
			timeoutSeconds: 10,
		});
		waiting.catch(() => {});
		const b2 = await session("s-b", { pid: 910_902 });
		await until(() => b2.pushes.some((p) => p.message.id === q.id));
		expect(b2.pushes[0]!.message.attempt).toBe(2);
		await b2.call("reply", { messageId: q.id, body: "made it" });
		expect((await waiting).message!.body).toBe("made it");
	});
});

describe("1.x compatibility", () => {
	test("the extension's ack/nack RPCs keep their meaning", async () => {
		const a = await session("s-a");
		const b = await session("s-b");
		const q = await ask(a, b.agent.name, "x");
		await until(() => b.pushes.length === 1);
		await b.call("ack", { messageId: q.id, via: "extension" });
		const r = await receiptOf(a, q.id);
		expect(r.state).toBe("delivered");
		expect(r.attempt ?? 1).toBe(1);
		const plain = await a.call<SendResult>("send", {
			to: b.agent.name,
			body: "back to inbox",
		});
		await b.call("nack", { messageId: plain.message.id, reason: "busy" });
		const inbox = await b.call<{ messages: DeliveredMessage[] }>("inbox");
		expect(inbox.messages.map((m) => m.body)).toContain("back to inbox");
	});

	test("a client without the acks capability is never re-pushed on a timer", async () => {
		const a = await session("s-a");
		const b = await session("s-b");
		const q = await ask(a, b.agent.name, "legacy");
		await until(() => b.pushes.length === 1);
		await new Promise((r) =>
			setTimeout(r, FAST.ackTimeoutMs + FAST.leaseMs + 200),
		);
		expect(b.pushes.filter((p) => p.message.id === q.id)).toHaveLength(1);
	});
});
