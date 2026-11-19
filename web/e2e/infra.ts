import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Test infrastructure shared by the Playwright configs.
 *
 * Ports: each run picks free ports when the config loads and keeps them in
 * the environment, so Playwright's worker processes (which load the config
 * again and inherit the environment) agree, and runs in other worktrees on
 * the same machine never take each other's server. A port set in the
 * environment beforehand is kept.
 */
export function runPort(name: string): number {
	if (!process.env[name]) process.env[name] = String(freePort());
	return Number(process.env[name]);
}

function freePort(): number {
	const out = execFileSync(
		process.execPath,
		[
			"-e",
			"const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})",
		],
		{ encoding: "utf8" },
	);
	const port = Number(out);
	if (!Number.isInteger(port) || port <= 0)
		throw new Error(`could not find a free port (${out})`);
	return port;
}

/** Where the e2e servers log (gitignored; outside test-results, which Playwright clears). */
export const LOG_DIR = fileURLToPath(new URL("../e2e-logs/", import.meta.url));

/** The log file for one server, created fresh; returns its absolute path. */
export function serverLog(name: string): string {
	mkdirSync(LOG_DIR, { recursive: true });
	return `${LOG_DIR}${name}.log`;
}

/** A shell-quoted path for a webServer command. */
export const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
