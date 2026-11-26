import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTS } from "../src/harnesses/ident.ts";
import {
	CLIENTS,
	DRIVERS,
	driverFor,
	driverForProcess,
	harnessIds,
	PSEUDO_HARNESSES,
} from "../src/harnesses/index.ts";
import type { Action, SetupContext } from "../src/setup/actions.ts";
import { loadJsonc } from "../src/setup/jsonc.ts";
import type { Agent } from "../src/types.ts";

// Contract every driver in DRIVERS must meet. Nothing here applies a setup
// action, runs a scan, delivers a message or calls a harness CLI.

// Drivers read their configs under $HOME when they plan; give them an empty one
// for this file only (bun runs every test file in one process).
let realHome: string | undefined;
let fakeHome: string;
beforeAll(() => {
	realHome = process.env.HOME;
	fakeHome = mkdtempSync(join(tmpdir(), "pulsar-contract-home-"));
	process.env.HOME = fakeHome;
});
afterAll(() => {
	if (realHome === undefined) delete process.env.HOME;
	else process.env.HOME = realHome;
	rmSync(fakeHome, { recursive: true, force: true });
});

const UNRELATED = [
	"node server.js",
	"/bin/zsh -l",
	"vim notes.txt",
	"/usr/sbin/sshd -D",
	"python3 -m http.server",
];

const ctx = (over: Partial<SetupContext> = {}): SetupContext => ({
	node: "/fake/bin/node",
	installDir: "/fake/pulsar/current",
	cli: "/fake/pulsar/current/dist/cli.js",
	skillSource: "/fake/pulsar/current/skills/pulsar",
	mcp: true,
	skillsDir: null,
	...over,
});

function agentOf(harness: string): Agent {
	return {
		id: `${harness}:s1`,
		name: `${harness}@x`,
		harness,
		sessionId: "s1",
		pid: 4242,
		cwd: "/tmp",
		project: null,
		branch: null,
		tags: [],
		status: "idle",
		model: null,
		activity: null,
		inbound: "accept",
		registered: false,
		reach: "pull",
		lastSeen: 0,
		createdAt: 0,
		meta: { socket: "/tmp/none.sock" },
	};
}

function expectWellFormed(action: Action, id: string) {
	expect(action.client).toBe(id);
	expect(typeof action.describe).toBe("string");
	expect(action.describe.length).toBeGreaterThan(0);
	expect(typeof action.apply).toBe("function");
	const u = action.undo;
	switch (u.type) {
		case "json":
			expect(typeof u.file).toBe("string");
			expect(u.path.length).toBeGreaterThan(0);
			for (const k of u.path) expect(typeof k).toBe("string");
			break;
		case "cli":
			expect(u.cmd.length).toBeGreaterThan(0);
			for (const a of u.args) expect(typeof a).toBe("string");
			break;
		case "dir":
			expect(u.path.length).toBeGreaterThan(0);
			break;
		case "hook":
			expect(typeof u.file).toBe("string");
			expect(u.event.length).toBeGreaterThan(0);
			expect(u.marker.length).toBeGreaterThan(0);
			break;
		default:
			throw new Error(`unknown undo ${JSON.stringify(u)}`);
	}
	// Undo records are saved to setup.json, so they must survive JSON.
	expect(JSON.parse(JSON.stringify(u))).toEqual(u);
}

beforeAll(async () => {
	await loadJsonc();
});

describe("registry", () => {
	test("ids are unique, lowercase, and not pseudo-harnesses", () => {
		const ids = DRIVERS.map((d) => d.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of ids) {
			expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
			expect(PSEUDO_HARNESSES as readonly string[]).not.toContain(id);
		}
		expect(harnessIds()).toEqual([...ids, ...PSEUDO_HARNESSES]);
	});

	test("driverFor finds each driver; unknown ids find none", () => {
		for (const d of DRIVERS) expect(driverFor(d.id)).toBe(d);
		expect(driverFor("cli")).toBeNull();
		expect(driverFor("unknown")).toBeNull();
		expect(driverFor("no-such-harness")).toBeNull();
	});

	test("unrelated command lines match no driver", () => {
		for (const args of UNRELATED) expect(driverForProcess(args)).toBeNull();
	});

	test("CLIENTS are the drivers with setup, in registry order", () => {
		expect(CLIENTS.map((c) => c.id)).toEqual(
			DRIVERS.filter((d) => d.setup).map((d) => d.id),
		);
	});
});

describe.each(DRIVERS.map((d) => [d.id, d] as const))("driver %s", (id, d) => {
	test("has a label", () => {
		expect(d.label.trim().length).toBeGreaterThan(0);
	});

	test("matchProcess rejects unrelated command lines", () => {
		for (const args of UNRELATED) expect(d.matchProcess(args)).toBe(false);
	});

	test("push.canPush is false for other harnesses", () => {
		if (!d.push) return;
		for (const other of [
			...DRIVERS.filter((o) => o.id !== id).map((o) => o.id),
			...PSEUDO_HARNESSES,
		])
			expect(d.push.canPush(agentOf(other))).toBe(false);
	});

	test("scan runs on a positive interval", () => {
		if (!d.scan) return;
		expect(d.scan.intervalMs).toBeGreaterThan(0);
	});

	test("toolSessions ignores calls without its _meta key", () => {
		if (!d.toolSessions) return;
		expect(d.toolSessions.sessionId(undefined)).toBeNull();
		expect(d.toolSessions.sessionId({})).toBeNull();
		expect(d.toolSessions.sessionId({ other: "x" })).toBeNull();
	});

	test("extension names at least one idle event", () => {
		if (!d.extension) return;
		expect(d.extension.idleEvents.length).toBeGreaterThan(0);
	});

	test("setup.plan returns well-formed actions with undo records", () => {
		if (!d.setup) return;
		const variants = [
			ctx(),
			ctx({ mcp: false }),
			ctx({ skillsDir: "/fake/skills" }),
			ctx({ mcp: false, skillsDir: "/fake/skills" }),
		];
		for (const c of variants) {
			const actions = d.setup.plan(c);
			expect(Array.isArray(actions)).toBe(true);
			for (const a of actions) expectWellFormed(a, id);
		}
		// With MCP and per-harness skills on, every harness gets at least one change.
		expect(d.setup.plan(ctx()).length).toBeGreaterThan(0);
	});
});

describe("light identity registry", () => {
	test("IDENTS mirrors DRIVERS: same order, same identity functions", () => {
		expect(IDENTS.map((i) => i.id)).toEqual(DRIVERS.map((d) => d.id));
		for (const [n, ident] of IDENTS.entries()) {
			const driver = DRIVERS[n]!;
			for (const key of [
				"label",
				"matchProcess",
				"identify",
				"lateSession",
				"toolSessions",
				"extension",
			] as const)
				expect(driver[key]).toBe(ident[key] as never);
		}
	});
});
