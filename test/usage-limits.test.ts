import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitState } from "../src/http/wire.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";
import { cleanLocalUsage, type PoolUsage, Usage } from "../src/usage/index.ts";
import { Limits, limitsOf, windowLabel } from "../src/usage/limits.ts";
import { parseLine } from "../src/usage/parse.ts";
import {
	claudeLimitLine,
	claudeLine,
	codexLimitLine,
	codexLines,
	piLimitLine,
	rootsIn,
	write,
} from "./usage-fixtures.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();
const RESET = NOW + 3 * DAY;

let dir: string;
let store: Store;
let usage: Usage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-limits-"));
	store = new Store(join(dir, "pulsar.db"));
	usage = new Usage(store, { roots: () => rootsIn(dir) });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const read = (harness: Parameters<typeof limitsOf>[0], line: string) =>
	limitsOf(harness, JSON.parse(line), line);

describe("what each harness writes", () => {
	test("Codex: each window's percent, length and reset time", () => {
		const [w] = read(
			"codex",
			codexLimitLine({ t: NOW, used: 88, resetsAt: RESET }),
		);
		expect(w).toEqual({
			harness: "codex",
			account: "codex",
			window: "m10080",
			label: "Weekly",
			usedPercent: 88,
			reached: false,
			resetsAt: Math.floor(RESET / 1000) * 1000,
			at: NOW,
			plan: "pro",
		});
		const both = read(
			"codex",
			codexLimitLine({
				t: NOW,
				used: 40,
				resetsAt: RESET,
				minutes: 10080,
				secondary: { used: 97, minutes: 300, resetsAt: NOW + HOUR },
			}),
		);
		expect(both.map((s) => [s.label, s.usedPercent])).toEqual([
			["Weekly", 40],
			["5-hour", 97],
		]);
	});

	test("Codex: a reached limit marks the fullest window", () => {
		const s = read(
			"codex",
			codexLimitLine({
				t: NOW,
				used: 60,
				resetsAt: RESET,
				secondary: { used: 99, minutes: 300, resetsAt: NOW + HOUR },
				reachedType: "rate_limit_reached",
			}),
		);
		expect(s.map((x) => [x.label, x.reached, x.usedPercent])).toEqual([
			["Weekly", false, 60],
			["5-hour", true, 100],
		]);
	});

	test("Claude Code: only the hard stop, with its window and reset", () => {
		const [w] = read("claude", claudeLimitLine({ t: NOW, resetsAt: RESET }));
		expect(w).toMatchObject({
			harness: "claude",
			window: "seven_day",
			label: "Weekly",
			usedPercent: 100,
			reached: true,
			resetsAt: Math.floor(RESET / 1000) * 1000,
		});
		const [x] = read(
			"claude",
			claudeLimitLine({
				t: NOW,
				resetsAt: RESET,
				type: "seven_day_overage_included",
			}),
		);
		expect(x!.label).toBe("Weekly (overage included)");
		// A busy-server 429 is not the plan's limit.
		const busy = JSON.parse(claudeLimitLine({ t: NOW, resetsAt: RESET }));
		delete busy.apiError;
		delete busy.quotaLimits;
		delete busy.apiErrorParams;
		expect(limitsOf("claude", busy)).toEqual([]);
	});

	test("pi and omp: a 429 usage-limit error, reset from retry-after; the message is not kept", () => {
		for (const h of ["pi", "omp"] as const) {
			const [w] = read(h, piLimitLine({ t: NOW, retryMs: 2 * DAY }));
			expect(w).toEqual({
				harness: h,
				account: "example-go",
				window: "weekly",
				label: "Weekly",
				usedPercent: 100,
				reached: true,
				resetsAt: NOW + 2 * DAY,
				at: NOW,
				plan: null,
			});
			expect(JSON.stringify(w)).not.toContain("example.com");
		}
		expect(
			read("omp", piLimitLine({ t: NOW, retryMs: 1, text: "429 slow down" })),
		).toEqual([]);
		expect(
			read("omp", piLimitLine({ t: NOW, retryMs: 1, status: 500 })),
		).toEqual([]);
	});

	test("lines without a limit read nothing; usage parsing is unchanged", () => {
		const seen: LimitState[] = [];
		const rec = parseLine("claude", claudeLine({ id: "m1", t: NOW }), {}, (s) =>
			seen.push(s),
		);
		expect(rec?.input).toBe(10);
		expect(seen).toEqual([]);
		// The hard-stop line costs nothing but still reports the limit.
		expect(
			parseLine(
				"claude",
				claudeLimitLine({ t: NOW, resetsAt: RESET }),
				{},
				(s) => seen.push(s),
			),
		).toBeNull();
		expect(seen).toHaveLength(1);
	});

	test("window names", () => {
		expect(windowLabel(300)).toBe("5-hour");
		expect(windowLabel(10080)).toBe("Weekly");
		expect(windowLabel(1440)).toBe("Daily");
		expect(windowLabel(null)).toBe("Usage");
	});
});

describe("scanner", () => {
	const codexFile = (name: string, t: number) => {
		const day = new Date(t).toISOString().slice(0, 10).split("-");
		return join(dir, "codex", "sessions", ...day, `rollout-${name}.jsonl`);
	};

	test("keeps the newest reading per window across files read in any order, and survives a restart", async () => {
		// Two parallel sessions: the file written last holds an older reading.
		write(codexFile("a-01a1f571-f1a7-7a12-a14d-b85976acaa63", NOW), [
			...codexLines(NOW - HOUR, "gpt-5", [[100, 0, 10]]),
			codexLimitLine({ t: NOW - 10 * MIN, used: 86, resetsAt: RESET }),
		]);
		write(codexFile("b-01a1f571-f1a7-7a12-a14d-b85976acaa64", NOW), [
			codexLimitLine({ t: NOW - 30 * MIN, used: 74, resetsAt: RESET }),
		]);
		write(join(dir, "claude", "projects", "-w", "s1.jsonl"), [
			claudeLimitLine({ t: NOW - DAY, resetsAt: NOW + HOUR }),
			// An old window that has reset since: not shown.
			claudeLimitLine({
				t: NOW - 8 * DAY,
				resetsAt: NOW - DAY,
				type: "five_hour",
			}),
		]);
		await usage.scanner.scan(NOW);
		const show = (u: Usage) =>
			u.limits
				.local(NOW)
				.map((s) => [s.harness, s.label, s.usedPercent])
				.sort();
		expect(show(usage)).toEqual([
			["claude", "Weekly", 100],
			["codex", "Weekly", 86],
		]);
		expect(usage.local("24h", 0, NOW).limits).toHaveLength(2);
		const again = new Usage(store, { roots: () => rootsIn(dir) });
		expect(show(again)).toEqual(show(usage));
	});

	test("an agent's usage carries its harness's limits", async () => {
		write(codexFile("c-01a1f571-f1a7-7a12-a14d-b85976acaa65", NOW), [
			codexLimitLine({ t: NOW - MIN, used: 91, resetsAt: RESET }),
		]);
		await usage.scanner.scan(NOW);
		const a = (harness: string) =>
			({
				id: `${harness}:s`,
				harness,
				sessionId: "s",
				cwd: "/w",
			}) as unknown as Agent;
		expect(usage.localAgent(a("codex")).limits?.[0]?.usedPercent).toBe(91);
		expect(usage.localAgent(a("claude")).limits).toEqual([]);
	});
});

describe("warnings", () => {
	const codex = (used: number, o: Partial<LimitState> = {}): LimitState => ({
		harness: "codex",
		account: "codex",
		window: "m10080",
		label: "Weekly",
		usedPercent: used,
		reached: used >= 100,
		resetsAt: RESET,
		at: NOW,
		plan: "pro",
		...o,
	});
	const levels = (l: Limits, s: LimitState[], now = NOW) =>
		l.check(s, now).map((w) => (w.reached ? "reached" : w.level));

	test("once per threshold per window; a new window starts over", () => {
		const l = new Limits(store);
		expect(levels(l, [codex(70)])).toEqual([]);
		expect(levels(l, [codex(82)])).toEqual([80]);
		expect(levels(l, [codex(85)])).toEqual([]);
		expect(levels(l, [codex(96)])).toEqual([95]);
		expect(levels(l, [codex(99)])).toEqual([]);
		expect(levels(l, [codex(100)])).toEqual(["reached"]);
		expect(levels(l, [codex(100)])).toEqual([]);
		// Codex's reset time moves by a second: the same window.
		expect(levels(l, [codex(100, { resetsAt: RESET + 1000 })])).toEqual([]);
		const next = RESET + 7 * DAY;
		expect(
			levels(
				l,
				[codex(81, { resetsAt: next, at: RESET + HOUR })],
				RESET + HOUR,
			),
		).toEqual([80]);
	});

	test("a jump past two thresholds warns once, at the higher one", () => {
		const l = new Limits(store);
		expect(levels(l, [codex(70)])).toEqual([]);
		expect(levels(l, [codex(97)])).toEqual([95]);
		expect(levels(l, [codex(98)])).toEqual([]);
	});

	test("a restart does not warn again; lowering a threshold does not repeat one", () => {
		expect(levels(new Limits(store), [codex(88)])).toEqual([80]);
		const after = new Limits(store);
		expect(levels(after, [codex(88)])).toEqual([]);
		after.setSettings({ thresholds: [50, 85] });
		expect(levels(after, [codex(88)])).toEqual([85]);
		after.setSettings({ thresholds: [60] });
		expect(levels(after, [codex(89)])).toEqual([]);
	});

	test("off, old readings and reset windows warn nothing", () => {
		const l = new Limits(store);
		l.setSettings({ enabled: false });
		expect(levels(l, [codex(99)])).toEqual([]);
		l.setSettings({ enabled: true });
		// Replayed history on a new database.
		expect(levels(l, [codex(99, { at: NOW - 7 * HOUR })])).toEqual([]);
		expect(levels(l, [codex(99, { resetsAt: NOW - MIN })])).toEqual([]);
		expect(levels(l, [codex(99)])).toEqual([95]);
	});

	test("the same account on two machines warns once; hard stops of other harnesses warn too", () => {
		const l = new Limits(store);
		expect(
			levels(l, [
				codex(90),
				codex(91, { resetsAt: RESET - 1000, at: NOW - MIN }),
			]),
		).toEqual([80]);
		const claude: LimitState = {
			...codex(100),
			harness: "claude",
			account: "",
			window: "seven_day",
		};
		expect(levels(l, [claude])).toEqual(["reached"]);
	});

	test("settings are checked", () => {
		const l = new Limits(store);
		expect(l.settings()).toEqual({ enabled: true, thresholds: [80, 95] });
		expect(l.setSettings({ thresholds: [95, 80, 95] }).thresholds).toEqual([
			80, 95,
		]);
		for (const bad of [[], [0], [100], [50.5], [1, 2, 3, 4]])
			expect(() => l.setSettings({ thresholds: bad })).toThrow("thresholds");
	});

	test("pool: peers' readings warn here and show in the report with their machine", async () => {
		const peer = codex(96, { at: NOW - MIN });
		const pool: PoolUsage = {
			usage: async () => [
				{
					machineId: "m2",
					name: "studio",
					usage: cleanLocalUsage({
						rows: [],
						sessions: [],
						scannedAt: NOW,
						limits: [peer, { junk: true }],
					}),
					error: null,
				},
			],
			agentUsage: async () => {
				throw new Error("unused");
			},
		};
		const w = await usage.limitWarnings(pool, NOW);
		expect(w).toEqual([
			{
				harness: "codex",
				label: "Weekly",
				level: 95,
				reached: false,
				usedPercent: 96,
				resetsAt: RESET,
			},
		]);
		// Without asking again, the peer's last answer counts (and is not warned twice).
		expect(await usage.limitWarnings(null, NOW)).toEqual([]);
		const r = await usage.report("7d", 0, { id: "m1", name: "here" }, pool);
		expect(r.limits).toEqual([{ ...peer, machine: "m2" }]);
		expect(r.limitSettings).toEqual({ enabled: true, thresholds: [80, 95] });
		expect(usage.limitsView("m1", NOW).limits).toEqual([
			{ ...peer, machine: "m2" },
		]);
	});
});
