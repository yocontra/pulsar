import { existsSync, readFileSync } from "node:fs";
import type { FullResult, Reporter } from "@playwright/test/reporter";

/**
 * Prints the tail of the e2e server's log when a run fails, so a server that
 * died (for example under load) shows why. Options: `{ file, lines? }`.
 */
export default class ServerLogReporter implements Reporter {
	private readonly file: string;
	private readonly lines: number;

	constructor(opts: { file: string; lines?: number }) {
		this.file = opts.file;
		this.lines = opts.lines ?? 60;
	}

	onEnd(result: FullResult) {
		if (result.status === "passed" || !existsSync(this.file)) return;
		const tail = readFileSync(this.file, "utf8")
			.trimEnd()
			.split("\n")
			.slice(-this.lines)
			.join("\n");
		process.stdout.write(
			`\n--- last ${this.lines} lines of ${this.file} ---\n${tail || "(empty)"}\n--- end of server log ---\n`,
		);
	}

	printsToStdio() {
		return false;
	}
}
