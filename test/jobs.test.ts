import { describe, expect, test } from "bun:test";
import { Limiter } from "../src/exec.ts";
import { Jobs, LagMonitor } from "../src/service/jobs.ts";
import { topFrames } from "../src/service/lag-probe.ts";
import { burnCpu, until } from "./loop-probe.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const block = (ms: number) => {
	const end = performance.now() + ms;
	while (performance.now() < end) {}
};

describe("background jobs", () => {
	test("a slow job never overlaps itself and backs off", async () => {
		const jobs = new Jobs(() => {});
		let active = 0;
		let maxActive = 0;
		const starts: number[] = [];
		const ends: number[] = [];
		jobs.every(
			"slow",
			20,
			async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				starts.push(performance.now());
				await sleep(100);
				ends.push(performance.now());
				active--;
			},
			{ runNow: true },
		);
		// However late a loaded machine runs the timers, a second run comes.
		await until(() => starts.length >= 2, 10_000, "a second run");
		jobs.stop();
		expect(maxActive).toBe(1);
		// 100 ms runs, then 4x that before the next (timers fire late under
		// load, never early): one wait of 400 ms or more, not 20 ms intervals.
		const s = jobs.stats()[0]!;
		expect(s.nextMs).toBeGreaterThanOrEqual(400);
		expect(starts[1]! - ends[0]!).toBeGreaterThanOrEqual(400 - 1);
	}, 30_000);

	test("a job that blocks before its first await is named in the log", async () => {
		const lines: string[] = [];
		const jobs = new Jobs((l) => lines.push(l));
		// 250 ms of CPU, however long a loaded machine makes that take: over
		// the 200 ms warning either way.
		jobs.every("hog", 10_000, () => burnCpu(250), { runNow: true });
		jobs.stop();
		const m = lines
			.join("\n")
			.match(
				/job hog blocked it (\d+) ms before its first await \((starved: )?(\d+) ms of CPU\)/,
			);
		expect(m).not.toBeNull();
		const [, wallMs, starved, cpuMs] = m!;
		// The CPU it spent is reported: this job's JS, not something else.
		expect(Number(cpuMs)).toBeGreaterThanOrEqual(240);
		// "starved" only when the OS, not the job, held the time: on an idle
		// machine never; at load 150 the job may get under a third of the wall.
		// (Both are rounded in the log: skip the check right at the boundary.)
		if (Math.abs(Number(cpuMs) - Number(wallMs) * 0.3) > 2)
			expect(Boolean(starved)).toBe(Number(cpuMs) < Number(wallMs) * 0.3);
	}, 30_000);

	test("a failing job is logged and runs again", async () => {
		const lines: string[] = [];
		const jobs = new Jobs((l) => lines.push(l));
		let runs = 0;
		jobs.every(
			"flaky",
			10,
			() => {
				runs++;
				throw new Error("boom");
			},
			{ runNow: true },
		);
		await until(() => runs > 1, 10_000, "a second run");
		jobs.stop();
		expect(lines[0]).toContain("job flaky failed: boom");
	}, 30_000);
});

describe("event-loop lag monitor", () => {
	test("a stall is logged with the jobs running at the time", async () => {
		const lines: string[] = [];
		const lag = new LagMonitor(
			() => ["scan:claude"],
			200,
			(l) => lines.push(l),
		);
		lag.start();
		await sleep(150);
		block(400);
		await sleep(150);
		lag.stop();
		const s = lag.stats();
		expect(s.stalls).toBeGreaterThanOrEqual(1);
		expect(s.lastStall?.culprit).toBe("scan:claude");
		expect(s.max).toBeGreaterThanOrEqual(300);
		// A busy loop is JS work (on a machine so loaded that the OS took the
		// CPU away meanwhile, starvation); never GC.
		expect(["busy", "starved"]).toContain(s.lastStall?.cause?.kind ?? "");
		expect(lines[0]).toMatch(
			/event loop: blocked \d+ ms \(running: scan:claude; (busy|starved): \d+ ms of CPU/,
		);
	});
});

describe("child-process limiter", () => {
	test("runs at most N at once, the rest in order", async () => {
		const l = new Limiter(2);
		let active = 0;
		let maxActive = 0;
		const order: number[] = [];
		await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				l.run(async () => {
					active++;
					maxActive = Math.max(maxActive, active);
					await sleep(20);
					order.push(i);
					active--;
				}),
			),
		);
		expect(maxActive).toBe(2);
		expect(order).toEqual([0, 1, 2, 3, 4]);
	});
});

describe("stall profile", () => {
	test("top self-time frames come from the profile's last window only", () => {
		const frame = (id: number, functionName: string, url = "") => ({
			id,
			callFrame: { functionName, url, lineNumber: 9 },
		});
		const profile = {
			nodes: [
				frame(1, "(root)"),
				frame(2, "parseJson", "file:///x/dist/registry.js"),
				frame(3, "(garbage collector)"),
				frame(4, "old"),
			],
			endTime: 0,
			// 300 ms of "old", then 200 ms parseJson and 100 ms GC (5 ms samples).
			samples: [
				...Array(60).fill(4),
				...Array(40).fill(2),
				...Array(20).fill(3),
			],
			timeDeltas: Array(120).fill(5000),
		};
		expect(topFrames(profile, 300)).toEqual([
			"parseJson (registry.js:10) 200 ms",
			"(garbage collector) 100 ms",
		]);
	});
});
