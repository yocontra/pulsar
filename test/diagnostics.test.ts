import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Checks,
	checkLine,
	cleanLocalDiagnostics,
	redact,
	redactReport,
	versionSkew,
} from "../src/diagnostics/checks.ts";
import {
	FRESH_MS,
	LocalDiagnosticsRunner,
	MIN_FRESH_MS,
	parseDoctorOutput,
} from "../src/diagnostics/local.ts";
import {
	diagnosticsList,
	machineDiagnostics,
} from "../src/diagnostics/pool.ts";
import { RemoteDiagnostics } from "../src/federation/diagnostics.ts";
import type { Federation } from "../src/federation/index.ts";
import type { LocalDiagnostics } from "../src/http/wire.ts";
import { RpcError } from "../src/rpc.ts";
import type { Principal } from "../src/service/caller.ts";
import {
	commandPath,
	detectHarnesses,
	parseBinLines,
	parseVersion,
} from "../src/setup/doctor.ts";
import { which } from "../src/setup/files.ts";
import { shimStatus, writeShim } from "../src/setup/shim.ts";
import { VERSION } from "../src/version.ts";

/**
 * Diagnostics (`GET /diagnostics`): doctor's checks as data, what a report
 * may say once it leaves its machine (redacted, then checked and bounded),
 * version skew, the daemon's runner, and the pool's reader (offline and old
 * machines). The federated read itself: test/diagnostics-fed.test.ts.
 */

const HOME = "/Users/alice";

/*
 * Credential-shaped values for the redaction tests, made at run time so no
 * key-shaped string sits in the source (secret scanners would flag it).
 * All fake.
 */
const j = (...parts: string[]) => parts.join("");
const FAKE = {
	tailscale: ["tskey", "auth", j("kXXXX", "CNTRL"), "0".repeat(16)].join("-"),
	github: j("gh", "p_", "0123456789abcdef", "ABCDEF0123456789abcd"),
	githubPat: j(
		"github",
		"_pat_",
		"11XXXXXXX0123456789_",
		"abcdefghijklmnopqrstuv",
	),
	anthropic: j("sk", "-ant-api03-", "X".repeat(24)),
	hex: j("0123456789abcdef".repeat(2), "01234567"),
	jwt: [
		j("ey", "J", "hbGciOiJub25lIn0"),
		j("ey", "J", "zdWIiOiJ0ZXN0In0"),
		"c2lnbmF0dXJlLXZhbHVl",
	].join("."),
	aws: j("AK", "IA", "XXXXXXXXXXXXXXXX"),
	npm: j("np", "m_", "abcdefghijklmnopqrstuvwxyz0123"),
	slack: j("xo", "xb-", "1234567890-abcdefghij"),
	base64: j("QWxhZGRpbjpvcGVuIHNlc2FtZQ0K", "9xY2lmZm9yZDEyMzQ1Njc4OTA="),
	basic: j("dXNlcjpw", "YXNzd29yZA"),
};
const OPERATOR: Principal = {
	kind: "human",
	login: "me@example.com",
} as Principal;

describe("structured checks", () => {
	test("the collector keeps order, group, level and fix; the CLI line joins them", () => {
		const printed: string[] = [];
		const c = new Checks((x) => printed.push(checkLine(x)));
		c.ok("daemon 2.0.0 running");
		c.group = "mesh";
		c.bad("no node certificate yet", "run `pulsar mesh on`");
		c.note("no other devices signed in as you");
		expect(c.list).toEqual([
			{ group: "daemon", level: "ok", text: "daemon 2.0.0 running", fix: null },
			{
				group: "mesh",
				level: "bad",
				text: "no node certificate yet",
				fix: "run `pulsar mesh on`",
			},
			{
				group: "mesh",
				level: "note",
				text: "no other devices signed in as you",
				fix: null,
			},
		]);
		expect(printed).toEqual([
			"✓ daemon 2.0.0 running",
			"✗ no node certificate yet: run `pulsar mesh on`",
			"· no other devices signed in as you",
		]);
		expect(c.problems).toBe(1);
	});

	test("a harness version is its first version number", () => {
		expect(parseVersion("2.1.328 (Claude Code)\n")).toBe("2.1.328");
		expect(parseVersion("codex-cli 0.169.0")).toBe("0.169.0");
		expect(parseVersion("omp v19.1.0-beta.2")).toBe("19.1.0-beta.2");
		expect(parseVersion("dev build\nmore")).toBe("dev build");
		expect(parseVersion("")).toBeNull();
	});

	test("a login shell's answer: each harness's path and its PATH, through rc noise", () => {
		const r = parseBinLines(
			"\x1b]7;file://h\x07welcome\nPULSAR_BIN:claude:/Users/a/.local/bin/claude\nPULSAR_BIN:pi:relative\nPULSAR_PATH:/Users/a/bin:/usr/bin\n",
		);
		expect([...r.bins]).toEqual([["claude", "/Users/a/.local/bin/claude"]]);
		expect(r.path).toBe("/Users/a/bin:/usr/bin");
		expect(parseBinLines("nothing").path).toBeNull();
	});

	test("run under the service, the `pulsar` command is checked against the login shell's PATH", () => {
		const home = mkdtempSync(join(tmpdir(), "pulsar-diag-shim-"));
		try {
			// A shim setup wrote, pointing at files that exist.
			const node = join(home, "node");
			const cli = join(home, "cli.js");
			writeFileSync(node, "");
			writeFileSync(cli, "");
			writeShim(node, cli, home);
			const bin = join(home, ".local", "bin");
			// launchd's PATH: no ~/.local/bin.
			const servicePath = "/usr/bin:/bin:/usr/sbin:/sbin";
			const shellPath = `${bin}:/opt/homebrew/bin:/usr/bin:/bin`;

			// The bug: checked against the service's PATH, a false problem.
			expect(shimStatus(home, servicePath)).toMatchObject({
				ok: false,
				message: expect.stringContaining("is not on PATH here"),
			});
			// Doctor's child (--json) checks the login shell's PATH instead.
			const path = commandPath(true, shellPath, servicePath);
			expect(path).toBe(shellPath);
			expect(shimStatus(home, path!)).toEqual({
				ok: true,
				message: "`pulsar` command: ~/.local/bin/pulsar",
			});
			// In a terminal, this process's PATH, as before.
			expect(commandPath(false, null, servicePath)).toBe(servicePath);
			// Under the service with no login shell PATH: not checked (null), never failed.
			expect(commandPath(true, null, servicePath)).toBeNull();
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("run under the service, harnesses are found on the login shell's PATH", () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-diag-bin-"));
		try {
			// A harness installed only in a folder the service's PATH lacks.
			const bin = join(dir, ".local", "bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(bin, "fakeharness"), "#!/bin/sh\n", { mode: 0o755 });
			const servicePath = "/usr/bin:/bin";
			const shellPath = `${bin}:/usr/bin:/bin`;
			const env = process.env.PATH;
			process.env.PATH = servicePath;
			try {
				const clients = [
					{
						id: "fakeharness",
						detect: (p?: string) => !!which("fakeharness", p),
					},
				];
				// The bug: on the service's PATH it isn't found at all.
				expect(detectHarnesses(clients, false, null).detected).toEqual([]);
				// Doctor's child (--json) looks on the login shell's PATH.
				expect(detectHarnesses(clients, true, shellPath)).toEqual({
					detected: clients,
					partial: false,
				});
				// No login shell PATH: what the service's PATH finds, flagged as partial.
				expect(detectHarnesses(clients, true, null)).toEqual({
					detected: [],
					partial: true,
				});
			} finally {
				process.env.PATH = env;
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the doctor's JSON is the last object line of its output", () => {
		expect(
			parseDoctorOutput(
				'starting the daemon...\n{"version":"2.0.0","checks":[]}\n',
			),
		).toEqual({ version: "2.0.0", checks: [] });
		expect(parseDoctorOutput("no json\n{broken")).toBeNull();
	});
});

describe("redaction", () => {
	test("home folders become ~", () => {
		expect(
			redact(
				"background service file /Users/alice/Library/LaunchAgents/x.plist is missing",
				HOME,
			),
		).toBe("background service file ~/Library/LaunchAgents/x.plist is missing");
		expect(redact("the hook runs /home/bob/.local/bin/node", HOME)).toBe(
			"the hook runs ~/.local/bin/node",
		);
		expect(
			redact("certificate key /Users/alice/.local/x.key is readable", HOME),
		).toBe("certificate key ~/.local/x.key is readable");
	});

	test("anything shaped like a credential is removed", () => {
		const planted = [
			`daemon: auth failed with ${FAKE.tailscale}`,
			"fetch https://user:pa55phrase@example.com/x failed",
			"Authorization: Bearer abc.def.ghi rejected",
			"token=s3cr3tvalue&next=1",
			'"password": "pa55word"',
			`gh said ${FAKE.github}`,
			`key ${FAKE.anthropic}`,
			`secret ${FAKE.hex}`,
		];
		const out = planted.map((s) => redact(s, HOME)).join("\n");
		for (const secret of [
			FAKE.tailscale.slice(11),
			"pa55phrase",
			"abc.def.ghi",
			"s3cr3tvalue",
			"pa55word",
			FAKE.github.slice(0, 8),
			FAKE.anthropic.slice(0, 12),
			FAKE.hex.slice(0, 32),
		])
			expect(out).not.toContain(secret);
		expect(out).toContain("[redacted]");
		// Redacting again (the receiving node does) changes nothing.
		expect(planted.map((x) => redact(redact(x, HOME), HOME)).join("\n")).toBe(
			out,
		);
		// Paths stay whole, however long.
		for (const path of [
			"service runs /usr/local/lib/node_modules/pulsar/dist/cli.js, not the current install",
			"the hook runs /opt/pulsar/versions/2.0.0-abcdefabcdef/lib/node_modules_cache_dir_x/cli.js",
		])
			expect(redact(path, HOME)).toBe(path);
		// Ordinary text stays readable.
		expect(redact("node certificate valid for 89 days", HOME)).toBe(
			"node certificate valid for 89 days",
		);
	});

	test("each credential shape is redacted on its own", () => {
		const cases: [string, string, string][] = [
			// [name, text, the part that must not survive]
			["JWT", `session ${FAKE.jwt} rejected`, FAKE.jwt.slice(0, 20)],
			["AWS key", `aws said ${FAKE.aws} is invalid`, FAKE.aws],
			["npm token", `npm ${FAKE.npm} expired`, FAKE.npm.slice(0, 10)],
			["Slack token", `slack ${FAKE.slack} refused`, FAKE.slack.slice(0, 12)],
			[
				"long base64",
				`key material ${FAKE.base64} leaked`,
				FAKE.base64.slice(0, 16),
			],
			["Basic auth", `Authorization: Basic ${FAKE.basic} sent`, FAKE.basic],
			[
				"GitHub fine-grained token",
				`gh ${FAKE.githubPat} failed`,
				FAKE.githubPat.slice(0, 18),
			],
		];
		for (const [name, text, secret] of cases) {
			const out = redact(text, HOME);
			expect({ name, leaked: out.includes(secret) }).toEqual({
				name,
				leaked: false,
			});
			expect(out).toContain("[redacted]");
		}
	});

	test("a whole report is redacted: checks, fixes and versions", () => {
		const r = redactReport(
			report({
				checks: [
					{
						group: "daemon",
						level: "bad",
						text: "daemon: /Users/alice/x failed token=abc123",
						fix: "chmod 600 /Users/alice/.ssh/id",
					},
				],
			}),
			HOME,
		);
		expect(r.checks[0]).toEqual({
			group: "daemon",
			level: "bad",
			text: "daemon: ~/x failed token=[redacted]",
			fix: "chmod 600 ~/.ssh/id",
		});
	});
});

describe("a report from elsewhere", () => {
	test("fields are checked and bounded; unknown levels are dropped", () => {
		const r = cleanLocalDiagnostics({
			version: "2.0.0",
			platform: "darwin",
			uptimeS: -5,
			agents: "3",
			eventLoop: { p99: 12, max: 40, stalls: 1 },
			checks: [
				{ group: "mesh", level: "bad", text: "x‮y", fix: "do it" },
				{ group: "mesh", level: "fatal", text: "dropped" },
				{ level: "ok", text: "z".repeat(900) },
				"junk",
			],
			facts: {
				tailscale: { state: "running", version: 1, magicDns: "yes" },
				certDays: "12",
				harnesses: [{ id: "claude", version: "2.1.0", configured: true }, {}],
			},
			checkedAt: 5,
		});
		expect(r).not.toBeNull();
		expect(r!.uptimeS).toBe(0);
		expect(r!.agents).toBe(3);
		expect(r!.checks.map((c) => [c.group, c.level, c.text.length])).toEqual([
			["mesh", "bad", 2],
			["other", "ok", 500],
		]);
		expect(r!.facts).toEqual({
			tailscale: {
				state: "running",
				version: null,
				dnsName: null,
				magicDns: null,
			},
			certDays: 12,
			harnesses: [
				{ id: "claude", label: "claude", version: "2.1.0", configured: true },
			],
		});
		expect(cleanLocalDiagnostics({ checks: [] })).toBeNull();
		expect(cleanLocalDiagnostics("nope")).toBeNull();
	});
});

describe("version skew", () => {
	test("machines on an older version are told to upgrade", () => {
		const { newest, upgrade } = versionSkew([
			{ name: "studio", version: "2.1.0" },
			{ name: "mbp", version: "2.0.3" },
			{ name: "box", version: null },
			{ name: "pi", version: "2.1.0-rc.1" },
		]);
		expect(newest).toBe("2.1.0");
		expect([...upgrade]).toEqual([
			["mbp", "upgrade pulsar on mbp (2.0.3; newest is 2.1.0)"],
			["pi", "upgrade pulsar on pi (2.1.0-rc.1; newest is 2.1.0)"],
		]);
		expect(versionSkew([{ name: "a", version: "1.0.0" }]).upgrade.size).toBe(0);
	});
});

describe("the daemon's runner", () => {
	const doctorOut = (checks: unknown[]) =>
		JSON.stringify({
			version: "9.9.9",
			checks,
			facts: { tailscale: null, certDays: 30, harnesses: [] },
		});

	test("adds the daemon's facts, redacts, and runs one doctor at a time", async () => {
		let runs = 0;
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		let now = 1_000_000;
		const runner = new LocalDiagnosticsRunner({
			doctor: async () => {
				runs++;
				await gate;
				return {
					stdout: doctorOut([
						{
							group: "daemon",
							level: "bad",
							text: `node binary ${HOME}/n is missing`,
							fix: "re-run `pulsar setup`",
						},
					]),
					error: "exit 1",
				};
			},
			daemon: () => ({ agents: 4, eventLoop: { p99: 3, max: 9, stalls: 0 } }),
			home: HOME,
			now: () => now,
			uptimeS: () => 61.4,
		});
		const a = runner.read();
		const b = runner.read(true);
		release();
		const [ra, rb] = await Promise.all([a, b]);
		expect(runs).toBe(1);
		expect(ra).toBe(rb);
		expect(ra).toMatchObject({
			// The running daemon's version, not the child's.
			version: VERSION,
			uptimeS: 61,
			agents: 4,
			eventLoop: { p99: 3, max: 9, stalls: 0 },
			facts: { certDays: 30 },
			checkedAt: now,
		});
		expect(ra.checks[0]!.text).toBe("node binary ~/n is missing");
		// A recent report is shown again; `fresh` or an old one runs doctor again.
		now += 5000;
		await runner.read();
		expect(runs).toBe(1);
		await runner.read(true);
		expect(runs).toBe(2);
		now += 60_000;
		await runner.read();
		expect(runs).toBe(3);
	});

	test("a fresh run within 3 s shows the last report again", async () => {
		let runs = 0;
		let now = 1_000_000;
		const runner = new LocalDiagnosticsRunner({
			doctor: async () => {
				runs++;
				return { stdout: doctorOut([]), error: null };
			},
			daemon: () => ({ agents: 0, eventLoop: null }),
			now: () => now,
		});
		const first = await runner.read(true);
		now += MIN_FRESH_MS - 1;
		expect(await runner.read(true)).toBe(first);
		expect(runs).toBe(1);
		now += 2;
		await runner.read(true);
		expect(runs).toBe(2);
	});

	test("a failing doctor is throttled too: its failure is kept like a report", async () => {
		let runs = 0;
		let now = 1_000_000;
		const runner = new LocalDiagnosticsRunner({
			doctor: async () => {
				runs++;
				return { stdout: "", error: "boom" };
			},
			daemon: () => ({ agents: 0, eventLoop: null }),
			now: () => now,
		});
		await expect(runner.read()).rejects.toThrow("doctor did not answer: boom");
		// Asked again soon: the same failure, no new doctor.
		now += 1000;
		await expect(runner.read()).rejects.toThrow("boom");
		await expect(runner.read(true)).rejects.toThrow("boom");
		expect(runs).toBe(1);
		// Fresh after 3 s runs again; plain reads wait out FRESH_MS.
		now += MIN_FRESH_MS;
		await expect(runner.read(true)).rejects.toThrow("boom");
		expect(runs).toBe(2);
		now += FRESH_MS - 1;
		await expect(runner.read()).rejects.toThrow("boom");
		expect(runs).toBe(2);
		now += 2;
		await expect(runner.read()).rejects.toThrow("boom");
		expect(runs).toBe(3);
	});

	test("doctor output that is not a report is an error", async () => {
		const runner = new LocalDiagnosticsRunner({
			doctor: async () => ({ stdout: "Segmentation fault", error: "killed" }),
			daemon: () => ({ agents: 0, eventLoop: null }),
		});
		await expect(runner.read()).rejects.toThrow(
			"doctor did not answer: killed",
		);
	});
});

function report(o: Partial<LocalDiagnostics> = {}): LocalDiagnostics {
	return {
		version: "2.0.0",
		platform: "darwin",
		uptimeS: 10,
		agents: 1,
		eventLoop: null,
		checks: [],
		facts: { tailscale: null, certDays: null, harnesses: [] },
		checkedAt: 1,
		...o,
	};
}

describe("the pool's reader", () => {
	/** A federation with three peers: one answers, one is too old, one is asleep. */
	function fakeFed(
		answer: (machineId: string) => Promise<Record<string, unknown>>,
	) {
		const machines = [
			{ machineId: "m-new", name: "studio", link: "tailnet", agents: 1 },
			{ machineId: "m-old", name: "mbp", link: "tailnet", agents: 0 },
			{
				machineId: "m-off",
				name: "box",
				link: "asleep",
				reason: "asleep 14m",
				agents: 0,
			},
		];
		const hello: Record<string, string> = {
			"m-new": VERSION,
			"m-old": "1.9.0",
			"m-off": "2.0.0",
		};
		const asked: unknown[] = [];
		const fed = {
			machines: () => machines,
			state: {
				peers: new Map(
					machines.map((m) => [
						m.machineId,
						{ hello: { pulsarVersion: hello[m.machineId] } },
					]),
				),
			},
			act: async (address: string, action: unknown) => {
				asked.push([address, action]);
				return answer(address.slice(0, -1));
			},
		};
		return { fed: fed as unknown as Federation, asked };
	}

	test("offline and old machines say why, and an old one is flagged for upgrade", async () => {
		const { fed, asked } = fakeFed(async (id) => {
			if (id === "m-old")
				throw new RpcError("unsupported", "unknown action diag.read");
			return { ok: true, report: report({ version: VERSION }) };
		});
		const local = new LocalDiagnosticsRunner({
			doctor: async () => ({
				stdout: JSON.stringify({ version: VERSION, checks: [], facts: {} }),
				error: null,
			}),
			daemon: () => ({ agents: 0, eventLoop: null }),
		});
		const self = { id: "m-self", name: "laptop" };
		const pool = new RemoteDiagnostics(fed);
		// The list comes at once: nothing is asked yet.
		const list = diagnosticsList(self, pool);
		expect(asked).toEqual([]);
		expect(
			list.machines.map((m) => [m.name, m.pending, m.error, m.upgrade]),
		).toEqual([
			["laptop", true, null, null],
			["studio", true, null, null],
			[
				"mbp",
				true,
				null,
				`upgrade pulsar on mbp (1.9.0; newest is ${VERSION})`,
			],
			[
				"box",
				false,
				"asleep 14m",
				`upgrade pulsar on box (2.0.0; newest is ${VERSION})`,
			],
		]);
		expect(list.newest).toBe(VERSION);

		const one = (id: string) =>
			machineDiagnostics(self, local, pool, id, OPERATOR, true);
		const [mine, studio, mbp, box] = await Promise.all(
			["m-self", "m-new", "m-old", "m-off"].map(one),
		);
		// Only reachable peers are asked, with `fresh` passed on.
		expect(asked).toEqual([
			["m-new/", { op: "diag.read", fresh: true }],
			["m-old/", { op: "diag.read", fresh: true }],
		]);
		expect(mine).toMatchObject({
			self: true,
			version: VERSION,
			error: null,
			pending: false,
		});
		expect(mine!.report).not.toBeNull();
		expect(studio).toMatchObject({
			version: VERSION,
			error: null,
			upgrade: null,
			pending: false,
		});
		expect(mbp).toMatchObject({
			report: null,
			version: "1.9.0",
			error: "upgrade pulsar on mbp to see its checks",
			upgrade: `upgrade pulsar on mbp (1.9.0; newest is ${VERSION})`,
		});
		expect(box).toMatchObject({
			report: null,
			error: "asleep 14m",
			pending: false,
		});
		await expect(one("m-nope")).rejects.toThrow("no such machine");
		// A machine by name too: this one, and a peer (asked at its id).
		expect(await one("laptop")).toMatchObject({
			self: true,
			machineId: "m-self",
		});
		asked.length = 0;
		expect(await one("studio")).toMatchObject({
			machineId: "m-new",
			name: "studio",
		});
		expect(asked).toEqual([["m-new/", { op: "diag.read", fresh: true }]]);
	});

	test("a peer that times out says so", async () => {
		const { fed } = fakeFed(async () => {
			throw new RpcError(
				"unreachable",
				"The operation was aborted due to timeout",
			);
		});
		const r = await new RemoteDiagnostics(fed).one("m-new", false, OPERATOR);
		expect(r?.error).toBe("studio did not answer within 35 s");
	});

	test("a peer's answer that is not a report is an error, not a crash", async () => {
		const { fed } = fakeFed(async () => ({
			ok: true,
			report: { checks: "x" },
		}));
		const r = await new RemoteDiagnostics(fed).one("m-new", false, OPERATOR);
		expect(r?.error).toBe("sent no report");
	});
});
