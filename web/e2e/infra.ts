import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Test infrastructure shared by the Playwright configs.
 *
 * Ports (runPort, for configs with one shared webServer): each run picks
 * free ports when the config loads and keeps them in the environment, so
 * Playwright's worker processes (which load the config again and inherit the
 * environment) agree, and runs in other worktrees on the same machine never
 * take each other's server. A port set in the environment beforehand is kept.
 *
 * The e2e suites instead give every worker its own server (workerPort and
 * startServer, through the `server` worker option in fixtures.ts), so tests
 * that change server state run in parallel without seeing each other.
 */
export function runPort(name: string): number {
	if (!process.env[name]) process.env[name] = String(freePort());
	return Number(process.env[name]);
}

function freePort(): number {
	const out = execFileSync(
		process.execPath,
		[
			"-e",
			"const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
		],
		{ encoding: "utf8" },
	);
	const port = Number(out);
	if (!Number.isInteger(port) || port <= 0)
		throw new Error(`could not find a free port (${out})`);
	return port;
}

/** Where the e2e servers log (gitignored; outside test-results, which Playwright clears). */
export const LOG_DIR = fileURLToPath(new URL("../e2e-logs/", import.meta.url));

/** The per-worker logs of one suite's servers (`<name>-w<worker>.log`), by file name. */
export function workerLogs(name: string): string[] {
	mkdirSync(LOG_DIR, { recursive: true });
	const re = new RegExp(`^${name}-w\\d+\\.log$`);
	return readdirSync(LOG_DIR)
		.filter((f) => re.test(f))
		.sort();
}

/** Removes a suite's worker logs from an earlier run. */
export function clearWorkerLogs(name: string) {
	for (const f of workerLogs(name)) rmSync(`${LOG_DIR}${f}`, { force: true });
}

/** The log file for one server, created fresh; returns its absolute path. */
export function serverLog(name: string): string {
	mkdirSync(LOG_DIR, { recursive: true });
	return `${LOG_DIR}${name}.log`;
}

/** A shell-quoted path for a webServer command. */
export const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** True inside a Playwright worker process (it sets these before loading the config). */
export const IN_WORKER = process.env.TEST_WORKER_INDEX !== undefined;

/**
 * A port for this worker's own server. Each worker process loads the config
 * before any test file, so a fresh port picked here (and kept in the
 * environment) is what the config's baseURL and the test files see. The
 * runner's main process runs no tests and needs no port.
 */
export function workerPort(name: string): number {
	if (!IN_WORKER) return 0;
	process.env[name] = String(freePort());
	return Number(process.env[name]);
}

/**
 * Workers for a config: PULSAR_E2E_WORKERS (a count or a percentage) wins;
 * else every core on CI and half of them locally, where the machine is
 * usually busy with other work.
 */
export function e2eWorkers(): number | string {
	const env = process.env.PULSAR_E2E_WORKERS?.trim();
	if (!env) return process.env.CI ? "100%" : "50%";
	// Playwright takes a number or a percentage string, not "2".
	return /^\d+$/.test(env) ? Number(env) : env;
}

/** One worker's server process, as the `server` worker option describes it. */
export interface ServerSpec {
	/** The log's name: `e2e-logs/<name>-w<worker>.log`. */
	name: string;
	/** The script `bun` runs, relative to the repo root. */
	script: string;
	/** The environment variable that holds its HTTP port (see workerPort). */
	portEnv: string;
	env?: Record<string, string>;
	/** A log line that says it is fully up (else `/api/v1/hello` answering is enough). */
	readyLine?: string;
	/**
	 * How the worker knows the port answers with its own server, not another
	 * worker's (a port collision): by default `/api/v1/hello` echoes the
	 * worker's PULSAR_E2E_TOKEN as `e2eToken` (the mock). With
	 * `controlPortEnv`, the server's control port answers `/e2e-identity`
	 * with that token and its machine id, which `/hello` must report (the
	 * real daemon, whose /hello stays as in production).
	 */
	identity?: { controlPortEnv: string };
}

/** The worker options the e2e configs set (see fixtures.ts). */
export interface E2EWorkerOptions {
	server: ServerSpec | null;
}

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const READY_MS = 30_000;

/**
 * Starts one worker's server and waits until it answers `/api/v1/hello` as
 * this worker's own server (ServerSpec.identity; another server on the port
 * fails at once) and logged `readyLine`. Returns a function that stops it.
 *
 * The server's stdin is a pipe from this worker; with PULSAR_E2E_PIPE=1 the
 * mock and the real daemon exit when it closes, so a worker that is killed
 * (a timeout, Ctrl-C) never leaves its server running.
 */
export async function startServer(
	spec: ServerSpec,
	worker: number,
): Promise<() => Promise<void>> {
	const port = Number(process.env[spec.portEnv]);
	if (!port) throw new Error(`${spec.portEnv} is not set in this worker`);
	const log = serverLog(`${spec.name}-w${worker}`);
	const out = openSync(log, "w");
	const token = randomUUID();
	const child = spawn("bun", [spec.script], {
		cwd: ROOT,
		env: {
			...process.env,
			...spec.env,
			PULSAR_E2E_PIPE: "1",
			PULSAR_E2E_TOKEN: token,
		},
		stdio: ["pipe", out, out],
	});
	closeSync(out);
	let exited: string | null = null;
	const done = new Promise<void>((resolve) =>
		child.once("exit", (code, signal) => {
			exited = signal ?? `code ${code}`;
			resolve();
		}),
	);
	const fail = (why: string) =>
		new Error(
			`${spec.name} server (worker ${worker}) ${why}; log:\n${tail(log)}`,
		);
	const deadline = Date.now() + READY_MS;
	for (;;) {
		if (exited) throw fail(`exited (${exited}) before it was ready`);
		const up = await check(spec, port, log, token);
		if (up === "other") {
			child.kill("SIGKILL");
			throw fail(
				`is not the server answering on port ${port}: another process holds the port`,
			);
		}
		if (up === "ours") break;
		if (Date.now() > deadline) {
			child.kill("SIGKILL");
			throw fail(`was not ready in ${READY_MS / 1000} s`);
		}
		await new Promise((r) => setTimeout(r, 100));
	}
	return async () => {
		if (exited) return;
		child.kill("SIGTERM");
		const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
		await done;
		clearTimeout(kill);
	};
}

/**
 * "ours" once the server on `port` proves it is the one this worker started
 * (see ServerSpec.identity) and logged its ready line; "other" when a server
 * answers there but is not ours (a port collision); null while not up yet.
 */
async function check(
	spec: ServerSpec,
	port: number,
	log: string,
	token: string,
): Promise<"ours" | "other" | null> {
	const hello = await getJson(`http://127.0.0.1:${port}/api/v1/hello`);
	if (!hello) return null;
	if (spec.identity) {
		const control = Number(process.env[spec.identity.controlPortEnv]);
		const id = await getJson(`http://127.0.0.1:${control}/e2e-identity`);
		if (!id) return null;
		if (id.token !== token || hello.machineId !== id.machineId) return "other";
	} else if (hello.e2eToken !== token) return "other";
	if (spec.readyLine && !readFileSync(log, "utf8").includes(spec.readyLine))
		return null;
	return "ours";
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
		if (!res.ok) return null;
		const body = (await res.json()) as unknown;
		return body && typeof body === "object"
			? (body as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function tail(file: string, lines = 40): string {
	try {
		return readFileSync(file, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-lines)
			.join("\n");
	} catch {
		return "(no log)";
	}
}
