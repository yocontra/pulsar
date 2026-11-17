import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Absolute path of a command on PATH, or null. */
export function which(cmd: string): string | null {
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		const full = join(dir, cmd);
		if (dir && existsSync(full)) return full;
	}
	return null;
}

/** True when semver `a` is newer than `b` (prereleases count as older). */
export function newer(a: string, b: string): boolean {
	const parse = (v: string) => {
		const [core, pre] = v.split("-", 2);
		return {
			nums: (core ?? "").split(".").map((n) => Number(n) || 0),
			pre: pre ?? null,
		};
	};
	const x = parse(a);
	const y = parse(b);
	for (let i = 0; i < 3; i++) {
		const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
		if (d !== 0) return d > 0;
	}
	if (x.pre === y.pre) return false;
	if (x.pre === null) return true;
	if (y.pre === null) return false;
	return x.pre > y.pre;
}

/** Runs a command and parses its stdout as JSON; null when it fails or prints no JSON. */
export function runJson(
	cmd: string,
	args: string[],
	opts: { cwd?: string; timeout?: number; maxBuffer?: number } = {},
): Promise<unknown> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: 8000, maxBuffer: 8 * 1024 * 1024, ...opts },
			(err, stdout) => {
				if (err) return resolve(null);
				try {
					resolve(JSON.parse(stdout));
				} catch {
					resolve(null);
				}
			},
		);
	});
}
