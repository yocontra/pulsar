import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec } from "../exec.ts";
import type { TranscriptSource } from "../transcripts/types.ts";
import { tailAsync } from "../util.ts";
import { piAgentDir } from "./pi-paths.ts";
import type { SessionRef } from "./types.ts";

/**
 * Session folder names a pi-style harness may use for a working folder:
 * pi's `--<abs path with / as ->--`, and omp's home-relative `-<path under ~>`
 * (omp uses the `--…--` form only outside the home folder).
 */
export function sessionFolderNames(cwd: string, home = homedir()): string[] {
	// `/` becomes `-`; other characters a folder name may not keep are tried
	// as `-` too (an unverified encoding costs one missed readdir).
	const forms = (p: string) => {
		const plain = p.replace(/^\//, "").replace(/\//g, "-");
		const strict = plain.replace(/[^A-Za-z0-9_.-]/g, "-");
		const nodots = strict.replace(/\./g, "-");
		return [...new Set([plain, strict, nodots])];
	};
	const names = forms(cwd).map((d) => `--${d}--`);
	if (cwd === home) names.push("-");
	else if (cwd.startsWith(`${home}/`))
		for (const d of forms(cwd.slice(home.length))) names.push(`-${d}`);
	return [...new Set(names)];
}

/** Lists the files a process has open (`lsof`); [] when it can't tell. */
export type OpenFiles = (pid: number) => Promise<string[]>;

const lsofOpenFiles: OpenFiles = async (pid) => {
	if (process.platform === "win32") return [];
	const r = await exec("lsof", ["-n", "-P", "-w", "-Fn", "-p", String(pid)], {
		timeoutMs: 3000,
		maxBuffer: 4 * 1024 * 1024,
		lane: "background",
	});
	// lsof exits 1 when it could not read some descriptors: use what it listed.
	return r.stdout
		.split("\n")
		.filter((l) => l.startsWith("n/"))
		.map((l) => l.slice(1));
};

/** How processes' open files are listed (tests replace `fn`; never the real lsof there). */
export const openFilesSource: { fn: OpenFiles } = { fn: lsofOpenFiles };

/** A process's open files, briefly (a watcher's tick must not run lsof each time). */
const openByPid = new Map<
	number,
	{ at: number; list: OpenFiles; files: Promise<string[]> }
>();
const PID_CACHE_MS = 5000;

function cachedOpenFiles(pid: number, openFiles: OpenFiles): Promise<string[]> {
	let hit = openByPid.get(pid);
	if (!hit || Date.now() - hit.at >= PID_CACHE_MS || hit.list !== openFiles) {
		if (openByPid.size > 1000) openByPid.clear();
		hit = {
			at: Date.now(),
			list: openFiles,
			files: openFiles(pid).catch(() => []),
		};
		openByPid.set(pid, hit);
	}
	return hit.files;
}

function primarySessionFile(path: string, root: string) {
	// A file one level deeper belongs to a subagent.
	return path.endsWith(".jsonl") && dirname(dirname(path)) === root;
}

/** The most recently updated primary session file open in a pi or omp process. */
export async function openSessionFile(
	dir: ".omp" | ".pi",
	pid: number,
	home = homedir(),
	openFiles: OpenFiles = openFilesSource.fn,
): Promise<string | null> {
	const root = join(
		piAgentDir(dir === ".omp" ? "omp" : "pi", home),
		"sessions",
	);
	let file: string | null = null;
	let newest = -1;
	for (const path of await cachedOpenFiles(pid, openFiles)) {
		if (!primarySessionFile(path, root)) continue;
		const t = (await stat(path).catch(() => null))?.mtimeMs ?? -1;
		if (t > newest) {
			newest = t;
			file = path;
		}
	}
	return file;
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
	dir: ".omp" | ".pi",
	cwd: string | null,
	sessionId: string,
	home = homedir(),
): Promise<string | null> {
	const root = join(
		piAgentDir(dir === ".omp" ? "omp" : "pi", home),
		"sessions",
	);
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
	dir: ".omp" | ".pi",
	cwd: string | null,
	sessionId: string | null = null,
	home = homedir(),
): Promise<string | null> {
	if (sessionId) {
		const file = await piSessionFileById(dir, cwd, sessionId, home);
		if (file) return file;
	}
	if (!cwd) return null;
	const root = join(
		piAgentDir(dir === ".omp" ? "omp" : "pi", home),
		"sessions",
	);
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
 * A pi-style agent's transcript, in this harness's folder or the other
 * pi-style one (an omp session an older extension registered as pi):
 * Use the sole primary log held by a PID-keyed process before consulting its
 * resume key. With a durable session ID, look up that ID first. Legacy
 * transcript callers can fall back to the latest file in the working folder.
 */
export async function locatePiStyle(
	harness: keyof typeof PI_STYLE,
	agent: SessionRef,
	home = process.env.HOME || homedir(),
	openFiles: OpenFiles = openFilesSource.fn,
	exactOnly = false,
): Promise<TranscriptSource | null> {
	const other = harness === "pi" ? "omp" : "pi";
	const harnesses = [harness, other] as const;
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
	if (!agent.sessionId && agent.pid) {
		// Extension resume keys can survive a switch. A sole held primary log
		// identifies the current conversation of a PID-keyed agent directly.
		const paths = new Set(await cachedOpenFiles(agent.pid, openFiles));
		const seen = new Set<string>();
		const held = harnesses.flatMap((h) => {
			const root = join(piAgentDir(h, home), "sessions");
			if (seen.has(root)) return [];
			seen.add(root);
			return [...paths]
				.filter((path) => primarySessionFile(path, root))
				.map((path) => ({ h, path }));
		});
		if (held.length > 0) {
			const exact =
				held.length === 1
					? held
					: held.filter(({ path }) => id && path.endsWith(`_${id}.jsonl`));
			const match = exact.length === 1 ? exact[0] : undefined;
			if (match && (await isFile(match.path)))
				return source(match.h, match.path);
			if (exactOnly) return null;
		}
	}
	if (id) {
		for (const h of harnesses) {
			const file = await piSessionFileById(PI_STYLE[h], agent.cwd, id, home);
			if (file) return source(h, file);
		}
	}
	if (exactOnly) return null;
	if (agent.pid) {
		for (const h of harnesses) {
			const file = await openSessionFile(
				PI_STYLE[h],
				agent.pid,
				home,
				openFiles,
			);
			if (file) return source(h, file);
		}
	}
	const file = await piSessionFile(PI_STYLE[harness], agent.cwd, null, home);
	return file ? source(harness, file, true) : null;
}

/**
 * A pi-style agent's session log: the end of its session file, found as
 * `locatePiStyle` finds it ("" when none).
 */
export async function piSessionLog(
	harness: keyof typeof PI_STYLE,
	agent: SessionRef,
): Promise<string> {
	const source = await locatePiStyle(harness, agent);
	return source?.kind === "file" ? tailAsync(source.path, 512 * 1024) : "";
}
