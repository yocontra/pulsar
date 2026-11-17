import { execFileSync } from "node:child_process";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	args: string;
}

/** One `ps` call; returns every process keyed by pid. */
export function processTable(): Map<number, ProcessInfo> {
	const table = new Map<number, ProcessInfo>();
	if (process.platform === "win32") return table;
	let out = "";
	try {
		out = execFileSync("ps", ["-axo", "pid=,ppid=,args="], {
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
		});
	} catch {
		return table;
	}
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

/** True when a process exists (EPERM means it exists but belongs to someone else). */
export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
