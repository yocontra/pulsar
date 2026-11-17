import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
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

/** Reads `len` bytes at `from` (or the end when `from` is "end"); "" on any error. */
function slice(file: string, len: number, from: number | "end"): string {
	try {
		const size = statSync(file).size;
		const n = Math.min(size, len);
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(n);
			readSync(fd, buf, 0, n, from === "end" ? size - n : from);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** Last `bytes` of a file (transcripts can be large). */
export function tail(file: string, bytes = 96 * 1024): string {
	return slice(file, bytes, "end");
}

/** First `bytes` of a file. */
export function head(file: string, bytes = 256 * 1024): string {
	return slice(file, bytes, 0);
}

/** The last model id written in a JSONL log, skipping placeholders like `<synthetic>`. */
export function lastModel(text: string): string | null {
	// `model` (Claude, Codex, pi/omp messages, omp's model_change as provider/id)
	// and `modelId` (pi's model_change); the last one written wins.
	const re = /"model(?:Id)?"\s*:\s*"([^"<>]+)"/g;
	let found: string | null = null;
	for (let m = re.exec(text); m; m = re.exec(text)) found = m[1] ?? found;
	if (!found) return null;
	// omp writes `provider/model`; keep ids consistent across harnesses.
	const slash = found.lastIndexOf("/");
	return slash >= 0 ? found.slice(slash + 1) || found : found;
}

/** Runs a command and resolves with its stdout; rejects with a short stderr message. */
export function run(
	cmd: string,
	args: string[],
	timeoutMs = 20_000,
): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err)
					reject(
						new Error(
							`${cmd} failed: ${String(stderr || err.message)
								.trim()
								.slice(0, 300)}`,
						),
					);
				else resolve(stdout);
			},
		);
	});
}
