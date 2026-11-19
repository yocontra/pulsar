import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Caller } from "../src/service/caller.ts";
import type { ServiceEvents } from "../src/service/events.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import type { AgentStatus } from "../src/types.ts";

/**
 * `agent:status {from, to, at}` on the service bus: one event per change of
 * the shown status (busy / idle / gone; `unknown` shows as idle), from every
 * path that changes it.
 */

const T0 = Date.parse("2026-11-18T05:00:00Z");
const at = (ms: number) => setSystemTime(new Date(T0 + ms));
afterEach(() => setSystemTime());

type Ev = ServiceEvents["agent:status"];

function service(settleMs = 0) {
	const store = new Store(":memory:");
	const svc = new PulsarService({ store, scan: false, machine: "t" });
	svc.registry.idleSettleMs = settleMs;
	const events: Ev[] = [];
	svc.events.on("agent:status", (e) => events.push(e));
	const upsert = (status?: AgentStatus, sessionId = "s1") =>
		svc.registry.upsert({
			harness: "omp",
			sessionId,
			pid: 4061,
			cwd: null,
			project: null,
			branch: null,
			tags: [],
			meta: {},
			registered: false,
			...(status ? { status } : {}),
		});
	return {
		svc,
		events,
		upsert,
		/** Just `from -> to`, for short assertions. */
		moves: () => events.map((e) => `${e.from}->${e.to}`),
		close: () => {
			svc.stop();
			store.close();
		},
	};
}

describe("agent:status", () => {
	test("first sighting is no change; each real change is one event", () => {
		const t = service();
		try {
			at(0);
			const agent = t.upsert("idle");
			expect(t.events).toEqual([]);
			at(1000);
			t.svc.registry.setStatus(agent, "busy");
			t.svc.registry.setStatus(agent, "busy");
			at(2000);
			t.svc.registry.setStatus(agent, "idle");
			expect(t.moves()).toEqual(["idle->busy", "busy->idle"]);
			expect(t.events[0]).toEqual({
				agentId: agent.id,
				from: "idle",
				to: "busy",
				at: T0 + 1000,
			});
		} finally {
			t.close();
		}
	});

	test("an idle after busy is announced once it held, dated when it began", () => {
		const t = service(4000);
		try {
			at(0);
			const agent = t.upsert("idle");
			t.svc.registry.setStatus(agent, "busy");
			at(10_000);
			t.svc.registry.setStatus(agent, "idle");
			at(12_000);
			t.svc.registry.setStatus(agent, "idle");
			expect(t.moves()).toEqual(["idle->busy"]);
			t.svc.registry.settleIdle(T0 + 14_000);
			expect(t.moves()).toEqual(["idle->busy", "busy->idle"]);
			expect(t.events[1]!.at).toBe(T0 + 10_000);
		} finally {
			t.close();
		}
	});

	test("an idle flap inside the settle time is never announced", () => {
		const t = service(4000);
		try {
			at(0);
			const agent = t.upsert("idle");
			t.svc.registry.setStatus(agent, "busy");
			at(10_000);
			t.svc.registry.setStatus(agent, "idle");
			at(11_000);
			t.svc.registry.setStatus(agent, "busy");
			t.svc.registry.settleIdle(T0 + 60_000);
			expect(t.moves()).toEqual(["idle->busy"]);
		} finally {
			t.close();
		}
	});

	test("unknown shows as idle: unknown <-> idle is silent, unknown -> busy is not", () => {
		const t = service();
		try {
			at(0);
			const agent = t.upsert("unknown");
			t.svc.registry.applyLiveStatus(agent, "idle", T0);
			expect(t.events).toEqual([]);
			t.upsert("unknown");
			expect(t.events).toEqual([]);
			const again = t.svc.registry.get(agent.id)!;
			t.svc.registry.applyLiveStatus(again, "busy", T0 + 500);
			t.svc.registry.setStatus(again, "unknown");
			expect(t.moves()).toEqual(["unknown->busy", "busy->unknown"]);
		} finally {
			t.close();
		}
	});

	test("a scan reading busy, then a vanished session, then its return", async () => {
		const t = service();
		try {
			at(0);
			t.upsert("idle");
			// A scan's reading (upsert with a status).
			const agent = t.upsert("busy");
			expect(t.moves()).toEqual(["idle->busy"]);
			// Gone from the scan, still connected to pulsar: idle, silently before.
			const caller: Caller = {
				principal: { kind: "agent", agentId: agent.id },
				closed: new AbortController().signal,
				emit: () => {},
			};
			t.svc.sessions.add(caller);
			at(5000);
			await (
				t.svc.registry as unknown as {
					applyScan: (f: unknown[], h: Set<string>, s: number) => Promise<void>;
				}
			).applyScan([], new Set(["omp"]), T0 + 5000);
			expect(t.moves()).toEqual(["idle->busy", "busy->idle"]);
			// Gone from the scan and no connection: gone.
			t.svc.sessions.remove(caller);
			at(6000);
			await (
				t.svc.registry as unknown as {
					applyScan: (f: unknown[], h: Set<string>, s: number) => Promise<void>;
				}
			).applyScan([], new Set(["omp"]), T0 + 6000);
			expect(t.moves().at(-1)).toBe("idle->gone");
			// It comes back.
			t.upsert("idle");
			expect(t.moves().at(-1)).toBe("gone->idle");
		} finally {
			t.close();
		}
	});

	test("a session its process left (/resume) is announced gone", () => {
		const t = service();
		try {
			at(0);
			const old = t.upsert("idle", "old");
			const current = t.upsert("idle", "new");
			old.meta.tmux = "%7";
			(
				t.svc.registry as unknown as {
					retireSession: (o: unknown, c: unknown) => void;
				}
			).retireSession(old, current);
			expect(t.events.at(-1)).toMatchObject({
				agentId: old.id,
				from: "idle",
				to: "gone",
			});
			// The pane it ran in carries over to the session that took its process.
			expect(t.svc.registry.get(current.id)!.meta.tmux).toBe("%7");
			// And the app sees it on the row.
			expect(t.svc.app.views.row(t.svc.registry.get(current.id)!).tmux).toBe(
				"%7",
			);
			expect(
				t.svc.app.views.row(t.upsert("idle", "plain")).tmux,
			).toBeUndefined();
		} finally {
			t.close();
		}
	});
});
