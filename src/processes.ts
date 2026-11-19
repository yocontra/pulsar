import { exec, type Lane } from "./exec.ts";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	args: string;
}

/**
 * One fresh `ps` call; every process keyed by pid. Empty when `ps` fails.
 * Agent-side code (MCP server, hook, CLI) uses this; the daemon shares
 * `processSnapshot`.
 */
export async function processTable(): Promise<Map<number, ProcessInfo>> {
	if (process.platform === "win32") return new Map();
	// Bounded: ps can stall on a busy machine (reading the args of processes
	// in odd states).
	const r = await exec("ps", ["-axo", "pid=,ppid=,args="], {
		maxBuffer: 32 * 1024 * 1024,
		timeoutMs: 5000,
		lane: "user",
	});
	return r.ok ? parsePs(r.stdout) : new Map();
}

function parsePs(out: string): Map<number, ProcessInfo> {
	const table = new Map<number, ProcessInfo>();
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (m)
			table.set(Number(m[1]), {
				pid: Number(m[1]),
				ppid: Number(m[2]),
				args: m[3]!,
			});
	}
	return table;
}

/** The last `ps` result while it is fresh; cleared when a `ps` fails. */
let snapshot: { at: number; table: Map<number, ProcessInfo> } | null = null;
/** The last good table, kept through failures for `processSnapshot`. */
let lastGood: Map<number, ProcessInfo> | null = null;
let pending: Promise<Map<number, ProcessInfo> | null> | null = null;

/**
 * The process table for the daemon, without blocking: one `ps` shared by
 * every caller within `maxAgeMs` (a scan's drivers all read the same one),
 * and concurrent callers wait on the same call. A failed or timed-out `ps`
 * keeps the last good table rather than reporting no processes.
 */
export async function processSnapshot(
	maxAgeMs = 2000,
	lane: Lane = "background",
): Promise<Map<number, ProcessInfo>> {
	return (
		(await freshProcessSnapshot(maxAgeMs, lane)) ??
		lastGood ??
		new Map<number, ProcessInfo>()
	);
}

/**
 * Like `processSnapshot`, but null when `ps` failed now (no fallback to an
 * older table), for callers that must tell "no such process" from "could
 * not look". A table with no rows counts as failed: `ps` always lists itself.
 */
export function freshProcessSnapshot(
	maxAgeMs = 2000,
	lane: Lane = "background",
): Promise<Map<number, ProcessInfo> | null> {
	if (process.platform === "win32") return Promise.resolve(new Map());
	// A clock set back makes the age negative: stale, not fresh forever.
	const age = snapshot ? Date.now() - snapshot.at : -1;
	if (snapshot && age >= 0 && age < maxAgeMs)
		return Promise.resolve(snapshot.table);
	pending ??= exec("ps", ["-axo", "pid=,ppid=,args="], {
		maxBuffer: 32 * 1024 * 1024,
		timeoutMs: 5000,
		lane,
	})
		.then((r) => {
			const table = r.ok ? parsePs(r.stdout) : null;
			if (!table?.size) {
				snapshot = null;
				return null;
			}
			snapshot = { at: Date.now(), table };
			lastGood = table;
			return table;
		})
		.finally(() => {
			pending = null;
		});
	return pending;
}

/** True when a process exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * When a process started (`ps -o lstart`), or null when unknown (no such
 * process, or a `ps` without lstart, as in some minimal containers).
 * Together with the pid it names one process: pids are reused, start times
 * are not.
 */
export async function processStart(pid: number): Promise<string | null> {
	// A fixed zone and locale: lstart is printed in both, and every caller
	// (a daemon, a client, a shell with its own TZ) must read the same text.
	// Generous: it runs before the daemon serves, and a timeout reads as
	// "unknown" (a live lock holder is then trusted by its pid alone).
	const r = await exec("ps", ["-o", "lstart=", "-p", String(pid)], {
		timeoutMs: 5000,
		lane: "user",
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			TZ: "UTC",
			LC_ALL: "C",
		},
	});
	if (!r.ok) return null;
	return r.stdout.trim().replace(/\s+/g, " ") || null;
}
