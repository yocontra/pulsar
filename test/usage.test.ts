import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";
import {
	AcpUsageWriter,
	loadAcpUsage,
	saveAcpUsage,
} from "../src/usage/acp.ts";
import {
	cleanAgentUsage,
	type PoolUsage,
	range,
	Usage,
} from "../src/usage/index.ts";
import { type FileState, parseLine } from "../src/usage/parse.ts";
import {
	costOf,
	DEFAULT_PRICES,
	normalizeModel,
	priceFor,
	priceTable,
	tagLocal,
} from "../src/usage/prices.ts";
import {
	append,
	claudeLine,
	claudeUserLine,
	codexLines,
	piLines,
	rootsIn,
	write,
} from "./usage-fixtures.ts";

const HOUR = 3_600_000;
const NOW = Date.now();
const T = Math.floor((NOW - 2 * HOUR) / HOUR) * HOUR + 60_000;

let dir: string;
let store: Store;
let usage: Usage;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-usage-"));
	store = new Store(join(dir, "pulsar.db"));
	usage = new Usage(store, { roots: () => rootsIn(dir) });
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const claudeFile = (session: string, folder = "-work-app") =>
	join(dir, "claude", "projects", folder, `${session}.jsonl`);

function totals() {
	const u = usage.local("7d", 0);
	const sum = {
		input: 0,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
		output: 0,
		records: 0,
	};
	for (const r of u.rows)
		for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r[k];
	return sum;
}

function agent(harness: string, sessionId: string): Agent {
	return {
		id: `${harness}:${sessionId}`,
		harness,
		sessionId,
		pid: null,
		cwd: "/work/app",
	} as unknown as Agent;
}

describe("parsers", () => {
	test("Claude: one record per line, ids kept for dedupe, cache split by lifetime", () => {
		const s: FileState = {};
		const r = parseLine(
			"claude",
			claudeLine({
				id: "msg_1",
				t: T,
				input: 3,
				read: 100,
				w5m: 20,
				w1h: 7,
				output: 9,
			}),
			s,
		);
		expect(r).toMatchObject({
			model: "claude-opus-5-5",
			input: 3,
			cacheRead: 100,
			cacheWrite5m: 20,
			cacheWrite1h: 7,
			output: 9,
			dedupeId: "msg_1",
		});
		expect(s.cwd).toBe("/work/app");
		expect(s.context).toEqual({ used: 130, window: null });
		expect(parseLine("claude", claudeUserLine(T), s)).toBeNull();
		expect(parseLine("claude", "{not json", s)).toBeNull();
	});

	test("Claude: synthetic replies cost nothing", () => {
		expect(
			parseLine(
				"claude",
				claudeLine({ id: "x", t: T, model: "<synthetic>" }),
				{},
			),
		).toBeNull();
	});

	test("Codex: totals minus the previous totals; repeated events add nothing", () => {
		const lines = codexLines(T, "gpt-6.2", [
			[1000, 600, 50],
			[2500, 2000, 80],
		]);
		// Codex repeats a token_count with unchanged totals.
		lines.push(lines[3]!);
		const s: FileState = {};
		const recs = lines.map((l) => parseLine("codex", l, s)).filter(Boolean);
		expect(recs).toHaveLength(2);
		expect(recs[0]).toMatchObject({
			model: "gpt-6.2",
			input: 400,
			cacheRead: 600,
			output: 50,
		});
		expect(recs[1]).toMatchObject({ input: 100, cacheRead: 1400, output: 30 });
		expect(s.context).toEqual({ used: 1530, window: 400_000 });
		expect(s.cwd).toBe("/work/api");
	});

	test("pi/omp: usage per assistant message", () => {
		const s: FileState = {};
		const recs = piLines(T, "claude-haiku-5-5", [
			{ input: 4, output: 94, cacheRead: 10, cacheWrite: 300 },
		]).map((l) => parseLine("omp", l, s));
		expect(recs[1]).toMatchObject({
			model: "claude-haiku-5-5",
			input: 4,
			output: 94,
			cacheRead: 10,
			cacheWrite5m: 300,
		});
		expect(s.cwd).toBe("/work/tool");
	});
});

describe("scanner", () => {
	test("a file rewritten shorter is read again from the start; old ids stay counted once", async () => {
		const a = claudeFile("s-rw");
		write(a, [
			claudeLine({ id: "msg_1", t: T, input: 10 }),
			claudeLine({ id: "msg_2", t: T, input: 20 }),
			claudeLine({ id: "msg_3", t: T, input: 40 }),
		]);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 70, records: 3 });
		// Replaced by a shorter file: one old message and one new one.
		write(a, [
			claudeLine({ id: "msg_1", t: T, input: 10 }),
			claudeLine({ id: "msg_4", t: T, input: 80 }),
		]);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 150, records: 4 });
		const row = store.db
			.prepare("SELECT offset, size FROM usage_files WHERE path = ?")
			.get(a) as { offset: number; size: number };
		expect(row.offset).toBe(row.size);
		// Nothing new: nothing added.
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 150, records: 4 });
	});

	test("a scan stopped after a partial commit resumes with no line skipped or counted twice", async () => {
		// Lines of mixed length, some longer than a read chunk.
		const lines: string[] = [];
		for (let i = 0; i < 60; i++)
			lines.push(
				claudeLine({
					id: `msg_${i}`,
					t: T,
					input: 1,
					output: i,
					block: "y".repeat((i * 97) % 900),
				}),
			);
		write(claudeFile("s-resume"), lines);
		const day = new Date(T).toISOString().slice(0, 10).split("-");
		const thread = "01a1f571-0000-7000-8000-000000000001";
		const steps: [number, number, number][] = [];
		for (let i = 1; i <= 40; i++) steps.push([i * 1000, i * 600, i * 7]);
		write(
			join(dir, "codex", "sessions", ...day, `rollout-x-${thread}.jsonl`),
			codexLines(T, "gpt-6.2", steps),
		);
		const expected = {
			input: 60 + (40_000 - 24_000),
			cacheRead: 24_000,
			output: (59 * 60) / 2 + 280,
			records: 100,
		};
		// Small chunks and commits; the scan dies after its third commit.
		let commits = 0;
		const crashing = new Usage(store, {
			roots: () => rootsIn(dir),
			tuning: {
				chunkBytes: 256,
				commitBytes: 1024,
				onCommit: () => {
					if (++commits === 3) throw new Error("crash");
				},
			},
		});
		await expect(crashing.scanner.scan()).rejects.toThrow("crash");
		const partial = totals();
		expect(partial.records).toBeGreaterThan(0);
		expect(partial.records).toBeLessThan(100);
		const sizes = store.db.prepare("SELECT size FROM usage_files").all() as {
			size: number;
		}[];
		expect(sizes.some((r) => r.size === -1)).toBe(true);
		// The next scan (small chunks again) picks up where the commit left off.
		const resumed = new Usage(store, {
			roots: () => rootsIn(dir),
			tuning: { chunkBytes: 256, commitBytes: 1024 },
		});
		await resumed.scanner.scan();
		expect(totals()).toMatchObject(expected);
		await resumed.scanner.scan();
		expect(totals()).toMatchObject(expected);
		const codex = await resumed.localAgent(agent("codex", thread));
		expect(codex.tokens).toMatchObject({
			input: 16_000,
			cacheRead: 24_000,
			output: 280,
		});
	});

	test("duplicate message ids count once: in one file, across scans and across files", async () => {
		const a = claudeFile("s-a");
		// Claude writes one line per content block, same id and usage.
		write(a, [
			claudeLine({ id: "msg_1", t: T, input: 10, output: 5, block: "a" }),
			claudeLine({ id: "msg_1", t: T, input: 10, output: 5, block: "b" }),
			claudeUserLine(T),
		]);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 10, output: 5, records: 1 });
		// The next block of the same message lands after the scan.
		append(
			a,
			`${claudeLine({ id: "msg_1", t: T, input: 10, output: 5, block: "c" })}\n`,
		);
		// A resumed session copies the old line into a new file.
		write(claudeFile("s-b"), [
			claudeLine({ id: "msg_1", t: T, input: 10, output: 5 }),
			claudeLine({ id: "msg_2", t: T, input: 1, output: 2 }),
		]);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 11, output: 7, records: 2 });
	});

	test("a partial last line waits; a re-scan with nothing new adds nothing", async () => {
		const a = claudeFile("s-p");
		const done = claudeLine({ id: "msg_1", t: T, input: 10 });
		const next = claudeLine({ id: "msg_2", t: T, input: 20 });
		write(a, [done], next.slice(0, 40));
		await usage.scanner.scan();
		expect(totals().input).toBe(10);
		await usage.scanner.scan();
		expect(totals().input).toBe(10);
		append(a, `${next.slice(40)}\n`);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 30, records: 2 });
		const row = store.db
			.prepare("SELECT offset, size FROM usage_files WHERE path = ?")
			.get(a) as { offset: number; size: number };
		expect(row.offset).toBe(row.size);
	});

	test("a long file is read in chunks without losing lines at the edges", async () => {
		const a = claudeFile("s-long");
		const filler = "x".repeat(70_000);
		const lines: string[] = [];
		for (let i = 0; i < 40; i++)
			lines.push(
				claudeLine({
					id: `msg_${i}`,
					t: T,
					input: 1,
					output: 1,
					block: filler,
				}),
			);
		write(a, lines);
		await usage.scanner.scan();
		expect(totals()).toMatchObject({ input: 40, records: 40 });
	});

	test("subagent files count toward their parent session", async () => {
		write(claudeFile("parent"), [claudeLine({ id: "msg_p", t: T, input: 5 })]);
		write(
			join(
				dir,
				"claude",
				"projects",
				"-work-app",
				"parent",
				"subagents",
				"agent-a1.jsonl",
			),
			[claudeLine({ id: "msg_s", t: T, input: 7 })],
		);
		await usage.scanner.scan();
		const a = await usage.localAgent(agent("claude", "parent"));
		expect(a.tokens.input).toBe(12);
		expect(a.context?.used).toBe(5);
		expect(usage.local("7d", 0).sessions).toEqual([
			{ harness: "claude", count: 1 },
		]);
	});

	test("Codex, pi and omp files are found where those harnesses keep them", async () => {
		const day = new Date(T).toISOString().slice(0, 10).split("-");
		const thread = "01a1f571-f1a7-7a12-a14d-b85976acaa63";
		write(
			join(
				dir,
				"codex",
				"sessions",
				...day,
				`rollout-2026-11-19T13-14-07-${thread}.jsonl`,
			),
			codexLines(T, "gpt-6.2", [[1000, 600, 50]]),
		);
		write(
			join(
				dir,
				"pi",
				"sessions",
				"--work-tool--",
				"2026-11-17T17-21-14-650Z_pi1.jsonl",
			),
			piLines(T, "claude-haiku-5-5", [
				{ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			]),
		);
		write(
			join(
				dir,
				"omp",
				"sessions",
				"-work",
				"2026-11-17T23-07-31-190Z_omp1.jsonl",
			),
			piLines(T, "deepseek-v4.1-flash", [
				{ input: 3, output: 4, cacheRead: 0, cacheWrite: 0 },
			]),
		);
		write(
			join(
				dir,
				"omp",
				"sessions",
				"-work",
				"2026-11-17T23-07-31-190Z_omp1",
				"Helper.jsonl",
			),
			piLines(T, "deepseek-v4.1-flash", [
				{ input: 5, output: 6, cacheRead: 0, cacheWrite: 0 },
			]),
		);
		await usage.scanner.scan();
		const by = Object.fromEntries(
			usage.local("7d", 0).sessions.map((s) => [s.harness, s.count]),
		);
		expect(by).toEqual({ codex: 1, pi: 1, omp: 1 });
		const codex = await usage.localAgent(agent("codex", thread));
		expect(codex.tokens).toMatchObject({
			input: 400,
			cacheRead: 600,
			output: 50,
		});
		expect(codex.context).toEqual({ used: 1050, window: 400_000 });
		expect((await usage.localAgent(agent("omp", "omp1"))).tokens.input).toBe(8);
	});

	test("lines older than the window are not counted", async () => {
		write(claudeFile("old"), [
			claudeLine({ id: "old", t: NOW - 120 * 24 * HOUR, input: 99 }),
			claudeLine({ id: "new", t: T, input: 1 }),
		]);
		await usage.scanner.scan();
		expect(totals().input).toBe(1);
	});
});

describe("aggregation", () => {
	test("24h buckets by hour; longer periods by local day", async () => {
		write(claudeFile("agg"), [
			claudeLine({ id: "a", t: T, input: 1 }),
			claudeLine({ id: "b", t: T + 30 * 60_000, input: 2 }),
			claudeLine({ id: "c", t: T + HOUR, input: 4 }),
		]);
		await usage.scanner.scan();
		const hourly = usage.local("24h", 0);
		expect(hourly.rows.map((r) => r.input)).toEqual([3, 4]);
		expect(hourly.rows[0]!.t % HOUR).toBe(0);
		const tz = 330; // UTC+5:30
		const daily = usage.local("7d", tz);
		for (const r of daily.rows)
			expect((r.t + tz * 60_000) % (24 * HOUR)).toBe(0);
		expect(daily.rows.reduce((n, r) => n + r.input, 0)).toBe(7);
	});

	test("periods start at whole hours or local days", () => {
		const now = Date.UTC(2026, 10, 19, 15, 30);
		expect(range("24h", now, 0).from).toBe(Date.UTC(2026, 10, 18, 16));
		expect(range("7d", now, 0).from).toBe(Date.UTC(2026, 10, 13));
		expect(range("7d", now, -480).from).toBe(Date.UTC(2026, 10, 13, 8));
	});
});

describe("prices", () => {
	test("model ids match by longest prefix, after provider prefixes and dates", () => {
		const table = priceTable({});
		expect(normalizeModel("anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
		expect(normalizeModel("us.anthropic.claude-sonnet-4-6-20260101")).toBe(
			"claude-sonnet-4-6",
		);
		expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
		expect(priceFor("claude-opus-5-5", table)?.input).toBe(4);
		expect(priceFor("claude-opus-5", table)?.input).toBe(5);
		expect(priceFor("claude-opus-4-8", table)?.input).toBe(5);
		expect(priceFor("claude-sonnet-5-5", table)?.cacheRead).toBe(0.1);
		expect(priceFor("acme-coder-9", table)).toBeNull();
		// A prefix only matches at a dash: claude-opus-5 is not claude-opus-50.
		expect(priceFor("claude-opus-50", table)).toBeNull();
	});

	test("cost covers every token kind", () => {
		const p = DEFAULT_PRICES["claude-opus-5-5"]!;
		const c = costOf(
			{
				input: 1e6,
				output: 1e6,
				cacheRead: 1e6,
				cacheWrite5m: 1e6,
				cacheWrite1h: 1e6,
			},
			p,
		);
		expect(c).toBeCloseTo(4 + 20 + 0.2 + 5 + 8, 6);
	});

	test("an edited price applies to history; dropping the edit restores the default", async () => {
		write(claudeFile("px"), [
			claudeLine({ id: "a", t: T, input: 1e6, output: 0 }),
		]);
		await usage.scanner.scan();
		const self = { id: "m1", name: "studio" };
		let r = await usage.report("7d", 0, self, null);
		expect(r.rows[0]!.cost).toBeCloseTo(4, 6);
		usage.setPrice("claude-opus-5-5", {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite5m: 0,
			cacheWrite1h: 0,
		});
		r = await usage.report("7d", 0, self, null);
		expect(r.rows[0]!.cost).toBeCloseTo(1, 6);
		expect(r.prices.find((p) => p.model === "claude-opus-5-5")?.source).toBe(
			"custom",
		);
		usage.setPrice("claude-opus-5-5", null);
		r = await usage.report("7d", 0, self, null);
		expect(r.rows[0]!.cost).toBeCloseTo(4, 6);
		expect(() => usage.setPrice("x", { input: -1 })).toThrow();
	});

	test("unpriced models have no cost (not zero)", async () => {
		write(claudeFile("np"), [
			claudeLine({ id: "a", t: T, model: "mystery-1" }),
		]);
		await usage.scanner.scan();
		const r = await usage.report("7d", 0, { id: "m1", name: "studio" }, null);
		expect(r.rows[0]!.cost).toBeNull();
		expect(r.rows[0]).toMatchObject({
			tokenSource: "reported",
			costSource: "unavailable",
		});
		const a = usage.priceAgent(
			"claude:np",
			await usage.localAgent(agent("claude", "np")),
		);
		expect(a.cost).toBeNull();
		expect(a.costSources).toEqual(["unavailable"]);
	});
});

test("managed ACP usage records context and a cumulative amount without charging it twice", async () => {
	const old = process.env.PULSAR_HOME;
	process.env.PULSAR_HOME = dir;
	try {
		mkdirSync(join(dir, "acp"));
		const session = agent("antigravity", "managed");
		session.meta = { acp: "1" };
		const ref = { harness: session.harness, sessionId: "managed" };
		expect(
			usage.priceAgent(session.id, await usage.localAgent(session)),
		).toMatchObject({
			tokenSources: ["unavailable"],
			cost: null,
			costSources: ["unavailable"],
		});
		const writer = new AcpUsageWriter(ref, () => {});
		writer.add({
			used: 52,
			size: 1000,
			cost: { amount: 0.1, currency: "USD" },
		});
		writer.add({
			used: 58,
			size: 1000,
			cost: { amount: 0.4, currency: "USD" },
		});
		writer.add({ used: 60, size: 1000 });
		await writer.finish();
		const fromPeer = cleanAgentUsage(await usage.localAgent(session));
		const priced = usage.priceAgent(session.id, fromPeer);
		expect(priced).toMatchObject({
			cost: 0.4,
			context: { used: 60, window: 1000 },
			tokenSources: ["unavailable"],
			costSources: ["reported"],
		});
		expect(usage.local("24h", 0).rows).toHaveLength(0);
		await saveAcpUsage(ref, {
			used: 0,
			size: 1000,
			cost: { amount: 99, currency: "credits" },
		});
		expect(await loadAcpUsage(ref)).toEqual({
			context: { used: 0, window: 1000 },
			cost: null,
		});
		const adapter = { harness: "amp", sessionId: "adapter" };
		await saveAcpUsage(adapter, {
			used: 5,
			size: 1000,
			cost: { amount: 0.2, currency: "USD" },
		});
		expect((await loadAcpUsage(adapter))?.cost).toEqual({
			amount: 0.2,
			source: "reported",
		});
		await saveAcpUsage(ref, {
			used: 0,
			size: 0,
			cost: { amount: 0, currency: "USD" },
		});
		expect(await loadAcpUsage(ref)).toEqual({
			context: { used: 0, window: 1000 },
			cost: { amount: 0, source: "reported" },
		});
	} finally {
		if (old === undefined) delete process.env.PULSAR_HOME;
		else process.env.PULSAR_HOME = old;
	}
});

test("old peers retain native estimates, local inference and partial cost", () => {
	const tokens = {
		input: 100,
		cacheRead: 0,
		cacheWrite5m: 0,
		cacheWrite1h: 0,
		output: 3,
		records: 1,
	};
	const u = cleanAgentUsage({
		tokens,
		models: [
			{ ...tokens, model: "claude-sonnet-5-5" },
			{ ...tokens, model: tagLocal("llama") },
			{ ...tokens, model: "unknown" },
		],
		reportedCost: { amount: -1, source: "reported" },
	});
	expect(usage.priceAgent("peer/claude:old", u)).toMatchObject({
		cost: null,
		tokenSources: ["reported", "local"],
		costSources: ["estimated", "local", "unavailable"],
	});
});

describe("pool report", () => {
	test("sums peers' tokens, prices them here, and lists machines that did not answer", async () => {
		write(claudeFile("mine"), [
			claudeLine({ id: "a", t: T, input: 1e6, output: 0 }),
		]);
		await usage.scanner.scan();
		const pool: PoolUsage = {
			usage: async () => [
				{
					machineId: "m2",
					name: "mini",
					error: null,
					usage: {
						rows: [
							{
								harness: "codex",
								model: "claude-sonnet-5-5",
								t: T,
								input: 1e6,
								cacheRead: 0,
								cacheWrite5m: 0,
								cacheWrite1h: 0,
								output: 0,
								records: 3,
							},
						],
						sessions: [{ harness: "codex", count: 2 }],
						scannedAt: 1,
					},
				},
				{
					machineId: "m3",
					name: "laptop",
					error: "laptop is offline",
					usage: null,
				},
			],
			agentUsage: async () => {
				throw new Error("unused");
			},
		};
		const r = await usage.report("7d", 0, { id: "m1", name: "studio" }, pool);
		expect(r.machines).toEqual([
			{ id: "m1", name: "studio", error: null },
			{ id: "m2", name: "mini", error: null },
			{ id: "m3", name: "laptop", error: "laptop is offline" },
		]);
		const cost = r.rows.reduce((n, x) => n + (x.cost ?? 0), 0);
		expect(cost).toBeCloseTo(4 + 2, 6);
		expect(r.rows.map((r) => [r.tokenSource, r.costSource])).toEqual([
			["reported", "estimated"],
			["reported", "estimated"],
		]);
		expect(r.sessions).toEqual([
			{ machine: "m1", harness: "claude", count: 1 },
			{ machine: "m2", harness: "codex", count: 2 },
		]);
	});
});
