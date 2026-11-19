import { spawn } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, DaemonLock } from "./daemon.ts";
import { fullGc } from "./gc.ts";
import { daemonRuntimeFlags } from "./lazy.ts";
import { daemonLog, flushLog } from "./log.ts";
import { checkedSocketPath, currentCli, ensureStateDir } from "./paths.ts";
import { serviceInstalledAsync } from "./setup/service.ts";
import { newer } from "./util.ts";
import { VERSION } from "./version.ts";

/** How often the daemon runs a full GC (a few ms on its heap). */
const GC_EVERY_MS = 5 * 60_000;

const log = daemonLog;

/** Exits once the log lines written so far are on disk. */
async function exit(code: number): Promise<never> {
	await flushLog();
	process.exit(code);
}

/**
 * Runs the daemon until it is idle for a long time or told to stop. With
 * `service` (launchd/systemd own the process) it never exits on idle, never
 * hands off to a newer install, and refuses the socket `shutdown` call.
 */
export async function runDaemon(opts: { service?: boolean } = {}) {
	const service = opts.service ?? false;
	await ensureStateDir();
	if (!service && (await deferToService())) await exit(0);
	if (!service && (await handOffToNewer())) await exit(0);
	// The lock first, before anything opens the database: concurrent starts
	// (several clients finding no daemon at once) leave exactly one.
	const lock = new DaemonLock(await checkedSocketPath());
	let locked = await lock.acquire();
	if (!locked && service) locked = await takeOver(() => lock.acquire());
	if (!locked) await exit(0);
	const daemon = new Daemon({ serviceMode: service, lock });
	let started = await daemon.start();
	// An older daemon that takes no lock (pulsar 1.x) may still hold the socket.
	if (!started && service) started = await takeOver(() => daemon.start());
	if (!started) {
		// Another daemon already serves this machine. A service exits 0 here so
		// launchd/systemd (restart on failure only) leave the other one alone.
		await exit(0);
	}
	log(
		`daemon ${VERSION} started (pid ${process.pid}${service ? ", service mode" : ""})`,
	);
	const stop = async (why: string) => {
		log(`daemon stopping: ${why}`);
		await daemon.stop();
		await exit(0);
	};
	// Lost the socket to another daemon (it already stopped serving): exit.
	daemon.onOrphan = () => {
		log("daemon exiting: another daemon owns the socket");
		void exit(0);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("uncaughtException", (e) => {
		// State may be half-changed; exit so the next client starts a fresh daemon.
		log(`uncaught: ${e.stack ?? e.message}`);
		void daemon.stop().finally(() => exit(1));
	});
	process.on("unhandledRejection", (e) => log(`unhandled: ${String(e)}`));
	if (!service)
		setInterval(() => {
			if (daemon.idleTooLong()) void stop("idle");
		}, 60_000).unref();
	// Hand back heap pages that bursts grew (V8 keeps them otherwise).
	// Started, not run to completion: a blocking full GC on a loaded machine
	// stalled every request for hundreds of ms.
	setInterval(() => fullGc(false, false), GC_EVERY_MS).unref();
	await new Promise(() => {});
}

/**
 * When setup installed the always-on service for this state folder, an
 * on-demand start (a client found no daemon) starts the service instead, so
 * there is never a second daemon. Falls back to on-demand when the service
 * manager refuses.
 */
async function deferToService(): Promise<boolean> {
	if (!(await serviceInstalledAsync())) return false;
	const { serviceEnv, startService } = await import("./setup/service.ts");
	if (await startService(serviceEnv())) {
		await logBurst(`daemon ${VERSION}: started the background service instead`);
		return true;
	}
	log(
		`daemon ${VERSION}: the background service did not start; running on demand`,
	);
	return false;
}

/**
 * Logs a line that a burst of clients may repeat (each a new process): once
 * a minute at most, with how many more there were, counted in a stamp file.
 */
async function logBurst(line: string) {
	const stamp = `${await checkedSocketPath()}.defer`;
	const now = Date.now();
	let first = 0;
	let count = 0;
	try {
		({ first, count } = JSON.parse(await readFile(stamp, "utf8")) as {
			first: number;
			count: number;
		});
	} catch {}
	try {
		if (now - first < 60_000) {
			await writeFile(stamp, JSON.stringify({ first, count: count + 1 }));
			return;
		}
		await writeFile(stamp, JSON.stringify({ first: now, count: 0 }));
	} catch {}
	log(
		count > 0 ? `${line} (and ${count} more times in the last minute)` : line,
	);
}

/**
 * The service found an on-demand daemon (started before the service was
 * installed): asks it to stop, then retries `claim` (the lock, or the
 * socket). False when the other daemon is a service too (it refuses), or
 * never lets go.
 */
async function takeOver(claim: () => Promise<boolean>): Promise<boolean> {
	const { DaemonClient } = await import("./client.ts");
	const { PROTOCOL_VERSION } = await import("./types.ts");
	const client = new DaemonClient();
	try {
		await client.connect(false);
		await client.call("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration: { role: "cli" },
		});
		await client.call("shutdown");
		log(`daemon ${VERSION} (service): stopped the on-demand daemon`);
	} catch (e) {
		log(`daemon ${VERSION} (service): socket busy: ${(e as Error).message}`);
		return false;
	} finally {
		client.close();
	}
	for (let i = 0; i < 40; i++) {
		await new Promise((r) => setTimeout(r, 250));
		if (await claim()) return true;
	}
	return false;
}

/** When setup installed a newer version than this copy, start that daemon instead. */
async function handOffToNewer(): Promise<boolean> {
	const installed = currentCli();
	try {
		await access(installed);
	} catch {
		return false;
	}
	try {
		// Compare folders, not files: in the split build this code sits in a
		// chunk next to cli.js, not in cli.js itself.
		if (
			(await realpath(dirname(installed))) ===
			(await realpath(dirname(fileURLToPath(import.meta.url))))
		)
			return false;
		const pkg = JSON.parse(
			await readFile(join(dirname(installed), "..", "package.json"), "utf8"),
		) as { version: string };
		if (!newer(pkg.version, VERSION)) return false;
		spawn(process.execPath, [...daemonRuntimeFlags(), installed, "daemon"], {
			detached: true,
			stdio: "ignore",
		}).unref();
		log(`daemon ${VERSION} handed off to installed ${pkg.version}`);
		return true;
	} catch {
		return false;
	}
}
