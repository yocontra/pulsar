import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "../src/client.ts";
import { Daemon, type DaemonOptions } from "../src/daemon.ts";
import type {
	DeliveredMessage,
	PublicAgent,
	Registration,
} from "../src/types.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";

/** Sets an env var back to a saved value, deleting it when it was unset. */
export function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

/**
 * A daemon on a private socket and database, with harness scanners off.
 * PULSAR_HOME points at it until `cleanup` restores the old value and removes
 * the directory; stop the daemon first.
 */
export async function startDaemon(opts: DaemonOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "pulsar-test-"));
	const previous = process.env.PULSAR_HOME;
	process.env.PULSAR_HOME = home;
	const cleanup = () => {
		restoreEnv("PULSAR_HOME", previous);
		rmSync(home, { recursive: true, force: true });
	};
	try {
		const daemon = new Daemon({
			socket: join(home, "bus.sock"),
			db: join(home, "pulsar.db"),
			scan: false,
			remote: { mode: "off" },
			...opts,
		});
		if (!(await daemon.start())) throw new Error("daemon did not start");
		return { daemon, home, cleanup };
	} catch (error) {
		cleanup();
		throw error;
	}
}

let pidCounter = 900_000;

export function registration(over: Partial<Registration> = {}): Registration {
	return {
		harness: "pi",
		sessionId: null,
		// Fake pids: the test agents are kept alive by their connections.
		pid: null,
		cwd: "/tmp/apparish",
		project: "apparish",
		branch: "main",
		tags: ["harness:pi", "project:apparish", "branch:main"],
		role: "extension",
		...over,
		...(over.sessionId === undefined && over.pid === undefined
			? { sessionId: `s${pidCounter++}` }
			: {}),
	};
}

/** Connects a fake agent. Extension-role agents receive pushes as `push` events. */
export async function agentClient(reg: Registration) {
	const client = new DaemonClient();
	await client.connect(false);
	const hello = await client.call<{ agent: PublicAgent }>("hello", {
		protocol: PROTOCOL_VERSION,
		registration: reg,
	});
	const pushes: Array<{ message: DeliveredMessage; text: string }> = [];
	const events: DeliveredMessage[] = [];
	client.on("push", (d) =>
		pushes.push(d as { message: DeliveredMessage; text: string }),
	);
	client.on("message", (d) => events.push(d as DeliveredMessage));
	return { client, agent: hello.agent, pushes, events };
}

export async function operator() {
	const client = new DaemonClient();
	await client.connect(false);
	await client.call("hello", {
		protocol: PROTOCOL_VERSION,
		registration: { role: "cli" },
	});
	return client;
}

/**
 * One round trip on `client`. The daemon handles a connection's frames in
 * order, so a `wait` sent before this is registered once it resolves, and any
 * event the daemon wrote to this connection earlier has been dispatched.
 */
export async function roundTrip(client: DaemonClient) {
	await client.call("status");
}

export async function until(
	check: () => boolean | Promise<boolean>,
	ms = 2000,
) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("condition not met in time");
}

/** Newest modification time of any file under `dir` (ms). */
function newestMtime(dir: string): number {
	let newest = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, entry.name);
		newest = Math.max(
			newest,
			entry.isDirectory() ? newestMtime(p) : statSync(p).mtimeMs,
		);
	}
	return newest;
}

/**
 * Tests that run the built CLI (`dist/cli.js`) must not run an old build: a
 * checkout that moved since the last `bun run build` would test old code.
 * Rebuilds the CLI bundle (not the web app) when it is missing or older than
 * any source file. Returns the CLI path.
 */
export function builtCli(): string {
	const root = join(import.meta.dir, "..");
	const cli = join(root, "dist", "cli.js");
	const stale =
		!existsSync(cli) ||
		statSync(cli).mtimeMs < newestMtime(join(root, "src")) ||
		statSync(cli).mtimeMs < statSync(join(root, "package.json")).mtimeMs;
	if (stale) {
		execFileSync(
			"bun",
			[
				"build",
				"src/cli.ts",
				"src/extension.ts",
				"--target=node",
				"--format=esm",
				"--splitting",
				"--outdir",
				"dist",
			],
			{ cwd: root, stdio: "ignore" },
		);
		chmodSync(cli, 0o755);
	}
	return cli;
}
