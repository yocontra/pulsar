import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Root for all pulsar state. Override with PULSAR_HOME (used by tests). */
export function stateDir(): string {
	const dir =
		process.env.PULSAR_HOME ??
		join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"pulsar",
		);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

export function socketPath(): string {
	return join(stateDir(), "bus.sock");
}

export function dbPath(): string {
	return join(stateDir(), "pulsar.db");
}

export function logPath(): string {
	return join(stateDir(), "daemon.log");
}
