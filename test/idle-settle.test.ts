import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import type { Caller } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";

const T0 = Date.parse("2026-11-18T05:00:00Z");
const SETTLE = 4000;

function service(settleMs = SETTLE) {
	const store = new Store(":memory:");
	const svc = new PulsarService({ store, scan: false, machine: "t" });
	svc.registry.idleSettleMs = settleMs;
	const agent = svc.registry.upsert({
		harness: "omp",
		sessionId: null,
		pid: 4061,
		cwd: null,
		project: null,
		branch: null,
		tags: [],
		meta: {},
		registered: true,
	});
	const updates: string[] = [];
	svc.events.on("agent", (e) => {
		if (e.agent.id === agent.id) updates.push(e.agent.status);
	});
	return {
		svc,
		agent,
		updates,
		/** The agent as a row shows it. */
		row: () => svc.app.views.row(svc.registry.get(agent.id) ?? agent),
		close: () => {
			svc.stop();
			store.close();
		},
	};
}

const at = (ms: number) => setSystemTime(new Date(T0 + ms));

afterEach(() => setSystemTime());

describe("idle shows only once it has held for the settle time", () => {
	test("an idle that flips back to busy within the settle time never shows", () => {
		const { svc, agent, row, updates, close } = service();
		try {
			at(0);
			svc.registry.setStatus(agent, "busy");
			// A pause between two loops of one turn.
			at(10_000);
			svc.registry.setStatus(agent, "idle");
			expect(agent.status).toBe("busy");
			at(11_000);
			expect(row().state).toBe("busy");
			svc.registry.setStatus(agent, "busy");
			at(60_000);
			expect(row().state).toBe("busy");
			// Busy since the turn began, not since the flap.
			expect(row().stateSince).toBe(T0);
			expect(updates).not.toContain("idle");
		} finally {
			close();
		}
	});

	test("a real idle shows after the settle time, dated from when it went idle", () => {
		const { svc, agent, row, close } = service();
		try {
			at(0);
			svc.registry.setStatus(agent, "busy");
			at(10_000);
			svc.registry.setStatus(agent, "idle");
			// Repeated readings keep the first time.
			at(12_000);
			svc.registry.setStatus(agent, "idle");
			at(10_000 + SETTLE - 1);
			expect(row().state).toBe("busy");
			at(10_000 + SETTLE);
			expect(row().state).toBe("idle");
			expect(row().stateSince).toBe(T0 + 10_000);
		} finally {
			close();
		}
	});

	test("busy shows at once", () => {
		const { svc, agent, row, close } = service();
		try {
			at(0);
			svc.registry.setStatus(agent, "idle");
			// Idle from unknown (nothing to flap from) shows at once too.
			expect(row().state).toBe("idle");
			at(5000);
			svc.registry.setStatus(agent, "busy");
			expect(row().state).toBe("busy");
			expect(row().stateSince).toBe(T0 + 5000);
		} finally {
			close();
		}
	});

	test("the settle timer announces the idle and wakes idle waiters", async () => {
		setSystemTime();
		const { svc, agent, updates, close } = service(50);
		try {
			svc.registry.setStatus(agent, "busy");
			const wentIdle = Date.now();
			svc.registry.setStatus(agent, "idle");
			let woke: unknown = null;
			const caller = {
				principal: { kind: "operator" },
				closed: new AbortController().signal,
				emit: () => {},
			} as unknown as Caller;
			void svc.waiters
				.add(caller, "watcher", "idle", agent.id, 5000)
				.then((r) => {
					woke = r;
				});
			await new Promise((r) => setTimeout(r, 10));
			expect(woke).toBe(null);
			await new Promise((r) => setTimeout(r, 80));
			expect((woke as { event?: string })?.event).toBe("idle");
			expect(updates).toContain("idle");
			expect(svc.registry.get(agent.id)?.status).toBe("idle");
			expect(svc.registry.statusSince(agent)).toBe(wentIdle);
		} finally {
			close();
		}
	});

	test("a driver reading applies the same hold, from the reading's own time", () => {
		const { svc, agent, row, close } = service();
		try {
			at(0);
			svc.registry.applyLiveStatus(agent, "busy", T0);
			at(3000);
			svc.registry.applyLiveStatus(agent, "idle", T0 + 2500);
			expect(row().state).toBe("busy");
			svc.registry.applyLiveStatus(agent, "busy", T0 + 3000);
			at(20_000);
			expect(row().state).toBe("busy");
			// A turn that ended long before it was read shows at once.
			svc.registry.applyLiveStatus(agent, "idle", T0 + 10_000);
			expect(row().state).toBe("idle");
			expect(row().stateSince).toBe(T0 + 10_000);
		} finally {
			close();
		}
	});

	test("a scan reading idle for a busy agent is held too", () => {
		const { svc, agent, row, close } = service();
		const scan = (status: "busy" | "idle") =>
			svc.registry.upsert({
				harness: agent.harness,
				sessionId: agent.sessionId,
				pid: agent.pid,
				cwd: null,
				project: null,
				branch: null,
				tags: [],
				meta: {},
				registered: false,
				status,
			});
		try {
			at(0);
			scan("busy");
			at(4000);
			scan("idle");
			expect(row().state).toBe("busy");
			at(6000);
			scan("busy");
			at(30_000);
			expect(row().state).toBe("busy");
			scan("idle");
			at(30_000 + SETTLE);
			expect(row().state).toBe("idle");
			expect(row().stateSince).toBe(T0 + 30_000);
		} finally {
			close();
		}
	});

	test("gone drops a held idle", () => {
		const { svc, agent, row, close } = service();
		try {
			at(0);
			svc.registry.setStatus(agent, "busy");
			svc.registry.setStatus(agent, "idle");
			svc.registry.markGone(agent);
			at(SETTLE * 2);
			expect(row().state).toBe("offline");
		} finally {
			close();
		}
	});
});
