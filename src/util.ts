import { open, stat } from "node:fs/promises";
import { exec, type Lane } from "./exec.ts";

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
export async function runJson(
	cmd: string,
	args: string[],
	opts: {
		cwd?: string;
		timeout?: number;
		maxBuffer?: number;
		lane?: Lane;
	} = {},
): Promise<unknown> {
	const r = await exec(cmd, args, {
		timeoutMs: opts.timeout ?? 8000,
		maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
		lane: opts.lane ?? "background",
		...(opts.cwd ? { cwd: opts.cwd } : {}),
	});
	if (!r.ok) return null;
	try {
		return JSON.parse(r.stdout);
	} catch {
		return null;
	}
}

/** `len` bytes at `from` (or the end when `from` is "end"); "" on any error. */
async function sliceAsync(
	file: string,
	len: number,
	from: number | "end",
): Promise<string> {
	try {
		const fh = await open(file, "r");
		try {
			const size = (await fh.stat()).size;
			const n = Math.min(size, len);
			const buf = Buffer.alloc(n);
			await fh.read(buf, 0, n, from === "end" ? size - n : from);
			return buf.toString("utf8");
		} finally {
			await fh.close();
		}
	} catch {
		return "";
	}
}

/** Last `bytes` of a file, read asynchronously. */
export function tailAsync(file: string, bytes = 96 * 1024): Promise<string> {
	return sliceAsync(file, bytes, "end");
}

/** First `bytes` of a file, read asynchronously. */
export function headAsync(file: string, bytes = 256 * 1024): Promise<string> {
	return sliceAsync(file, bytes, 0);
}

/** A file's size and mtime, or null when it is gone. */
export async function statAsync(
	file: string,
): Promise<{ size: number; mtimeMs: number } | null> {
	try {
		const s = await stat(file);
		return { size: s.size, mtimeMs: s.mtimeMs };
	} catch {
		return null;
	}
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

/**
 * Runs a command and resolves with its stdout; rejects with a short stderr
 * message. User-triggered work (push, interrupt): it runs in the user lane.
 */
export async function run(
	cmd: string,
	args: string[],
	timeoutMs = 20_000,
	lane: Lane = "user",
): Promise<string> {
	const r = await exec(cmd, args, { timeoutMs, lane });
	if (r.ok) return r.stdout;
	throw new Error(`${cmd} failed: ${r.error ?? "unknown error"}`);
}
