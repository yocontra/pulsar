import { readFileSync } from "node:fs";
import type { FullResult, Reporter } from "@playwright/test/reporter";
import { LOG_DIR, workerLogs } from "./infra.ts";

/**
 * Prints the tail of the e2e servers' logs when a run fails, so a server that
 * died (for example under load) shows why. Options: `{ name, lines? }`: the
 * logs are `e2e-logs/<name>-w<worker>.log`, one per worker.
 */
export default class ServerLogReporter implements Reporter {
	private readonly name: string;
	private readonly lines: number;

	constructor(opts: { name: string; lines?: number }) {
		this.name = opts.name;
		this.lines = opts.lines ?? 60;
	}

	onEnd(result: FullResult) {
		if (result.status === "passed") return;
		for (const f of workerLogs(this.name)) {
			const tail = readFileSync(`${LOG_DIR}${f}`, "utf8")
				.trimEnd()
				.split("\n")
				.slice(-this.lines)
				.join("\n");
			process.stdout.write(
				`\n--- last ${this.lines} lines of ${LOG_DIR}${f} ---\n${tail || "(empty)"}\n--- end of server log ---\n`,
			);
		}
	}

	printsToStdio() {
		return false;
	}
}
