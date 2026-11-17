import { appendFileSync } from "node:fs";
import { logPath } from "./paths.ts";

/** Appends a line to the daemon log. Never throws. */
export function daemonLog(line: string) {
	try {
		appendFileSync(logPath(), `${new Date().toISOString()} ${line}\n`);
	} catch {}
}

/** Like `daemonLog`, but only when PULSAR_DEBUG is set (for noisy or polled paths). */
export function debugLog(line: string) {
	if (process.env.PULSAR_DEBUG) daemonLog(line);
}
