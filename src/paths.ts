import { lstat, mkdir, readdir, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { lazyCrypto } from "./lazy.ts";

/**
 * Root for all Pulsar state. Override with PULSAR_HOME (used by tests). Only
 * the path: `ensureStateDir` creates it.
 */
export function stateDir(): string {
	return (
		process.env.PULSAR_HOME ??
		join(
			process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"),
			"pulsar",
		)
	);
}

const made = new Map<string, Promise<void>>();

/** Creates a private folder once per process (later calls share the first). */
export function ensureDir(dir: string): Promise<void> {
	let p = made.get(dir);
	if (!p) {
		p = mkdir(dir, { recursive: true, mode: 0o700 }).then(
			() => {},
			(e) => {
				made.delete(dir);
				throw e;
			},
		);
		made.set(dir, p);
	}
	return p;
}

/** The state folder, created when missing. */
export async function ensureStateDir(): Promise<string> {
	const dir = stateDir();
	await ensureDir(dir);
	return dir;
}

/**
 * Longest unix socket path that binds everywhere: macOS's `sun_path` holds
 * 104 bytes with the NUL (Linux 108).
 */
export const MAX_SOCKET_PATH = 103;

/**
 * The daemon's socket: `<state>/bus.sock`, or, when that path is too long
 * to bind (a deep PULSAR_HOME), a short one derived from the state folder:
 * `<tmp>/pulsar-<uid>/<hash>.sock` in a 0700 folder this user owns. The
 * daemon and its clients compute the same path, so nothing is recorded.
 */
export function socketPath(): string {
	const state = stateDir();
	const path = join(state, "bus.sock");
	if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path;
	return shortSocketPath(state);
}

/** The short socket path for a state folder (only the name; see `checkedSocketPath`). */
function shortSocketPath(state: string): string {
	const uid = process.getuid?.() ?? 0;
	const hash = lazyCrypto()
		.createHash("sha256")
		.update(state)
		.digest("hex")
		.slice(0, 16);
	for (const base of [tmpdir(), "/tmp"]) {
		const path = join(base, `pulsar-${uid}`, `${hash}.sock`);
		if (Buffer.byteLength(path) <= MAX_SOCKET_PATH) return path;
	}
	throw new Error(`no socket path short enough for ${state}`);
}

/**
 * `socketPath`, with its folder made and checked: the state folder, or for a
 * short path a 0700 folder this user owns. Another user's folder (or a
 * symlink) in a shared /tmp is refused, by the daemon and its clients alike.
 */
export async function checkedSocketPath(): Promise<string> {
	const path = socketPath();
	const dir = dirname(path);
	await ensureDir(dir);
	if (dir === stateDir()) return path;
	const uid = process.getuid?.() ?? 0;
	const st = await lstat(dir);
	if (
		!st.isDirectory() ||
		(process.getuid && st.uid !== uid) ||
		(st.mode & 0o077) !== 0
	)
		throw new Error(`refusing socket folder ${dir}: not private to this user`);
	return path;
}

export function dbPath(): string {
	return join(stateDir(), "pulsar.db");
}

export function logPath(): string {
	return join(stateDir(), "daemon.log");
}

/** Where `pulsar setup` installs versions; agents run `<root>/current`. */
export function installRoot(): string {
	return (
		process.env.PULSAR_INSTALL_ROOT ??
		join(
			process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
			"pulsar",
		)
	);
}

/** An upgrade keeps at least this many of the newest installed builds... */
export const KEEP_BUILDS = 10;
/** ...and any installed in the last two days... */
export const KEEP_BUILD_MS = 2 * 24 * 60 * 60_000;
/** ...up to this many in all. */
export const MAX_BUILDS = 30;

/**
 * The installed builds an upgrade keeps (version folders under `root`,
 * newest first; see the limits above). The daemon serves these builds'
 * hashed app files to pages that still run them (src/transport/static.ts),
 * so a deploy never pulls the chunks from under an open app.
 */
export async function retainedBuilds(
	root = installRoot(),
	now = Date.now(),
): Promise<string[]> {
	let names: string[];
	try {
		names = await readdir(root);
	} catch {
		return [];
	}
	const found = await Promise.all(
		names
			.filter((name) => /^\d/.test(name))
			.map(async (name) => {
				try {
					const s = await stat(join(root, name));
					return s.isDirectory() ? { name, at: s.mtimeMs } : null;
				} catch {
					return null;
				}
			}),
	);
	const builds = found.filter((b) => b !== null);
	builds.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));
	return builds
		.filter((b, i) => i < KEEP_BUILDS || now - b.at < KEEP_BUILD_MS)
		.slice(0, MAX_BUILDS)
		.map((b) => b.name);
}

/** The installed `current` CLI, when setup has run on this machine. */
export function currentCli(): string {
	return join(installRoot(), "current", "dist", "cli.js");
}
