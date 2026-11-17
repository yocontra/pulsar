import { appendFileSync } from "node:fs";
import { Daemon } from "./daemon.ts";
import { logPath } from "./paths.ts";
import { VERSION } from "./version.ts";

function log(line: string) {
	try {
		appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

/** Runs the daemon until it is idle for a long time or told to stop. */
export async function runDaemon() {
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
	process.on("uncaughtException", (e) =>
		log(`uncaught: ${e.stack ?? e.message}`),
	);
	process.on("unhandledRejection", (e) => log(`unhandled: ${String(e)}`));
	setInterval(() => {
		if (daemon.idleTooLong()) void stop("idle");
	}, 60_000).unref();
	await new Promise(() => {});
}
