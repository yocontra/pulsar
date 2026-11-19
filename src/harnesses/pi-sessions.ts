import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { tailAsync } from "../util.ts";

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
 * pi-style session file for a folder under `~/<dir>/agent/sessions/<folder>/`:
 * the one named for `sessionId` (`<time>_<id>.jsonl`) when given and found,
 * else the newest. Shared by the pi and omp drivers.
 */
export async function piSessionFile(
	dir: string,
	cwd: string | null,
	sessionId: string | null = null,
	home = homedir(),
): Promise<string | null> {
	if (!cwd) return null;
	const root = join(home, dir, "agent", "sessions");
	let newest: { file: string; t: number } | null = null;
	for (const name of sessionFolderNames(cwd, home)) {
		const folder = join(root, name);
		try {
			for (const f of await readdir(folder)) {
				if (!f.endsWith(".jsonl")) continue;
				if (sessionId && f.endsWith(`_${sessionId}.jsonl`))
					return join(folder, f);
				const t = (await stat(join(folder, f))).mtimeMs;
				if (!newest || t > newest.t) newest = { file: join(folder, f), t };
			}
		} catch {
			// This naming scheme isn't used for this folder.
		}
	}
	return newest?.file ?? null;
}

/** pi-style session log: the end of the newest session file for a folder ("" when none). */
export async function piSessionLog(
	dir: string,
	cwd: string | null,
): Promise<string> {
	const file = await piSessionFile(dir, cwd);
	return file ? tailAsync(file, 512 * 1024) : "";
}
