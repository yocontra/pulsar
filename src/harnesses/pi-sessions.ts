import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tail } from "../util.ts";

/**
 * pi-style session log: the newest session file for a folder in
 * `~/<dir>/agent/sessions/--<cwd with / as ->--/*.jsonl` ("" when none).
 * Shared by the pi and omp drivers (omp keeps pi's session layout).
 */
export function piSessionLog(dir: string, cwd: string | null): string {
	if (!cwd) return "";
	const root = join(homedir(), dir, "agent", "sessions");
	const folder = join(
		root,
		`--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`,
	);
	let file: string | null = null;
	try {
		const newest = readdirSync(folder)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({ f, t: statSync(join(folder, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t)[0];
		file = newest ? join(folder, newest.f) : null;
	} catch {
		file = null;
	}
	return file ? tail(file, 512 * 1024) : "";
}
