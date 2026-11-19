import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import * as realChildProcess from "node:child_process";
import { spawn } from "node:child_process";
import * as realFs from "node:fs";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Daemon } from "../src/daemon.ts";
import { socketPath } from "../src/paths.ts";
import {
	agentClient,
	operator,
	registration,
	restoreEnv,
	until,
} from "./helpers.ts";

/**
 * The daemon must never block its event loop on a child process. On a busy
 * Mac every `ps`/`git`/`lsof` can take seconds; a synchronous one stalls
 * every socket and HTTPS request for that long. Here each of those binaries
 * sleeps 2 s before running the real one, and the daemon must keep answering
 * fast while its scans and refreshes run them.
 */

// Under the daemon's child-process timeouts, so the calls succeed slowly.
const SLOW_SECONDS = 2;
// PULSAR_LOOP_SOAK_MS=60000 turns this into a soak.
const WINDOW_MS = Number(process.env.PULSAR_LOOP_SOAK_MS) || 9000;
/**
 * The lag budget, over what the OS alone costs a nearly idle process (the
 * probe measures its own loop). A blocked loop costs seconds. The soak holds
 * the daemon to 50 ms; the default run, part of `bun run check` on machines
 * whose load can be 20x their cores, allows for process starts (fork/exec
 * blocks the loop, 100 ms and more under such load).
 */
const LAG_BUDGET_MS = process.env.PULSAR_LOOP_SOAK_MS ? 50 : 200;

// Every synchronous child-process or fs call the daemon (src/) made after it
// started, with its stack. The test's own fs calls are not counted.
const syncCalls: string[] = [];
let recording = false;
const record =
	<T extends (...a: never[]) => unknown>(name: string, real: T) =>
	(...args: Parameters<T>) => {
		if (recording) {
			const stack = new Error().stack?.split("\n").slice(2, 8) ?? [];
			if (stack[0]?.includes("/src/"))
				syncCalls.push(`${name}(${String(args[0])}) at ${stack.join(" | ")}`);
		}
		return real(...args);
	};
const original = { ...realChildProcess };
mock.module("node:child_process", () => ({
	...original,
	execFileSync: record("execFileSync", original.execFileSync),
	spawnSync: record("spawnSync", original.spawnSync),
	execSync: record("execSync", original.execSync),
}));
const originalFs = { ...realFs };
const FS_SYNC = Object.keys(originalFs).filter(
	(k) =>
		k.endsWith("Sync") &&
		typeof (originalFs as Record<string, unknown>)[k] === "function",
);
mock.module("node:fs", () => ({
	...originalFs,
	...Object.fromEntries(
		FS_SYNC.map((k) => [
			k,
			record(
				k,
				(originalFs as unknown as Record<string, (...a: never[]) => unknown>)[
					k
				]!,
			),
		]),
	),
}));

const root = mkdtempSync(join(tmpdir(), "pulsar-loop-"));
const bin = join(root, "bin");
const marks = join(root, "marks");
const claudeDir = join(root, "claude");
const repo = join(root, "repo");
const home = join(root, "home");
for (const d of [bin, marks, join(claudeDir, "sessions"), repo, home])
	mkdirSync(d, { recursive: true });

/** A binary that records the call, sleeps, then runs the real one. */
function slowBinary(name: string, body: string) {
	const path = join(bin, name);
	writeFileSync(
		path,
		`#!/bin/sh\necho "$(date +%s)" >> "${join(marks, name)}"\nsleep ${SLOW_SECONDS}\n${body}\n`,
	);
	chmodSync(path, 0o755);
}
const realBin = (name: string) => Bun.which(name) ?? `/usr/bin/${name}`;
for (const name of ["git", "lsof", "tmux"])
	slowBinary(name, `exec "${realBin(name)}" "$@"`);
// The full process list also shows OpenCode's shared server, so its scanner
// runs (against the fake `opencode` below). Only in this list: a real process
// would make every daemon on the machine see an OpenCode server.
slowBinary(
	"ps",
	`case "$*" in *-axo*) "${realBin("ps")}" "$@"; echo "99999 1 opencode-fake serve --service"; exit 0;; esac\nexec "${realBin("ps")}" "$@"`,
);
slowBinary("opencode", `echo '{"data":{}}'`);
const hits = (name: string) => {
	const f = join(marks, name);
	return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").length : 0;
};

async function freePort(): Promise<number> {
	const srv = createServer();
	await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
	const port = (srv.address() as { port: number }).port;
	await new Promise((r) => srv.close(r));
	return port;
}

function pct(values: number[], p: number) {
	const s = [...values].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
}

const previousEnv = {
	PATH: process.env.PATH,
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	PULSAR_HOME: process.env.PULSAR_HOME,
	XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};
let daemon: Daemon;
let port: number;

beforeAll(async () => {
	// A real repository, so the scan's git lookups run git.
	const git = realBin("git");
	original.execFileSync(git, ["init", "-q", "-b", "main", repo]);
	writeFileSync(
		join(claudeDir, "sessions", `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId: "loop-claude-1",
			cwd: repo,
			name: "loop-claude",
			status: "busy",
		}),
	);
	process.env.PATH = `${bin}:${process.env.PATH}`;
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	process.env.PULSAR_HOME = home;
	// Never the operator's OpenCode service.json (the scanner would read it).
	process.env.XDG_STATE_HOME = join(home, "xdg-state");
	port = await freePort();
	daemon = new Daemon({
		socket: socketPath(),
		db: join(home, "pulsar.db"),
		scan: true,
		machine: "loop-test",
		remote: { mode: "dev", login: "me@example.com", port },
	});
	expect(await daemon.start()).toBe(true);
	// The app's server starts in the background.
	await until(
		() =>
			fetch(`http://127.0.0.1:${port}/api/v1/hello`).then(
				(r) => r.ok,
				() => false,
			),
		20_000,
	);
	recording = true;
}, 30_000);

afterAll(async () => {
	recording = false;
	await daemon?.stop();
	mock.module("node:child_process", () => original);
	mock.module("node:fs", () => originalFs);
	for (const [name, value] of Object.entries(previousEnv))
		restoreEnv(name, value);
	rmSync(root, { recursive: true, force: true });
});

describe("daemon event loop under slow child processes", () => {
	test(
		"answers socket and HTTP requests fast while scans run slow binaries",
		async () => {
			const op = await operator();
			const agent = await agentClient(
				registration({ harness: "pi", sessionId: "loop-pi", cwd: repo }),
			);
			const lag = monitorEventLoopDelay({ resolution: 10 });
			lag.enable();
			const before = { ps: hits("ps"), git: hits("git") };
			// Requests come from another process, timed from when each was due,
			// so a blocked loop shows its whole stall.
			const probe = spawn(
				process.execPath,
				[
					join(import.meta.dir, "fixtures", "loop-probe.ts"),
					String(port),
					String(WINDOW_MS),
				],
				{ env: process.env, stdio: ["ignore", "pipe", "inherit"] },
			);
			let out = "";
			probe.stdout?.on("data", (d) => {
				out += d;
			});
			const probeDone = new Promise<number | null>((r) =>
				probe.on("exit", (code) => r(code)),
			);
			// What the timers do, all at once: scans, git, PR and model refreshes, and a
			// set_identity that moves an agent (a git lookup on the request path).
			// They start once the probe runs.
			await new Promise((r) => setTimeout(r, 500));
			const jobs = Promise.all([
				daemon.service.registry.refreshGit(),
				daemon.service.registry.refreshPrs(),
				daemon.service.registry.refreshModels(),
				...daemon.service.registry
					.scanners()
					.map(({ id, scan }) => daemon.service.registry.runScan(id, scan)),
				agent.client.call("set_identity", { cwd: repo }),
			]);
			const probeExit = await probeDone;
			lag.disable();
			await jobs;
			op.close();
			agent.client.close();
			if (!out) throw new Error(`the probe exited ${probeExit} with no report`);
			const { helloMs, socketMs, httpMs, controlP99 } = JSON.parse(out) as {
				controlP99: number;
				helloMs: number;
				socketMs: number[];
				httpMs: number[];
			};
			const report = {
				samples: socketMs.length,
				helloMs: Math.round(helloMs),
				socketP50: Math.round(pct(socketMs, 50)),
				socketMax: Math.round(Math.max(...socketMs)),
				httpP50: Math.round(pct(httpMs, 50)),
				httpMax: Math.round(Math.max(...httpMs)),
				lagP99: Math.round(lag.percentile(99) / 1e6),
				lagMax: Math.round(lag.max / 1e6),
				psCalls: hits("ps") - before.ps,
				gitCalls: hits("git") - before.git,
				controlLagP99: Math.round(controlP99),
				load: Math.round(loadavg()[0]!),
				lastStall: daemon.service.lag.stats().lastStall,
			};
			console.log(`event-loop under slow binaries: ${JSON.stringify(report)}`);
			// The slow binaries ran inside the window (otherwise this proves nothing).
			expect(report.psCalls + report.gitCalls).toBeGreaterThan(0);
			expect(report.samples).toBeGreaterThan(20);
			expect(hits("opencode")).toBeGreaterThan(0);
			expect(report.socketP50).toBeLessThan(100);
			expect(report.httpP50).toBeLessThan(100);
			// A blocked loop stalls for the whole slow call (2 s and more, 30 s
			// before this fix); OS scheduling on a loaded machine stays under it.
			expect(report.socketMax).toBeLessThan(SLOW_SECONDS * 1000);
			expect(report.httpMax).toBeLessThan(SLOW_SECONDS * 1000);
			expect(report.lagP99).toBeLessThan(report.controlLagP99 + LAG_BUDGET_MS);
		},
		WINDOW_MS + 60_000,
	);

	test("the scanner still finds the session and its git branch", async () => {
		await until(
			() =>
				daemon
					.live()
					.some((a) => a.id === "claude:loop-claude-1" && a.branch === "main"),
			20_000,
		).catch((e) => {
			console.log(JSON.stringify(daemon.live().map((a) => [a.id, a.branch])));
			throw e;
		});
	}, 30_000);

	test("no synchronous child process or fs call ran after the daemon started", () => {
		expect(syncCalls).toEqual([]);
	});
});
