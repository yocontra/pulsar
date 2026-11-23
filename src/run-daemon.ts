import { spawn } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon, DaemonLock } from "./daemon.ts";
import { serviceClaim } from "./daemon-lock.ts";
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
	const socket = await checkedSocketPath();
	// The service claims the machine before it takes the lock, and holds the
	// claim while it runs: an on-demand start (a client found no socket)
	// steps aside instead of racing it for the lock.
	const claim = serviceClaim(socket);
	if (service) await claim.acquire();
	const leave = async (code: number): Promise<never> => {
		if (service) await claim.release();
		return exit(code);
	};
	if (!service && (await claim.heldByLive())) {
		await logBurst(
			`daemon ${VERSION}: the background service is running or starting; not running on demand`,
		);
		await exit(0);
	}
	if (!service && (await deferToService())) await exit(0);
	if (!service && (await handOffToNewer())) await exit(0);
	// The lock first, before anything opens the database: concurrent starts
	// (several clients finding no daemon at once) leave exactly one.
	const lock = new DaemonLock(socket);
	let locked = await lock.acquire();
	if (!locked && service)
		locked = await serviceTakeOver(
			() => lock.acquire(),
			() => lock.holder(),
			leave,
		);
	if (!locked) await exit(0);
	const daemon = new Daemon({ serviceMode: service, lock });
	let started = await daemon.start();
	// An older daemon that takes no lock (pulsar 1.x) may still hold the socket.
	if (!started && service)
		started = await serviceTakeOver(
			() => daemon.start(),
			async () => null,
			leave,
		);
	if (!started) await exit(0);
	log(
		`daemon ${VERSION} started (pid ${process.pid}${service ? ", service mode" : ""})`,
	);
	const stop = async (why: string) => {
		log(`daemon stopping: ${why}`);
		await daemon.stop();
		await leave(0);
	};
	// Lost the socket to another daemon (it already stopped serving): exit.
	// A service exits with an error, so launchd/systemd start it again and
	// it takes the socket back (or yields to another service).
	daemon.onOrphan = () => {
		log("daemon exiting: another daemon owns the socket");
		void leave(service ? 1 : 0);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("uncaughtException", (e) => {
		// State may be half-changed; exit so the next client starts a fresh daemon.
		log(`uncaught: ${e.stack ?? e.message}`);
		void daemon.stop().finally(() => leave(1));
	});
	process.on("unhandledRejection", (e) => log(`unhandled: ${String(e)}`));
	if (!service) {
		setInterval(() => {
			if (daemon.idleTooLong()) void stop("idle");
		}, 60_000).unref();
		// The service manager refused to start the service (or it stopped):
		// keep asking. Once it runs, the service takes the socket from this one.
		retryService();
	}
	// Hand back heap pages that bursts grew (V8 keeps them otherwise).
	// Started, not run to completion: a blocking full GC on a loaded machine
	// stalled every request for hundreds of ms.
	setInterval(() => fullGc(false, false), GC_EVERY_MS).unref();
	await new Promise(() => {});
}

/** How often an on-demand daemon asks the service manager to start the service. */
const SERVICE_RETRY_MS = 60_000;

/** While setup's service is installed, asks launchd/systemd to start it now and then. */
function retryService() {
	let lastWhy: string | null = null;
	setInterval(async () => {
		if (!(await serviceInstalledAsync())) return;
		const { serviceEnv, startService } = await import("./setup/service.ts");
		const r = await startService(serviceEnv());
		if (r.ok || r.why === lastWhy) return;
		lastWhy = r.why;
		log(
			`daemon ${VERSION}: the background service still did not start: ${r.why}`,
		);
	}, SERVICE_RETRY_MS).unref();
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
	const r = await startService(serviceEnv());
	if (r.ok) {
		await logBurst(`daemon ${VERSION}: started the background service instead`);
		return true;
	}
	log(
		`daemon ${VERSION}: the background service did not start (${r.why}); running on demand`,
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

/** How long the service keeps trying to take the socket before it exits to be restarted. */
const TAKEOVER_MS = 60_000;

/**
 * The service found the lock or socket taken: takes it over, or leaves.
 * Another service (it refuses `shutdown`) keeps it: exit 0, so launchd/
 * systemd (restart on failure only) leave it alone. An on-demand daemon that
 * never lets go (clients keep starting new ones): exit 1, so the service
 * manager starts the service again; never exit 0, which leaves the machine
 * with no service at all.
 */
async function serviceTakeOver(
	claim: () => Promise<boolean>,
	holder: () => Promise<number | null>,
	leave: (code: number) => Promise<never>,
): Promise<boolean> {
	const r = await takeOver(claim, holder);
	if (r === "claimed") return true;
	if (r === "refused") {
		log(
			`daemon ${VERSION} (service): another service daemon serves this machine`,
		);
		return leave(0);
	}
	log(
		`daemon ${VERSION} (service): could not take the socket in ${TAKEOVER_MS / 1000} s; exiting so the service manager starts it again`,
	);
	return leave(1);
}

/**
 * Asks the daemon on the socket to stop (an on-demand daemon does; a
 * service refuses) and claims the lock or socket once it lets go. Asks
 * again whenever another daemon takes its place.
 */
export async function takeOver(
	claim: () => Promise<boolean>,
	holder: () => Promise<number | null>,
	opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<"claimed" | "refused" | "failed"> {
	const deadline = Date.now() + (opts.timeoutMs ?? TAKEOVER_MS);
	const pollMs = opts.pollMs ?? 100;
	let busy: string | null = null;
	while (Date.now() < deadline) {
		if (await claim()) return "claimed";
		const was = await holder();
		const asked = await askToStop();
		if (asked === "refused") return "refused";
		if (asked !== "stopped" && asked !== busy) {
			busy = asked;
			log(`daemon ${VERSION} (service): socket busy: ${asked}`);
		}
		// Claim as soon as it lets go; ask again when a new daemon took its place.
		const until = Math.min(deadline, Date.now() + 5_000);
		while (Date.now() < until) {
			await new Promise((r) => setTimeout(r, pollMs));
			if (await claim()) return "claimed";
			const now = await holder();
			if (now !== null && now !== was) break;
		}
	}
	return "failed";
}

/** "stopped", "refused" (a service), or why the socket did not answer. */
async function askToStop(): Promise<string> {
	const { DaemonClient } = await import("./client.ts");
	const { PROTOCOL_VERSION } = await import("./types.ts");
	const { RpcError } = await import("./rpc.ts");
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
		return "stopped";
	} catch (e) {
		if (e instanceof RpcError && e.code === "service_mode") return "refused";
		return (e as Error).message;
	} finally {
		client.close();
	}
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
