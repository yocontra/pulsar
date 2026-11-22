import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranscriptSource } from "../transcripts/types.ts";
import { tailAsync } from "../util.ts";
import type { SessionRef } from "./types.ts";

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
 * The host session id of a pi-style agent. The extension registers by pid
 * (no `sessionId`) and reports the session as `resumeKey`
 * (`<harness>:<session id>`), which follows new, resumed and forked sessions.
 */
export function hostSessionId(agent: SessionRef): string | null {
	if (agent.sessionId) return agent.sessionId;
	const key = agent.meta?.resumeKey;
	const colon = key?.indexOf(":") ?? -1;
	return key && colon >= 0 && colon < key.length - 1
		? key.slice(colon + 1)
		: null;
}

/** Session files found by id, so a miss in the cwd folders walks every folder once. */
const byId = new Map<string, string>();

async function isFile(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null))?.isFile() ?? false;
}

/**
 * The file named for `sessionId` (`<time>_<id>.jsonl`) under
 * `~/<dir>/agent/sessions/`: the cwd's folders first, then every folder
 * (the agent may have moved to another folder since the session began).
 */
export async function piSessionFileById(
	dir: string,
	cwd: string | null,
	sessionId: string,
	home = homedir(),
): Promise<string | null> {
	const root = join(home, dir, "agent", "sessions");
	const cached = byId.get(`${root}\0${sessionId}`);
	if (cached && (await isFile(cached))) return cached;
	const suffix = `_${sessionId}.jsonl`;
	const look = async (folder: string) => {
		try {
			const f = (await readdir(folder)).find((n) => n.endsWith(suffix));
			return f ? join(folder, f) : null;
		} catch {
			return null;
		}
	};
	const first = cwd ? sessionFolderNames(cwd, home) : [];
	let found: string | null = null;
	for (const name of first) found ??= await look(join(root, name));
	if (!found) {
		let all: string[] = [];
		try {
			all = await readdir(root);
		} catch {}
		for (const name of all) {
			if (first.includes(name)) continue;
			found = await look(join(root, name));
			if (found) break;
		}
	}
	if (found) {
		if (byId.size > 1000) byId.clear();
		byId.set(`${root}\0${sessionId}`, found);
	}
	return found;
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
	if (sessionId) {
		const file = await piSessionFileById(dir, cwd, sessionId, home);
		if (file) return file;
	}
	if (!cwd) return null;
	const root = join(home, dir, "agent", "sessions");
	let newest: { file: string; t: number } | null = null;
	for (const name of sessionFolderNames(cwd, home)) {
		const folder = join(root, name);
		try {
			for (const f of await readdir(folder)) {
				if (!f.endsWith(".jsonl")) continue;
				const t = (await stat(join(folder, f))).mtimeMs;
				if (!newest || t > newest.t) newest = { file: join(folder, f), t };
			}
		} catch {
			// This naming scheme isn't used for this folder.
		}
	}
	return newest?.file ?? null;
}

/** The pi and omp folders, and whether the harness pads line 1 (omp). */
const PI_STYLE = { pi: ".pi", omp: ".omp" } as const;

/**
 * A pi-style agent's transcript. With a host session id: that session's
 * file, in this harness's folder or the other pi-style one (an omp session
 * an older extension registered as pi); else the newest file for its cwd.
 */
export async function locatePiStyle(
	harness: keyof typeof PI_STYLE,
	agent: SessionRef,
	home = process.env.HOME || homedir(),
): Promise<TranscriptSource | null> {
	const other = harness === "pi" ? "omp" : "pi";
	const source = (
		h: keyof typeof PI_STYLE,
		path: string,
		guess = false,
	): TranscriptSource => ({
		kind: "file",
		path,
		...(h === "omp" ? { headerLine: true } : {}),
		...(guess ? { guess: true } : {}),
	});
	const id = hostSessionId(agent);
	if (id) {
		for (const h of [harness, other] as const) {
			const file = await piSessionFileById(PI_STYLE[h], agent.cwd, id, home);
			if (file) return source(h, file);
		}
	}
	const file = await piSessionFile(PI_STYLE[harness], agent.cwd, null, home);
	return file ? source(harness, file, true) : null;
}

/** pi-style session log: the end of the newest session file for a folder ("" when none). */
export async function piSessionLog(
	dir: string,
	cwd: string | null,
): Promise<string> {
	const file = await piSessionFile(dir, cwd);
	return file ? tailAsync(file, 512 * 1024) : "";
}
