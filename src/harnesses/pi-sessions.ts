import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tail } from "../util.ts";

/**
 * Session folder names a pi-style harness may use for a working folder:
 * pi's `--<abs path with / as ->--`, and omp's home-relative `-<path under ~>`
 * (omp uses the `--…--` form only outside the home folder).
 */
export function sessionFolderNames(cwd: string, home = homedir()): string[] {
	const dashed = (p: string) => p.replace(/^\//, "").replace(/\//g, "-");
	const names = [`--${dashed(cwd)}--`];
	if (cwd === home) names.push("-");
	else if (cwd.startsWith(`${home}/`))
		names.push(`-${dashed(cwd.slice(home.length))}`);
	return names;
}

/**
 * pi-style session log: the newest session file for a folder under
 * `~/<dir>/agent/sessions/<folder>/*.jsonl` ("" when none). Shared by the pi
 * and omp drivers.
 */
export function piSessionLog(dir: string, cwd: string | null): string {
	if (!cwd) return "";
	const root = join(homedir(), dir, "agent", "sessions");
	let newest: { file: string; t: number } | null = null;
	for (const name of sessionFolderNames(cwd)) {
		const folder = join(root, name);
		try {
			for (const f of readdirSync(folder)) {
				if (!f.endsWith(".jsonl")) continue;
				const t = statSync(join(folder, f)).mtimeMs;
				if (!newest || t > newest.t) newest = { file: join(folder, f), t };
			}
		} catch {
			// This naming scheme isn't used for this folder.
		}
	}
	return newest ? tail(newest.file, 512 * 1024) : "";
}
