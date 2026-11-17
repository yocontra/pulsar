import { spawn } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Daemon } from "./daemon.ts";
import { currentCli, logPath } from "./paths.ts";
import { newer } from "./util.ts";
import { VERSION } from "./version.ts";

function log(line: string) {
	try {
		appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

/** Runs the daemon until it is idle for a long time or told to stop. */
export async function runDaemon() {
	if (handOffToNewer()) process.exit(0);
	const daemon = new Daemon();
	const started = await daemon.start();
	if (!started) {
		// Another daemon already serves this machine.
		process.exit(0);
	}
	log(`daemon ${VERSION} started (pid ${process.pid})`);
	const stop = async (why: string) => {
		log(`daemon stopping: ${why}`);
		await daemon.stop();
		process.exit(0);
	};
	process.on("SIGTERM", () => void stop("SIGTERM"));
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("uncaughtException", (e) => {
		// State may be half-changed; exit so the next client starts a fresh daemon.
		log(`uncaught: ${e.stack ?? e.message}`);
		void daemon.stop().finally(() => process.exit(1));
	});
	process.on("unhandledRejection", (e) => log(`unhandled: ${String(e)}`));
	setInterval(() => {
		if (daemon.idleTooLong()) void stop("idle");
	}, 60_000).unref();
	await new Promise(() => {});
}

/** When setup installed a newer version than this copy, start that daemon instead. */
function handOffToNewer(): boolean {
	const installed = currentCli();
	if (!existsSync(installed)) return false;
	try {
		if (
			realpathSync(installed) === realpathSync(fileURLToPath(import.meta.url))
		)
			return false;
		const pkg = JSON.parse(
			readFileSync(join(dirname(installed), "..", "package.json"), "utf8"),
		) as { version: string };
		if (!newer(pkg.version, VERSION)) return false;
		spawn(process.execPath, [installed, "daemon"], {
			detached: true,
			stdio: "ignore",
		}).unref();
		log(`daemon ${VERSION} handed off to installed ${pkg.version}`);
		return true;
	} catch {
		return false;
	}
}
