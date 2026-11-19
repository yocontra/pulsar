import { afterEach, describe, expect, test } from "bun:test";
import {
	macOutcome,
	nativeProvider,
	polkitOutcome,
	promptText,
	windowsOutcome,
} from "../src/presence/native.ts";
import type { Principal } from "../src/service/caller.ts";
import { OPERATOR_ID } from "../src/service/caller.ts";
import { EnrollGate } from "../src/service/enroll.ts";
import { PulsarService } from "../src/service/index.ts";
import { spendConfirmed } from "../src/service/presence.ts";
import { Store } from "../src/store.ts";
import { FakePresence, fakeCaller } from "./presence-fake.ts";
import { SoftAuthenticator } from "./webauthn.ts";

const ORIGIN = "http://localhost:4100";
const rp = { rpId: "localhost", origins: [ORIGIN] };
const user: Principal = {
	kind: "human",
	login: "me@example.com",
	node: "phone",
	verified: true,
};

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function setup(
	o: {
		native?: FakePresence | null;
		answerable?: boolean;
		timeoutMs?: number;
		terminal?: EnrollGate | null;
	} = {},
) {
	const store = new Store(":memory:");
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null, answerable: () => o.answerable ?? true },
		presence: {
			native: o.native === undefined ? null : o.native,
			terminal: o.terminal ?? null,
			...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
		},
	});
	cleanups.push(() => {
		service.stop();
		store.close();
	});
	const agent = service.registry.upsert({
		harness: "claude",
		sessionId: "sess-1",
		pid: null,
		cwd: "/repo",
		project: "repo",
		branch: "main",
		tags: [],
		meta: {},
		registered: true,
	});
	return { service, store, agent };
}

async function enroll(service: PulsarService, label = "iPhone") {
	const auth = new SoftAuthenticator({ origin: ORIGIN, rpId: "localhost" });
	const options = await service.approvals.passkeys.registrationOptions(
		"me@example.com",
		rp,
		{ label },
	);
	await service.approvals.passkeys.verifyRegistration(
		"me@example.com",
		rp,
		auth.register(options),
	);
	return auth;
}

/** Answers a pending confirm card in the app, signed with `auth`. */
async function answer(
	service: PulsarService,
	auth: SoftAuthenticator,
	id: string,
	confirmed: boolean,
) {
	const a = { kind: "confirm", confirmed };
	const options = await service.approvals.options(user, rp, id, "answer", {
		answer: a,
	});
	return service.approvals.decide(user, rp, id, {
		decision: "answer",
		answer: a,
		assertion: auth.assert(
			(options as { options: { challenge: string } }).options as never,
		),
	});
}

async function until(check: () => boolean, ms = 2000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("condition not met in time");
}

async function code(p: Promise<unknown>): Promise<string | null> {
	try {
		await p;
		return null;
	} catch (e) {
		return (e as { code?: string }).code ?? String(e);
	}
}

const action = {
	op: "pool.forget",
	text: "forget pulsar-meshnode",
	target: "pulsar-meshnode",
};

describe("native prompt outcomes", () => {
	test("LocalAuthentication: only the person's cancel or failure denies", () => {
		expect(macOutcome({ ok: true })).toBe("granted");
		expect(macOutcome({ ok: false, code: -2 })).toBe("denied");
		expect(macOutcome({ ok: false, code: -1 })).toBe("denied");
		expect(macOutcome({ ok: false, code: -9 })).toBe("timeout");
		expect(macOutcome({ ok: false, timeout: true })).toBe("timeout");
		for (const c of [-4, -5, -6, -7, -8, -1004, null])
			expect(macOutcome({ ok: false, code: c })).toBe("unavailable");
	});

	test("Windows Hello and polkit results", () => {
		expect(windowsOutcome("Verified")).toBe("granted");
		expect(windowsOutcome("Canceled")).toBe("denied");
		expect(windowsOutcome("DeviceNotPresent")).toBe("unavailable");
		expect(windowsOutcome("")).toBe("unavailable");
		expect(polkitOutcome(0)).toBe("granted");
		expect(polkitOutcome(3)).toBe("denied");
		expect(polkitOutcome(4)).toBe("unavailable");
		expect(polkitOutcome(null)).toBe("unavailable");
	});

	test("the prompt text is one bounded line without control characters", () => {
		expect(promptText("forget\n\u001b[2Jx\u0007  y")).toBe("forget [2Jx y");
		expect(promptText("a".repeat(500)).length).toBe(300);
	});

	test("PULSAR_NATIVE_PRESENCE=off removes the prompt; nothing turns it into a yes", () => {
		expect(
			nativeProvider("darwin", { PULSAR_NATIVE_PRESENCE: "off" }),
		).toBeNull();
		expect(nativeProvider("darwin", {})?.method).toBe("Touch ID");
		expect(nativeProvider("win32", {})?.method).toBe("Windows Hello");
		expect(nativeProvider("linux", {})?.method).toBe("polkit");
		expect(nativeProvider("freebsd", {})).toBeNull();
		// Tests run with it off (test/preload.ts), so no test shows a real prompt.
		expect(process.env.PULSAR_NATIVE_PRESENCE).toBe("off");
	});
});

describe("presence checks (native prompt)", () => {
	test("granted, denied, unavailable with no app, and timeout", async () => {
		const native = new FakePresence("granted", "denied");
		const { service, agent } = setup({ native, answerable: false });
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const ok = await service.presence.confirm(c.caller, action);
		expect(ok.method).toBe("Touch ID");
		expect(native.shown[0]).toBe(
			`confirm a Pulsar change: forget pulsar-meshnode (asked by agent ${agent.name} (claude) on studio)`,
		);
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"denied",
		);
		native.script.push("unavailable");
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"presence_unavailable",
		);
		native.ok = false;
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"presence_unavailable",
		);
		const ops = service.store
			.auditLog(20)
			.map((r) => `${r.op}:${r.ok}`)
			.reverse();
		expect(ops).toEqual([
			"presence.request:true",
			"presence.granted:true",
			"presence.request:true",
			"presence.denied:false",
			"presence.request:true",
			"presence.unavailable:false",
			"presence.unavailable:false",
		]);
	});

	test("nobody answers: timeout, and the prompt is taken down", async () => {
		const native = new FakePresence("hang");
		const { service, agent } = setup({
			native,
			answerable: false,
			timeoutMs: 50,
		});
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		// The fake hangs until aborted; the check aborts it when it gives up.
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"timeout",
		);
		expect(native.aborted).toBe(1);
	});

	test("the caller hanging up (Ctrl-C) cancels and takes the prompt down", async () => {
		const native = new FakePresence("hang");
		const { service, agent } = setup({ native, answerable: false });
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const p = service.presence.confirm(c.caller, action);
		await until(() => native.shown.length === 1);
		c.hangUp();
		expect(await code(p)).toBe("cancelled");
		expect(native.aborted).toBe(1);
	});

	test("a caller that hung up before the prompt opened cancels at once", async () => {
		const native = new FakePresence("hang");
		const { service, agent } = setup({ native, answerable: false });
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		c.hangUp();
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"cancelled",
		);
	});

	test("one check at a time, and repeated denials back off", async () => {
		const native = new FakePresence("hang");
		const { service, agent } = setup({ native, answerable: false });
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const first = service.presence.confirm(c.caller, action);
		await until(() => native.shown.length === 1);
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"rate_limited",
		);
		c.hangUp();
		expect(await code(first)).toBe("cancelled");
		const d = fakeCaller({ kind: "agent", agentId: agent.id });
		native.script.push("denied", "granted");
		expect(await code(service.presence.confirm(d.caller, action))).toBe(
			"denied",
		);
		// A hang-up and a no: the next prompt waits.
		expect(await code(service.presence.confirm(d.caller, action))).toBe(
			"rate_limited",
		);
		expect(native.shown.length).toBe(2);
	});

	test("asking and hanging up in a loop backs off too (no endless prompts)", async () => {
		const native = new FakePresence("hang", "hang", "hang");
		const { service, agent } = setup({ native, answerable: false });
		for (let i = 0; i < 2; i++) {
			const c = fakeCaller({ kind: "agent", agentId: agent.id });
			const p = service.presence.confirm(c.caller, action);
			await until(() => native.shown.length === i + 1);
			c.hangUp();
			expect(await code(p)).toBe("cancelled");
		}
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"rate_limited",
		);
		expect(native.shown.length).toBe(2);
	});

	test("the app's user and linked peers can't ask over the socket", async () => {
		const { service } = setup({ native: new FakePresence("granted") });
		for (const p of [
			user,
			{ kind: "peer", machineId: "m", node: "n" },
		] as Principal[])
			expect(
				await code(service.presence.confirm(fakeCaller(p).caller, action)),
			).toBe("forbidden");
	});
});

describe("a client can't forge the check", () => {
	test("a 'granted' in the request is ignored: the daemon still asks, and a no applies nothing", async () => {
		const native = new FakePresence("denied", "denied");
		const { service, agent } = setup({ native, answerable: false });
		service.poolStatus = async () => null;
		const auth = await enroll(service);
		void auth;
		const id = service.approvals.passkeys.list()[0]!.id;
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const forged = {
			id,
			granted: true,
			confirmed: true,
			presence: "granted",
			proof: { op: "passkeys.remove", method: "Touch ID" },
			ticket: "x",
			word: "x",
		};
		await expect(
			service.handle(c.caller, "passkeys.remove", forged),
		).rejects.toMatchObject({
			code: "denied",
		});
		expect(native.shown.length).toBe(1);
		expect(service.approvals.passkeys.list().length).toBe(1);
		// `pool.confirm` (the old typed word) is gone.
		await expect(
			service.handle(c.caller, "pool.confirm", { ticket: "x", word: "x" }),
		).rejects.toMatchObject({ code: "unknown_method" });
	});

	test("a look-alike proof object never passes; a real one is spent once and only for its op", async () => {
		expect(
			spendConfirmed(
				{ op: "passkeys.remove", method: "Touch ID" },
				"passkeys.remove",
			),
		).toBe(false);
		const native = new FakePresence("granted");
		const { service, agent } = setup({ native, answerable: false });
		await enroll(service);
		const id = service.approvals.passkeys.list()[0]!.id;
		const agentP = { kind: "agent" as const, agentId: agent.id };
		expect(
			await code(
				Promise.resolve().then(() =>
					service.approvals.removePasskey(agentP, id, {
						op: "passkeys.remove",
						method: "Touch ID",
					}),
				),
			),
		).toBe("forbidden");
		const proof = await service.presence.confirm(fakeCaller(agentP).caller, {
			...action,
			op: "pool.forget",
		});
		// A proof for another op can't remove a passkey.
		expect(
			await code(
				Promise.resolve().then(() =>
					service.approvals.removePasskey(agentP, id, proof),
				),
			),
		).toBe("forbidden");
		expect(service.approvals.passkeys.list().length).toBe(1);
	});
});

describe("presence checks (the app)", () => {
	test("an agent's request: a confirm card on that agent; a passkey-signed yes applies it", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		await enroll(service, "MacBook");
		const target = service.approvals.passkeys
			.list()
			.find((k) => k.label === "MacBook")!;
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const removed = service.handle(c.caller, "passkeys.remove", {
			id: target.id,
		});
		await until(() => service.approvals.pendingFor(agent.id).length === 1);
		const card = service.approvals.pendingFor(agent.id)[0]!;
		expect(card.kind).toBe("confirm");
		expect(card.prompt).toEqual({
			kind: "confirm",
			title: `Confirm: remove passkey 'MacBook' (${target.id.slice(0, 8)})`,
			message: `Asked by agent ${agent.name} (claude) on studio. Confirm only if you started this.`,
		});
		// Needs You shows it.
		const item = service.app.views.attention().items[0]!;
		expect(item).toMatchObject({
			kind: "approval",
			title: `Confirm: remove passkey 'MacBook' (${target.id.slice(0, 8)})`,
		});
		expect(item.approval?.requestId).toBe(card.requestId);
		// The CLI heard where to confirm.
		expect(c.events[0]).toMatchObject({
			event: "presence",
			data: { methods: ["the Pulsar app"] },
		});
		const r = await answer(service, auth, card.requestId, true);
		expect(r.won).toBe(true);
		expect(await removed).toEqual({ removed: true });
		expect(service.approvals.passkeys.list().map((k) => k.label)).toEqual([
			"iPhone",
		]);
		expect(service.approvals.get(card.requestId)?.outcome).toMatch(
			/^Confirmed by /,
		);
		expect(service.registry.needsYou(agent.id)).toBeNull();
	});

	test("a no in the app refuses; nothing changes", async () => {
		const { service, agent } = setup();
		const auth = await enroll(service);
		const id = service.approvals.passkeys.list()[0]!.id;
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const removed = service.handle(c.caller, "passkeys.remove", { id });
		await until(() => service.approvals.pendingFor(agent.id).length === 1);
		const card = service.approvals.pendingFor(agent.id)[0]!;
		await answer(service, auth, card.requestId, false);
		await expect(removed).rejects.toMatchObject({ code: "denied" });
		expect(service.approvals.passkeys.list().length).toBe(1);
		expect(service.approvals.get(card.requestId)?.state).toBe("denied");
	});

	test("nobody answers: it expires, and the card says so", async () => {
		const { service, agent } = setup({ timeoutMs: 80 });
		await enroll(service);
		const id = service.approvals.passkeys.list()[0]!.id;
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const removed = service.handle(c.caller, "passkeys.remove", { id });
		await until(() => service.approvals.pendingFor(agent.id).length === 1);
		const cardId = service.approvals.pendingFor(agent.id)[0]!.requestId;
		await expect(removed).rejects.toMatchObject({ code: "timeout" });
		expect(service.approvals.get(cardId)).toMatchObject({
			state: "expired",
			outcome: "Expired: nobody confirmed in time",
		});
		expect(service.approvals.passkeys.list().length).toBe(1);
	});

	test("a terminal's request shows on the operator in Needs You", async () => {
		const { service } = setup();
		const auth = await enroll(service);
		const c = fakeCaller({ kind: "terminal" });
		const p = service.presence.confirm(c.caller, action);
		await until(() => service.approvals.pendingFor(OPERATOR_ID).length === 1);
		const items = service.app.views.attention().items;
		expect(items.map((i) => i.agent.id)).toEqual([OPERATOR_ID]);
		const card = service.approvals.pendingFor(OPERATOR_ID)[0]!;
		expect(card.prompt).toMatchObject({
			message: expect.stringContaining("Asked by a terminal on studio"),
		});
		await answer(service, auth, card.requestId, true);
		expect((await p).method).toBe("passkey in the app");
	});

	test("an agent can't approve its own card", async () => {
		const { service, agent } = setup();
		await enroll(service);
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const p = service.presence.confirm(c.caller, action);
		await until(() => service.approvals.pendingFor(agent.id).length === 1);
		const id = service.approvals.pendingFor(agent.id)[0]!.requestId;
		expect(
			await code(
				service.approvals.decide({ kind: "agent", agentId: agent.id }, rp, id, {
					decision: "answer",
					answer: { kind: "confirm", confirmed: true },
					assertion: {},
				}),
			),
		).toBe("forbidden");
		c.hangUp();
		expect(await code(p)).toBe("cancelled");
		expect(service.approvals.get(id)?.state).toBe("expired");
	});
});

describe("both at once: the first answer wins", () => {
	test("Touch ID first: the card closes as confirmed with Touch ID", async () => {
		const native = new FakePresence("granted");
		const { service, agent } = setup({ native });
		await enroll(service);
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const ok = await service.presence.confirm(c.caller, action);
		expect(ok.method).toBe("Touch ID");
		const card = service.approvals.recentFor(agent.id, 60_000)[0]!;
		expect(card.state).toBe("allowed");
		expect(card.outcome).toMatch(/^Confirmed by you · Touch ID on studio · /);
		expect(c.events[0]).toMatchObject({
			data: { methods: ["Touch ID", "the Pulsar app"] },
		});
	});

	test("the app first: the Touch ID prompt is taken down", async () => {
		const native = new FakePresence("hang");
		const { service, agent } = setup({ native });
		const auth = await enroll(service);
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const p = service.presence.confirm(c.caller, action);
		await until(
			() =>
				native.shown.length === 1 &&
				service.approvals.pendingFor(agent.id).length === 1,
		);
		await answer(
			service,
			auth,
			service.approvals.pendingFor(agent.id)[0]!.requestId,
			true,
		);
		expect((await p).method).toBe("passkey in the app");
		expect(native.aborted).toBe(1);
	});

	test("Touch ID says no while the card is open: denied, and the card closes", async () => {
		const native = new FakePresence("denied");
		const { service, agent } = setup({ native });
		await enroll(service);
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		expect(await code(service.presence.confirm(c.caller, action))).toBe(
			"denied",
		);
		expect(service.approvals.recentFor(agent.id, 60_000)[0]?.state).toBe(
			"denied",
		);
	});

	test("Touch ID unavailable (system dismissed it): the card still decides", async () => {
		const native = new FakePresence("unavailable");
		const { service, agent } = setup({ native });
		const auth = await enroll(service);
		const c = fakeCaller({ kind: "agent", agentId: agent.id });
		const p = service.presence.confirm(c.caller, action);
		await until(() => service.approvals.pendingFor(agent.id).length === 1);
		await new Promise((r) => setTimeout(r, 10));
		expect(service.approvals.pendingFor(agent.id).length).toBe(1);
		await answer(
			service,
			auth,
			service.approvals.pendingFor(agent.id)[0]!.requestId,
			true,
		);
		expect((await p).method).toBe("passkey in the app");
	});
});

describe("the last resort: a word on the terminal (no system prompt, no app)", () => {
	function terminalGate() {
		const written: string[] = [];
		let clock = 1_000_000;
		const gate = new EnrollGate({
			ttyOf: (pid) => (pid === 4242 ? "/dev/ttys009" : null),
			agentHost: () => null,
			ownedByUser: () => true,
			processesOn: () => [4242],
			writeTty: (_tty, text) => written.push(text),
			now: () => clock,
		});
		return {
			gate,
			written,
			tick: (ms: number) => {
				clock += ms;
			},
			word: () => /type: (\S+)/.exec(written.at(-1) ?? "")?.[1] ?? "",
		};
	}

	test("a terminal types the word back; a wrong word doesn't count", async () => {
		const t = terminalGate();
		const { service } = setup({ answerable: false, terminal: t.gate });
		const c = fakeCaller({ kind: "terminal" });
		const p = service.presence.confirm(c.caller, { ...action, pid: 4242 });
		await until(() => c.events.length === 1);
		const { ticket, methods } = c.events[0]!.data as {
			ticket: string;
			methods: string[];
		};
		expect(methods).toEqual(["the word on your terminal"]);
		expect(t.written[0]).toContain("forget pulsar-meshnode");
		const second = fakeCaller({ kind: "terminal" }).caller;
		expect(service.presence.word(second, ticket, "WRONG")).toEqual({
			ok: false,
		});
		t.tick(30_000);
		expect(service.presence.word(second, ticket, t.word())).toEqual({
			ok: true,
		});
		expect((await p).method).toBe("the word on your terminal");
	});

	test("hanging up clears the word's timeout", async () => {
		const t = terminalGate();
		const { service } = setup({
			answerable: false,
			terminal: t.gate,
			timeoutMs: 987_654,
		});
		const c = fakeCaller({ kind: "terminal" });
		const realSet = globalThis.setTimeout;
		const realClear = globalThis.clearTimeout;
		let timer: unknown = null;
		let cleared = false;
		globalThis.setTimeout = ((fn: () => void, ms?: number) => {
			const h = realSet(fn, ms);
			if (ms === 987_654) timer = h;
			return h;
		}) as typeof setTimeout;
		globalThis.clearTimeout = ((h: unknown) => {
			if (h !== null && h === timer) cleared = true;
			realClear(h as NodeJS.Timeout);
		}) as typeof clearTimeout;
		try {
			const p = service.presence.confirm(c.caller, { ...action, pid: 4242 });
			p.catch(() => {});
			await until(() => c.events.length === 1);
			expect(timer).not.toBeNull();
			c.hangUp();
			await p.catch(() => {});
			expect(cleared).toBe(true);
		} finally {
			globalThis.setTimeout = realSet;
			globalThis.clearTimeout = realClear;
			if (timer) realClear(timer as NodeJS.Timeout);
		}
	});

	test("the system prompt can't be shown after all (no GUI login): a terminal still gets the word", async () => {
		const t = terminalGate();
		const { service } = setup({
			native: new FakePresence("unavailable"),
			answerable: false,
			terminal: t.gate,
		});
		const c = fakeCaller({ kind: "terminal" });
		const p = service.presence.confirm(c.caller, { ...action, pid: 4242 });
		await until(() => c.events.length === 2);
		const { ticket } = c.events[1]!.data as { ticket: string };
		const second = fakeCaller({ kind: "terminal" }).caller;
		expect(service.presence.word(second, ticket, t.word())).toEqual({
			ok: true,
		});
		expect((await p).method).toBe("the word on your terminal");
	});

	test("three wrong words deny; agents can't type it; an agent with no other way is refused", async () => {
		const t = terminalGate();
		const { service, agent } = setup({ answerable: false, terminal: t.gate });
		const c = fakeCaller({ kind: "terminal" });
		const p = service.presence.confirm(c.caller, { ...action, pid: 4242 });
		await until(() => c.events.length === 1);
		const { ticket } = c.events[0]!.data as { ticket: string };
		const agentCaller = fakeCaller({ kind: "agent", agentId: agent.id }).caller;
		expect(() => service.presence.word(agentCaller, ticket, t.word())).toThrow(
			"typed at a terminal",
		);
		const second = fakeCaller({ kind: "terminal" }).caller;
		for (let i = 0; i < 3; i++) {
			t.tick(5_000);
			expect(service.presence.word(second, ticket, "WRONG")).toEqual({
				ok: false,
			});
		}
		expect(await code(p)).toBe("denied");
		// An agent's request never falls back to the word, and says what to do.
		const msg = (p: Promise<unknown>) =>
			p.then(
				() => "",
				(e: Error) => e.message,
			);
		const agentMsg = await msg(
			service.presence.confirm(agentCaller, { ...action, pid: 4242 }),
		);
		expect(agentMsg).toContain(
			"an agent's request never falls back to a typed word",
		);
		expect(agentMsg).toContain("pulsar mesh on --prove");
		expect(agentMsg).toContain("run the command yourself in a terminal");
		// A terminal process with no terminal (the `!` prefix, a pipe): refused, with why.
		const noTty = await msg(
			service.presence.confirm(c.caller, { ...action, pid: 1234 }),
		);
		expect(noTty).toContain("That process has no terminal");
		expect(noTty).toContain("the app can't ask either");
		expect(t.written.length).toBe(1);
	});
});
