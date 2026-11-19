/**
 * Regression tests for the 2.0 security review (http/service/web share):
 * message reads scoped to the caller, no takeover of a live agent, rate
 * limits that new identities don't reset.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	type Caller,
	type Principal,
	PulsarService,
} from "../src/service/index.ts";
import { LIMITS } from "../src/service/limits.ts";
import { Store } from "../src/store.ts";
import type { Message, Registration } from "../src/types.ts";
import { registration } from "./helpers.ts";

let store: Store;
let service: PulsarService;

function caller(principal: Principal = { kind: "terminal" }) {
	const controller = new AbortController();
	const events: Array<{ event: string; data: unknown }> = [];
	const c: Caller = {
		principal,
		closed: controller.signal,
		emit: (event, data) => events.push({ event, data }),
	};
	service.attach(c);
	return { c, events, close: () => controller.abort() };
}

function agent(reg: Partial<Registration> & { name: string }) {
	const conn = caller();
	service.setRole(conn.c, reg.role ?? "mcp");
	const a = service.registerAgent(conn.c, registration(reg));
	return { ...conn, agent: a };
}

const send = (c: Caller, to: string, body: string) =>
	service.handle(c, "send", { to, body }) as Promise<{ message: Message }>;

beforeEach(() => {
	store = new Store(":memory:");
	service = new PulsarService({ store, scan: false, machine: "t" });
});
afterEach(() => {
	service.stop();
	store.close();
});

describe("message reads are scoped to the caller", () => {
	test("tail: an agent sees its own messages only; the operator sees all", async () => {
		const a = agent({ name: "alice" });
		const b = agent({ name: "bob" });
		agent({ name: "carol" });
		const op = caller();
		await service.handle(a.c, "tail", {});
		await service.handle(op.c, "tail", {});
		await send(b.c, "carol", "secret between bob and carol");
		await send(b.c, "alice", "hi alice");
		// Tail frames carry {message, recipients}; deliveries are plain messages.
		const msgs = (evs: typeof a.events) =>
			evs
				.map((e) => e.data as { message?: Message; recipients?: string[] })
				.filter((d) => d?.recipients && d.message)
				.map((d) => d.message!.body);
		expect(msgs(a.events)).toEqual(["hi alice"]);
		expect(msgs(op.events)).toEqual([
			"secret between bob and carol",
			"hi alice",
		]);
	});

	test("history: another agents' thread reads as missing", async () => {
		const a = agent({ name: "alice" });
		const b = agent({ name: "bob" });
		agent({ name: "carol" });
		const theirs = await send(b.c, "carol", "secret");
		const mine = await send(b.c, "alice", "for alice");
		for (const p of [
			{ messageId: theirs.message.id },
			{ threadId: theirs.message.threadId },
		])
			await expect(service.handle(a.c, "history", p)).rejects.toMatchObject({
				code: "not_found",
			});
		const ok = (await service.handle(a.c, "history", {
			messageId: mine.message.id,
		})) as { messages: Message[] };
		expect(ok.messages.map((m) => m.body)).toEqual(["for alice"]);
		// The sender reads its own thread; the operator reads any.
		await service.handle(b.c, "history", { messageId: theirs.message.id });
		await service.handle(caller().c, "history", {
			messageId: theirs.message.id,
		});
	});
});

describe("a live agent can't be taken over", () => {
	test("a hello naming a live session from another process is refused", () => {
		const victim = agent({ name: "victim", sessionId: "s-v", pid: 4242 });
		const other = caller();
		service.setRole(other.c, "mcp");
		expect(() =>
			service.registerAgent(
				other.c,
				registration({ name: "x", sessionId: "s-v", pid: 9999 }),
			),
		).toThrow(/live in another process/);
		expect(victim.agent.pid).toBe(4242);
	});

	test("the same process reconnecting its extension replaces the old connection", () => {
		// A client that opens a new connection per retry (pulsar 1.x extensions)
		// must not be refused: refusal made it retry forever and flood the daemon.
		const first = agent({
			name: "pi1",
			sessionId: null,
			pid: 5151,
			role: "extension",
		});
		const again = caller();
		service.setRole(again.c, "extension");
		const a = service.registerAgent(
			again.c,
			registration({
				name: "pi1",
				sessionId: null,
				pid: 5151,
				role: "extension",
			}),
		);
		expect(a.id).toBe(first.agent.id);
		const sessions = (
			service as unknown as {
				sessions: {
					extensionFor(id: string): unknown;
					role(c: unknown): string | null;
				};
			}
		).sessions;
		expect(sessions.extensionFor(a.id)).toBe(again.c);
		expect(sessions.role(first.c)).toBe("mcp");
	});

	test("a registration never replaces a live agent's push socket", () => {
		const v = agent({
			name: "claude",
			harness: "claude",
			sessionId: "s-c",
			pid: 6161,
			meta: { socket: "/real/claude.sock" },
		});
		const other = caller();
		service.setRole(other.c, "cli");
		service.registerAgent(
			other.c,
			registration({
				harness: "claude",
				sessionId: "s-c",
				pid: 6161,
				role: "cli",
				meta: { socket: "/tmp/attacker.sock" },
			}),
		);
		expect(service.registry.get(v.agent.id)!.meta.socket).toBe(
			"/real/claude.sock",
		);
	});
});

describe("rate limits", () => {
	test("new session ids from one process share its budget", async () => {
		agent({ name: "target" });
		let refused = 0;
		for (let i = 0; i < LIMITS.sendsPerMinute + 5; i++) {
			const fresh = agent({ name: `spam${i}`, pid: 7777, sessionId: `s${i}` });
			try {
				await send(fresh.c, "target", `n${i}`);
			} catch (e) {
				expect((e as { code?: string }).code).toBe("rate_limited");
				refused++;
			}
		}
		expect(refused).toBe(5);
	});
});

describe("passkey sessions", () => {
	test("12 h on a pulsar node, 7 days on a phone; expired and foreign tokens fail", async () => {
		const { MemoryPasskeyStore, Passkeys } = await import(
			"../src/service/passkeys.ts"
		);
		const { UserSessions, DEVICE_SESSION_MS, PULSAR_NODE_SESSION_MS } =
			await import("../src/service/user-sessions.ts");
		const { SoftAuthenticator } = await import("./webauthn.ts");
		const origin = "http://localhost:4100";
		const rp = { rpId: "localhost", origins: [origin] };
		const login = "me@example.com";
		let now = Date.now();
		const passkeys = new Passkeys(new MemoryPasskeyStore(), () => now);
		const key = new SoftAuthenticator({ origin, rpId: "localhost" });
		const reg = await passkeys.registrationOptions(login, rp, {
			label: "iPhone",
		});
		await passkeys.verifyRegistration(login, rp, key.register(reg as never));
		const sessions = new UserSessions({ store, passkeys, now: () => now });
		const start = async (pulsarNode: boolean) => {
			const o = await sessions.options(login, rp, "iPhone", "n-iphone");
			return sessions.verify(
				login,
				rp,
				{ requestId: o.requestId, assertion: key.assert(o.options as never) },
				{ node: "iphone", nodeId: "n-iphone", pulsarNode },
			);
		};
		const phone = await start(false);
		expect(phone.session.expiresAt - phone.session.createdAt).toBe(
			DEVICE_SESSION_MS,
		);
		const mac = await start(true);
		expect(mac.session.expiresAt - mac.session.createdAt).toBe(
			PULSAR_NODE_SESSION_MS,
		);
		expect(sessions.check(phone.token, login, "n-iphone")?.id).toBe(
			phone.session.id,
		);
		expect(
			sessions.check(phone.token, "someone@else.com", "n-iphone"),
		).toBeNull();
		// L4: the token works only from the node that started it.
		expect(sessions.check(phone.token, login, "n-laptop")).toBeNull();
		// ...and a sign-in asked from one node can't be finished from another.
		const o = await sessions.options(login, rp, "iPhone", "n-iphone");
		await expect(
			sessions.verify(
				login,
				rp,
				{ requestId: o.requestId, assertion: key.assert(o.options as never) },
				{ node: "laptop", nodeId: "n-laptop", pulsarNode: false },
			),
		).rejects.toMatchObject({ code: "bad_assertion" });
		// Tokens are stored only as hashes.
		expect(JSON.stringify(store.metaByPrefix("session:"))).not.toContain(
			phone.token,
		);
		now += PULSAR_NODE_SESSION_MS + 1;
		expect(sessions.check(mac.token, login, "n-iphone")).toBeNull();
		expect(sessions.check(phone.token, login, "n-iphone")).not.toBeNull();
		now += DEVICE_SESSION_MS;
		expect(sessions.check(phone.token, login, "n-iphone")).toBeNull();
	});
});

describe("passkeys.any (asked on every relay poll)", () => {
	test("reads the store once per TTL; this class's add and remove refresh it at once", async () => {
		const { MemoryPasskeyStore, Passkeys } = await import(
			"../src/service/passkeys.ts"
		);
		const { SoftAuthenticator } = await import("./webauthn.ts");
		const origin = "http://localhost:4100";
		const rp = { rpId: "localhost", origins: [origin] };
		const login = "me@example.com";
		const store = new MemoryPasskeyStore();
		let reads = 0;
		const all = store.all.bind(store);
		store.all = () => {
			reads++;
			return all();
		};
		let now = Date.now();
		const passkeys = new Passkeys(store, () => now);
		for (let i = 0; i < 50; i++) expect(passkeys.any()).toBe(false);
		expect(reads).toBe(1);
		const key = new SoftAuthenticator({ origin, rpId: "localhost" });
		const reg = await passkeys.registrationOptions(login, rp, {
			label: "iPhone",
		});
		const info = await passkeys.verifyRegistration(
			login,
			rp,
			key.register(reg as never),
		);
		expect(passkeys.any()).toBe(true);
		passkeys.remove(info.id);
		expect(passkeys.any()).toBe(false);
		// A change made around this class shows within the TTL.
		store.add({ id: "x", login, rpId: "localhost" } as never);
		expect(passkeys.any()).toBe(false);
		now += 31_000;
		expect(passkeys.any()).toBe(true);
	});
});
