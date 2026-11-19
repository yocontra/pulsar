import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { cleanFedAgent, PoolState } from "../src/federation/state.ts";
import { PulsarService } from "../src/service/index.ts";
import type { PoolView } from "../src/service/pool.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";

const T0 = Date.parse("2026-11-18T05:00:00Z");
const MIN = 60_000;

function service() {
	const store = new Store(":memory:");
	const svc = new PulsarService({ store, scan: false, machine: "t" });
	return {
		svc,
		close: () => {
			svc.stop();
			store.close();
		},
	};
}

function local(svc: PulsarService) {
	return svc.registry.upsert({
		harness: "pi",
		sessionId: "s1",
		pid: null,
		cwd: null,
		project: null,
		branch: null,
		tags: [],
		meta: {},
		registered: true,
	});
}

afterEach(() => setSystemTime());

describe("stateSince is when the state changed, not when a row was built", () => {
	test("local busy/idle changes keep their own times while no one watches", () => {
		const { svc, close } = service();
		try {
			setSystemTime(new Date(T0));
			const a = local(svc);
			svc.registry.setStatus(a, "busy");
			setSystemTime(new Date(T0 + 3 * MIN));
			svc.registry.setStatus(a, "idle");
			// The first row is built 40 minutes later.
			setSystemTime(new Date(T0 + 43 * MIN));
			const row = svc.app.views.row(a);
			expect(row.state).toBe("idle");
			expect(row.stateSince).toBe(T0 + 3 * MIN);
			// Same status again (an extension resending it) keeps the time.
			svc.registry.setStatus(a, "idle");
			expect(svc.app.views.row(a).stateSince).toBe(T0 + 3 * MIN);
			setSystemTime(new Date(T0 + 50 * MIN));
			svc.registry.setStatus(a, "busy");
			setSystemTime(new Date(T0 + 53 * MIN));
			expect(svc.app.views.row(a).stateSince).toBe(T0 + 50 * MIN);
		} finally {
			close();
		}
	});

	test("unknown to idle is no change: both show as idle", () => {
		const { svc, close } = service();
		try {
			setSystemTime(new Date(T0));
			const a = local(svc);
			expect(a.status).toBe("unknown");
			setSystemTime(new Date(T0 + 5 * MIN));
			svc.registry.setStatus(a, "idle");
			expect(svc.app.views.row(a).stateSince).toBe(T0);
		} finally {
			close();
		}
	});

	test("needs-you is timed from the prompt", () => {
		const { svc, close } = service();
		try {
			setSystemTime(new Date(T0));
			const a = local(svc);
			setSystemTime(new Date(T0 + 2 * MIN));
			svc.registry.setNeedsYou(a.id, { reason: "approval", detail: null });
			setSystemTime(new Date(T0 + 9 * MIN));
			const row = svc.app.views.row(a);
			expect(row.state).toBe("needs-you");
			expect(row.stateSince).toBe(T0 + 2 * MIN);
		} finally {
			close();
		}
	});

	test("remote agents use the home node's time, or the link change when unreachable", () => {
		const { svc, close } = service();
		try {
			setSystemTime(new Date(T0 + 30 * MIN));
			const remote: Agent = {
				...local(svc),
				id: "mb/pi:s9",
				status: "busy",
				meta: { machineId: "mb", localId: "pi:s9" },
			};
			let link: "tailnet" | "asleep" = "tailnet";
			let sent: number | null = T0 + 7 * MIN;
			svc.registry.pool = {
				machineId: "ma",
				agents: () => [remote],
				version: () => 1,
				needsYou: () => null,
				wake: () => "wakes",
				hasTranscript: () => false,
				canStop: () => false,
				statusSince: () => sent,
				machine: () => ({
					machineId: "mb",
					name: "b",
					link,
					linkSince: T0 + 20 * MIN,
					agents: 1,
				}),
			} as unknown as PoolView;
			const views = svc.app.views;
			expect(views.row(remote).stateSince).toBe(T0 + 7 * MIN);
			link = "asleep";
			const off = views.row(remote);
			expect(off.state).toBe("offline");
			expect(off.stateSince).toBe(T0 + 20 * MIN);
			// An older home node sends no time: noticed as rows are built.
			link = "tailnet";
			sent = null;
			expect(views.row(remote).stateSince).toBe(T0 + 30 * MIN);
		} finally {
			close();
		}
	});
});

describe("federation carries the times", () => {
	test("statusSince survives cleaning; a bad one is dropped", () => {
		const rec = { id: "a", name: "a", harness: "pi", status: "busy" };
		expect(cleanFedAgent({ ...rec, statusSince: T0 })?.statusSince).toBe(T0);
		expect(cleanFedAgent({ ...rec, statusSince: "x" })?.statusSince).toBe(
			undefined,
		);
		expect(cleanFedAgent(rec)?.statusSince).toBe(undefined);
	});

	test("a peer's link change is timed", () => {
		setSystemTime(new Date(T0));
		const state = new PoolState();
		const peer = state.upsert(
			{
				nodeId: "n",
				name: "b",
				dnsName: "b.x.ts.net",
				userId: "u",
				login: "me",
				tags: [],
				online: true,
			},
			{
				fedProtocol: [1, 1],
				features: [],
				pulsarVersion: "x",
				machineId: "mb",
				name: "b",
			},
			1,
		);
		setSystemTime(new Date(T0 + 4 * MIN));
		state.setLink(peer, "tailnet");
		expect(state.machine(peer).linkSince).toBe(T0 + 4 * MIN);
		setSystemTime(new Date(T0 + 6 * MIN));
		state.setLink(peer, "tailnet");
		expect(state.machine(peer).linkSince).toBe(T0 + 4 * MIN);
	});

	test("the home node publishes its status time", async () => {
		const { svc, close } = service();
		try {
			setSystemTime(new Date(T0));
			const a = local(svc);
			setSystemTime(new Date(T0 + MIN));
			svc.registry.setStatus(a, "busy");
			const { LocalFeed } = await import("../src/federation/local.ts");
			const feed = new LocalFeed(svc);
			feed.tick();
			const rec = feed.snapshot().agents.find((x) => x.id === a.id);
			expect(rec?.statusSince).toBe(T0 + MIN);
		} finally {
			close();
		}
	});
});
