import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";
import type { HarnessDriver } from "../src/harnesses/types.ts";
import { EventHub } from "../src/http/events.ts";
import type { PushPayload, TurnNotifyMode } from "../src/http/wire.ts";
import type { Principal } from "../src/service/caller.ts";
import type { ServiceEvents } from "../src/service/events.ts";
import { PulsarService } from "../src/service/index.ts";
import { Interest } from "../src/service/interest.ts";
import { Store } from "../src/store.ts";
import {
	claudeTurnFailed,
	codexTurnFailed,
	piTurnFailed,
} from "../src/transcripts/turn-outcome.ts";
import { until } from "./helpers.ts";
import { browser, decrypt } from "./push-crypto.ts";

const FIX = join(import.meta.dir, "fixtures", "turns");
const fixture = (name: string) => readFileSync(join(FIX, name), "utf8");

describe("failed turns, per harness", () => {
	test("Claude: a synthetic API error ends the turn; a retry that answered does not", () => {
		expect(claudeTurnFailed(fixture("claude-failed.jsonl"))).toBe(true);
		// The last main-thread reply is a normal one (a failing tool call and a
		// sidechain's API error don't count).
		expect(claudeTurnFailed(fixture("claude-retried.jsonl"))).toBe(false);
	});

	test("Codex: task_complete with an error, or an error event; stream retries and stops are not", () => {
		expect(codexTurnFailed(fixture("codex-failed.jsonl"))).toBe(true);
		expect(codexTurnFailed(fixture("codex-error-event.jsonl"))).toBe(true);
		expect(codexTurnFailed(fixture("codex-finished.jsonl"))).toBe(false);
		const lines = fixture("codex-finished.jsonl").split("\n");
		// Ending at the clean task_complete (before the operator's stop).
		expect(codexTurnFailed(lines.slice(0, 3).join("\n"))).toBe(false);
	});

	test("pi and omp: stopReason error fails; aborted (the operator) does not", () => {
		expect(piTurnFailed(fixture("pi-failed.jsonl"))).toBe(true);
		expect(piTurnFailed(fixture("pi-aborted.jsonl"))).toBe(false);
	});

	test("an older failure is not the last turn's: a prompt after it starts another", () => {
		expect(
			claudeTurnFailed(fixture("claude-stopped-after-failure.jsonl")),
		).toBe(false);
		expect(piTurnFailed(fixture("pi-stopped-after-failure.jsonl"))).toBe(false);
	});

	test("a cut first line and junk are skipped; an empty tail is not a failure", () => {
		const tail = `ror":true}\nnot json\n${fixture("pi-failed.jsonl")}`;
		expect(piTurnFailed(tail)).toBe(true);
		expect(claudeTurnFailed("")).toBe(false);
		expect(codexTurnFailed("{")).toBe(false);
	});

	test("each driver reads its own format", () => {
		const t = (h: string) =>
			(driverFor(h) as HarnessDriver).transcript?.turnFailed;
		expect(t("claude")).toBe(claudeTurnFailed);
		expect(t("codex")).toBe(codexTurnFailed);
		expect(t("pi")).toBe(piTurnFailed);
		expect(t("omp")).toBe(piTurnFailed);
	});
});

describe("migration", () => {
	test("subscriptions made before finish/fail notifications get Notifications only", () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-turns-db-"));
		try {
			const file = join(dir, "pulsar.db");
			let store = new Store(file);
			store.db
				.prepare(
					"INSERT INTO push_subscriptions (endpoint, p256dh, auth, login, created_at) VALUES ('https://web.push.apple.com/old', 'k', 'a', 'me', 1)",
				)
				.run();
			// As an older pulsar left it: no `turns` column.
			store.db.exec("ALTER TABLE push_subscriptions DROP COLUMN turns");
			store.close();
			store = new Store(file);
			const row = store.db
				.prepare("SELECT turns, in_app FROM push_subscriptions")
				.get() as { turns: string; in_app: number };
			expect(row).toEqual({ turns: "notify", in_app: 1 });
			store.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("interest", () => {
	test("an action keeps an agent for the window, then it lapses", () => {
		const store = new Store(":memory:");
		let now = 1_000_000;
		const i = new Interest({ store, now: () => now, windowMs: 1000 });
		expect(i.has("claude:a")).toBe(false);
		i.note("claude:a");
		expect(i.has("claude:a")).toBe(true);
		now += 1001;
		expect(i.has("claude:a")).toBe(false);
		i.note("m1/claude:b");
		expect(i.has("m1/claude:b")).toBe(true);
		store.close();
	});
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

const user: Principal = { kind: "human", login: "me@x", node: "phone" };

function setup(opts: { graceMs?: number } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-turns-"));
	const store = new Store(":memory:");
	const files = new Map<string, string>();
	const sent: Array<{ headers: Record<string, string>; body: Uint8Array }> = [];
	const service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		approvals: { probe: () => null },
		push: {
			keyFile: join(dir, "vapid.json"),
			send: async (_url, init) => {
				sent.push({ headers: init.headers, body: init.body });
				return { status: 201 };
			},
		},
		turns: { graceMs: opts.graceMs ?? 40 },
		transcripts: {
			resolve: (agent) => {
				const path = agent.sessionId ? files.get(agent.sessionId) : undefined;
				return path
					? {
							source: { kind: "file", path },
							parse: (driverFor("pi") as HarnessDriver).transcript!.parse,
						}
					: null;
			},
		},
	});
	service.registry.idleSettleMs = 30;
	service.start();
	const turns: ServiceEvents["agent:turn"][] = [];
	const notices: ServiceEvents["notify"][] = [];
	service.events.on("agent:turn", (t) => turns.push(t));
	service.events.on("notify", (n) => notices.push(n));
	cleanups.push(() => {
		service.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const pi = (sessionId: string, log?: string) => {
		if (log) {
			const file = join(dir, `${sessionId}.jsonl`);
			copyFileSync(join(FIX, log), file);
			files.set(sessionId, file);
		}
		return service.registry.upsert({
			harness: "pi",
			sessionId,
			pid: null,
			cwd: "/secret/project",
			project: "secret",
			branch: "main",
			tags: [],
			name: "secret-name",
			meta: {},
			registered: false,
		});
	};
	return { service, sent, turns, notices, pi };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("turn rules", () => {
	test("busy → idle after the hold and the grace is a finished turn", async () => {
		const { service, turns, pi } = setup();
		const a = pi("s1");
		service.registry.setStatus(a, "busy");
		const before = Date.now();
		service.registry.setStatus(a, "idle");
		await until(() => turns.length === 1, 2000);
		// Held for the settle time (30 ms), then the grace (40 ms).
		expect(Date.now() - before).toBeGreaterThanOrEqual(65);
		expect(turns[0]).toMatchObject({ agentId: a.id, kind: "finished" });
		expect(service.turns.lastTurn(a.id)).toEqual({
			kind: "finished",
			at: turns[0]!.at,
		});
	});

	test("busy again within the grace: no turn; neither for busy → gone nor busy → unknown", async () => {
		const { service, turns, pi } = setup({ graceMs: 1000 });
		const a = pi("s1");
		service.registry.setStatus(a, "busy");
		service.registry.setStatus(a, "idle");
		await until(() => a.status === "idle", 2000); // shown idle (30 ms hold)
		service.registry.setStatus(a, "busy"); // well inside the grace
		await sleep(1100);
		expect(turns).toEqual([]);
		// Status lost is not a finished turn.
		service.registry.setStatus(a, "unknown");
		await sleep(150);
		expect(turns).toEqual([]);
		const b = pi("s2");
		service.registry.setStatus(b, "busy");
		service.registry.setStatus(b, "gone");
		await sleep(150);
		expect(turns).toEqual([]);
	});

	test("a new agent's first status is never a turn", async () => {
		const { service, turns } = setup();
		service.registry.upsert({
			harness: "pi",
			sessionId: "fresh",
			pid: null,
			cwd: "/w",
			project: "w",
			branch: null,
			tags: [],
			meta: {},
			registered: false,
			status: "idle",
		});
		await sleep(150);
		expect(turns).toEqual([]);
	});

	test("an error the harness ended the turn with is a failed turn", async () => {
		const { service, turns, pi } = setup();
		const a = pi("bad", "pi-failed.jsonl");
		const b = pi("stopped", "pi-aborted.jsonl");
		for (const x of [a, b]) {
			service.registry.setStatus(x, "busy");
			service.registry.setStatus(x, "idle");
		}
		await until(() => turns.length === 2, 2000);
		const kind = (id: string) => turns.find((t) => t.agentId === id)?.kind;
		expect(kind(a.id)).toBe("failed");
		expect(kind(b.id)).toBe("finished");
	});
});

describe("notifications follow interest", () => {
	test("only agents the operator messaged, opened or acted on notify", async () => {
		const { service, turns, notices, pi } = setup();
		const quiet = pi("quiet");
		const mine = pi("mine");
		service.app.onOperatorSend([mine.id]);
		for (const x of [quiet, mine]) {
			service.registry.setStatus(x, "busy");
			service.registry.setStatus(x, "idle");
		}
		await until(() => turns.length === 2, 2000);
		await sleep(10);
		expect(notices.map((n) => n.agentId)).toEqual([mine.id]);
		// The same turn announced again (a snapshot replay) notifies once.
		service.events.emit(
			"agent:turn",
			turns.find((t) => t.agentId === mine.id)!,
		);
		expect(notices).toHaveLength(1);
	});

	test("a remote agent's turn (pool address) notifies when opened through this node", () => {
		const { service, notices } = setup();
		service.interest.note("m-mini/claude:abc");
		service.events.emit("agent:turn", {
			agentId: "m-mini/claude:abc",
			kind: "failed",
			at: Date.now(),
		});
		service.events.emit("agent:turn", {
			agentId: "m-mini/claude:other",
			kind: "finished",
			at: Date.now(),
		});
		expect(notices).toEqual([
			expect.objectContaining({ agentId: "m-mini/claude:abc", kind: "failed" }),
		]);
	});
});

describe("turn pushes", () => {
	test("own topic per kind, no names or text, and the subscription's mode decides", async () => {
		const { service, sent } = setup();
		const subs = {
			notify: browser(),
			both: browser(),
			sound: browser(),
			off: browser(),
		};
		for (const [key, ua] of Object.entries(subs)) {
			const mode = key as TurnNotifyMode;
			const endpoint = `https://web.push.apple.com/${mode}`;
			service.push.subscribe(user, { endpoint, keys: ua.keys });
			expect(service.push.settings(user, { endpoint, turns: mode })).toEqual({
				subscribed: true,
				chosen: true,
				turns: mode,
				inApp: true,
			});
		}
		// A new subscription that never said gets no finish/fail pushes.
		const fresh = browser();
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/fresh",
			keys: fresh.keys,
		});
		// The "turned on" security notice (at most one a minute) goes first.
		await until(() => sent.length >= 1, 2000);
		await sleep(30);
		sent.length = 0;
		service.events.emit("notify", {
			kind: "failed",
			agentId: "pi:s1",
			at: Date.now(),
		});
		await until(() => sent.length === 2, 2000);
		await sleep(20);
		expect(sent).toHaveLength(2);
		const payloads = sent.map((s) => {
			expect(s.headers.Topic).toBe("failed");
			expect(s.headers.Urgency).toBe("high");
			for (const ua of Object.values(subs))
				try {
					return JSON.parse(
						decrypt(Buffer.from(s.body), ua.priv, ua.auth).toString(),
					) as PushPayload;
				} catch {}
			throw new Error("no subscription decrypts this push");
		});
		// An opaque token, the same for every push about this agent; the app
		// resolves it (GET /push/turns/:ref). Never the id, a name or text.
		const ref = (payloads[0] as { ref: string }).ref;
		expect(ref).toMatch(/^[\w-]{22}$/);
		expect(payloads).toContainEqual({ kind: "failed", ref });
		expect(payloads).toContainEqual({ kind: "failed", ref, sound: true });
		expect(JSON.stringify(payloads)).not.toContain("pi:s1");
		expect(service.push.turnAgent(user, ref)).toEqual({ agentId: "pi:s1" });
		expect(() => service.push.turnAgent(user, "nope")).toThrow("too old");
		sent.length = 0;
		service.events.emit("notify", {
			kind: "finished",
			agentId: "pi:s1",
			at: Date.now(),
		});
		await until(() => sent.length === 2, 2000);
		expect(sent.every((s) => s.headers.Topic === "finished")).toBe(true);
		expect(sent.every((s) => s.headers.Urgency === "normal")).toBe(true);
	});

	test("settings: unknown endpoints keep nothing; in-app is stored with the subscription", () => {
		const { service } = setup();
		expect(
			service.push.settings(user, {
				endpoint: "https://web.push.apple.com/none",
				turns: "both",
			}),
		).toEqual({ subscribed: false, chosen: false, turns: "both", inApp: true });
		service.push.subscribe(user, {
			endpoint: "https://web.push.apple.com/x",
			keys: browser().keys,
		});
		expect(
			service.push.settings(user, {
				endpoint: "https://web.push.apple.com/x",
				inApp: false,
			}),
		).toEqual({
			subscribed: true,
			chosen: false,
			turns: "notify",
			inApp: false,
		});
	});
});

describe("the app's stream", () => {
	test("every stream hears notify; opening an agent (not a prefetch) makes it interesting", async () => {
		const { service, pi } = setup();
		const a = pi("open-me");
		const hub = new EventHub(service, { coalesceMs: 600_000 });
		hub.start();
		cleanups.unshift(() => hub.stop());
		const reader = hub.open("me@x", null).getReader();
		const next = async () =>
			new TextDecoder().decode((await reader.read()).value);
		const first = await next();
		const streamId = /"streamId":"([^"]+)"/.exec(first)![1]!;
		// A hover prefetch follows the transcript (`?stream=`): not an open.
		hub.watchSession(streamId, "me@x", a.id);
		expect(service.interest.has(a.id)).toBe(false);
		// The app's own subscription (PUT /subscriptions) with the agent open.
		hub.setSubscription(
			streamId,
			"me@x",
			{
				expanded: [],
				window: null,
				session: a.id,
				query: null,
				results: null,
				receipts: [],
			},
			{ opened: true },
		);
		expect(service.interest.has(a.id)).toBe(true);
		service.events.emit("notify", { kind: "finished", agentId: a.id, at: 1 });
		let text = "";
		while (!text.includes("event: notify")) text += await next();
		expect(text).toContain(`"agentId":"${a.id}"`);
		expect(text).toContain('"kind":"finished"');
		await reader.cancel();
	});
});
