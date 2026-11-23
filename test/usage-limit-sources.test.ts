/**
 * Limit readings outside session files (src/usage/limit-sources.ts):
 * Claude Code's cached `/usage` answer and OpenCode Go hard stops in
 * OpenCode's database. All samples are synthetic.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import { Usage } from "../src/usage/index.ts";
import {
	claudeCachedLimits,
	opencodeLimit,
	readOpencodeLimits,
} from "../src/usage/limit-sources.ts";
import { rootsIn } from "./usage-fixtures.ts";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.now();

/** A `.claude.json` shaped like Claude Code's, with made-up values. */
function claudeState(o: {
	fetchedAt: number;
	five?: number | null;
	week?: number;
	opus?: number;
}) {
	const win = (pct: number, resetIn: number) => ({
		utilization: pct,
		resets_at: new Date(NOW + resetIn).toISOString(),
		limit_dollars: null,
		used_dollars: null,
	});
	return {
		numStartups: 3,
		oauthAccount: {
			accountUuid: "00000000-0000-4000-8000-000000000001",
			emailAddress: "someone@example.test",
			organizationName: "Example Org",
			planDisplayName: "Test Plan",
		},
		cachedUsageUtilization: {
			fetchedAtMs: o.fetchedAt,
			accountUuid: "00000000-0000-4000-8000-000000000001",
			utilization: {
				five_hour: o.five == null ? null : win(o.five, 2 * HOUR),
				seven_day: o.week == null ? null : win(o.week, 3 * DAY),
				seven_day_opus: o.opus == null ? null : win(o.opus, 3 * DAY),
				seven_day_sonnet: null,
				some_internal_name: win(99, DAY),
				extra_usage: { is_enabled: false, utilization: 12 },
				limits: [{ kind: "weekly_all", percent: o.week ?? 0 }],
			},
		},
	};
}

describe("Claude Code's cached /usage", () => {
	test("each named window's percent, reset and the plan name", () => {
		const out = claudeCachedLimits(
			claudeState({ fetchedAt: NOW - HOUR, five: 41, week: 83, opus: 100 }),
		);
		expect(out).toEqual([
			{
				harness: "claude",
				account: "",
				window: "five_hour",
				label: "5-hour",
				usedPercent: 41,
				reached: false,
				resetsAt: expect.any(Number),
				at: NOW - HOUR,
				plan: "Test Plan",
			},
			{
				harness: "claude",
				account: "",
				window: "seven_day",
				label: "Weekly",
				usedPercent: 83,
				reached: false,
				resetsAt: expect.any(Number),
				at: NOW - HOUR,
				plan: "Test Plan",
			},
			{
				harness: "claude",
				account: "",
				window: "seven_day_opus",
				label: "Weekly (opus)",
				usedPercent: 100,
				reached: true,
				resetsAt: expect.any(Number),
				at: NOW - HOUR,
				plan: "Test Plan",
			},
		]);
		expect(Math.abs(out[0]!.resetsAt! - (NOW + 2 * HOUR))).toBeLessThan(1000);
		// Nothing about the account but the plan's name.
		const text = JSON.stringify(out);
		expect(text).not.toContain("example.test");
		expect(text).not.toContain("Example Org");
		expect(text).not.toContain("00000000");
	});

	test("no cache, a null window or a bad shape: nothing", () => {
		expect(claudeCachedLimits({ numStartups: 1 })).toEqual([]);
		expect(claudeCachedLimits(null)).toEqual([]);
		expect(claudeCachedLimits({ cachedUsageUtilization: "x" })).toEqual([]);
		expect(
			claudeCachedLimits(claudeState({ fetchedAt: NOW, five: null, week: 5 })),
		).toHaveLength(1);
	});
});

describe("OpenCode Go hard stops", () => {
	const row = (o: Partial<Parameters<typeof opencodeLimit>[0]>) => ({
		t: NOW,
		provider: "opencode-go",
		errorType: "provider.go-limit",
		retryAfterMs: 3 * DAY,
		message:
			"OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage.",
		...o,
	});

	test("the window from the message and the reset from retryAfterMs", () => {
		expect(opencodeLimit(row({}))).toEqual({
			harness: "opencode",
			account: "opencode-go",
			window: "weekly",
			label: "Weekly",
			usedPercent: 100,
			reached: true,
			resetsAt: NOW + 3 * DAY,
			at: NOW,
			plan: null,
		});
		expect(
			opencodeLimit(
				row({ message: "OpenCode Go monthly usage limit reached." }),
			)?.label,
		).toBe("Monthly");
		expect(
			opencodeLimit(
				row({ message: "OpenCode Go rolling usage limit reached." }),
			)?.window,
		).toBe("rolling");
	});

	test("unknown wording: a usage limit without a reset when none is given", () => {
		const l = opencodeLimit(
			row({ message: "Limit reached.", retryAfterMs: null }),
		);
		expect(l?.window).toBe("usage");
		expect(l?.label).toBe("Usage");
		expect(l?.resetsAt).toBeNull();
	});

	test("an overloaded server, no funds or another error is not a plan limit", () => {
		for (const errorType of [
			"provider.rate-limit",
			"provider.quota",
			"provider.free-limit",
			"aborted",
			null,
		])
			expect(opencodeLimit(row({ errorType }))).toBeNull();
	});
});

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-limit-src-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** An OpenCode 2 database with only the table Pulsar reads. */
function opencodeDb(path: string) {
	mkdirSync(join(path, ".."), { recursive: true });
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE session_message (
	id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
	seq INTEGER NOT NULL, time_created INTEGER NOT NULL,
	time_updated INTEGER NOT NULL, data TEXT NOT NULL)`);
	let seq = 0;
	const add = (type: string, t: number, data: object) =>
		db
			.prepare("INSERT INTO session_message VALUES (?, 'ses_1', ?, ?, ?, ?, ?)")
			.run(`msg_${++seq}`, type, seq, t, t, JSON.stringify(data));
	const stop = (t: number, period = "weekly") =>
		add("assistant", t, {
			time: { created: t },
			model: { id: "m", providerID: "opencode-go" },
			outcome: "failed",
			error: {
				type: "provider.go-limit",
				message: `OpenCode Go ${period} usage limit reached. See https://example.test/x`,
				status: 429,
				retryAfterMs: 2 * DAY,
			},
		});
	const answer = (t: number, provider = "opencode-go") =>
		add("assistant", t, {
			time: { created: t, completed: t },
			model: { id: "m", providerID: provider },
			finish: "stop",
			content: [],
		});
	return { db, add, stop, answer };
}

describe("reading OpenCode's database", () => {
	test("new stops and answers since the cursor; read-only; nothing twice", () => {
		const path = join(dir, "opencode", "opencode.db");
		const oc = opencodeDb(path);
		oc.stop(NOW - 20 * DAY); // before the first read's window
		oc.answer(NOW - 2 * HOUR);
		oc.stop(NOW - HOUR);
		oc.add("user", NOW - 30 * MIN, { text: "hi" });
		const first = readOpencodeLimits(path, null, NOW, 8 * DAY);
		expect(first.limits).toHaveLength(1);
		expect(first.limits[0]).toMatchObject({
			harness: "opencode",
			account: "opencode-go",
			window: "weekly",
			reached: true,
			at: NOW - HOUR,
			resetsAt: NOW - HOUR + 2 * DAY,
		});
		expect(JSON.stringify(first.limits)).not.toContain("example.test");
		expect(first.answered.get("opencode\0opencode-go")).toBe(NOW - 2 * HOUR);
		expect(first.cursor).toBe(4);

		const again = readOpencodeLimits(path, first.cursor, NOW, 8 * DAY);
		expect(again.limits).toEqual([]);
		expect(again.answered.size).toBe(0);

		oc.answer(NOW - 10 * MIN);
		const later = readOpencodeLimits(path, first.cursor, NOW, 8 * DAY);
		expect(later.answered.get("opencode\0opencode-go")).toBe(NOW - 10 * MIN);
		expect(later.cursor).toBe(5);
		oc.db.close();
	});

	test("no database, or an older OpenCode without session_message: nothing", () => {
		const missing = readOpencodeLimits(join(dir, "none.db"), null, NOW, DAY);
		expect(missing.limits).toEqual([]);
		expect(missing.cursor).toBeNull();
		const old = join(dir, "old.db");
		const db = new DatabaseSync(old);
		db.exec("CREATE TABLE message (id TEXT, data TEXT)");
		db.close();
		expect(readOpencodeLimits(old, 7, NOW, DAY)).toMatchObject({
			limits: [],
			cursor: 7,
		});
	});
});

describe("the scanner", () => {
	let store: Store;
	let usage: Usage;

	beforeEach(() => {
		store = new Store(join(dir, "pulsar.db"));
		usage = new Usage(store, { roots: () => rootsIn(dir) });
	});

	afterEach(() => store.close());

	const writeClaude = (state: object) => {
		mkdirSync(join(dir, "claude"), { recursive: true });
		writeFileSync(join(dir, "claude", ".claude.json"), JSON.stringify(state));
	};

	test("shows Claude Code's percentages and OpenCode's stop until it answers", async () => {
		writeClaude(claudeState({ fetchedAt: NOW - 5 * MIN, five: 30, week: 85 }));
		const oc = opencodeDb(join(dir, "opencode", "opencode.db"));
		oc.answer(NOW - 3 * HOUR);
		oc.stop(NOW - HOUR, "monthly");
		let stored = 0;
		usage.scanner.onStored = () => stored++;
		await usage.scanner.scan(NOW);
		expect(stored).toBe(1);
		const local = usage.limits.local(NOW);
		expect(
			local.map((l) => `${l.harness} ${l.label} ${l.usedPercent}`),
		).toEqual(["claude 5-hour 30", "claude Weekly 85", "opencode Monthly 100"]);
		expect(usage.limits.forHarness("opencode", NOW)).toHaveLength(1);
		// 85% passes the 80% threshold; the stop is a reached limit.
		expect(
			usage.limits.check(local, NOW).map((w) => `${w.harness} ${w.level}`),
		).toEqual(["claude 80", "opencode 100"]);

		// Nothing new: no store, no change.
		await usage.scanner.scan(NOW + MIN);
		expect(stored).toBe(1);

		// OpenCode answers again (extra usage): the stop is over.
		oc.answer(NOW - 10 * MIN);
		await usage.scanner.scan(NOW + 2 * MIN);
		expect(stored).toBe(2);
		expect(usage.limits.forHarness("opencode", NOW)).toEqual([]);
		oc.db.close();
	});

	test("an old Claude Code reading shows on Usage but not in the session header", async () => {
		writeClaude(claudeState({ fetchedAt: NOW - 2 * DAY, week: 90 }));
		await usage.scanner.scan(NOW);
		expect(usage.limits.local(NOW)).toHaveLength(1);
		expect(usage.limits.forHarness("claude", NOW)).toEqual([]);
		// Too old to warn.
		expect(usage.limits.check(usage.limits.local(NOW), NOW)).toEqual([]);
	});

	test("a newer /usage replaces the reading", async () => {
		writeClaude(claudeState({ fetchedAt: NOW - 30 * MIN, week: 50 }));
		await usage.scanner.scan(NOW);
		writeClaude(claudeState({ fetchedAt: NOW - 10 * MIN, week: 60 }));
		await usage.scanner.scan(NOW + MIN);
		const [l] = usage.limits.local(NOW);
		expect(l?.usedPercent).toBe(60);
		expect(usage.limits.local(NOW)).toHaveLength(1);
	});
});
