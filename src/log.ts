import { appendFile } from "node:fs/promises";
import { ensureStateDir, logPath } from "./paths.ts";

let queue: Promise<void> = Promise.resolve();

/**
 * Appends a line to the daemon log. Never throws and never blocks: lines are
 * written in order in the background (`flushLog` waits for them).
 */
export function daemonLog(line: string) {
	const text = `${new Date().toISOString()} ${line}\n`;
	queue = queue
		.then(() => ensureStateDir())
		.then(() => appendFile(logPath(), text))
		.catch(() => {});
}

/** Resolves once every line logged so far is written (before an exit). */
export function flushLog(): Promise<void> {
	return queue;
}

/** Like `daemonLog`, but only when PULSAR_DEBUG is set (for noisy or polled paths). */
export function debugLog(line: string) {
	if (process.env.PULSAR_DEBUG) daemonLog(line);
}
