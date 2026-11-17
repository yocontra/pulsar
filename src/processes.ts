import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import type { Harness } from "./types.ts";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	args: string;
}

/** One `ps` call; returns every process keyed by pid. */
function processTable(): Map<number, ProcessInfo> {
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

/** Which harness a command line belongs to, if any. */
export function harnessOfArgs(args: string): Harness | null {
	const argv0 = args.split(/\s+/)[0] ?? "";
	const exe = basename(argv0).toLowerCase();
	if (exe === "claude" || /\/claude\/versions\//.test(argv0)) return "claude";
	if (exe === "codex" || exe === "codex-exec-server") return "codex";
	if (exe === "opencode" || exe.startsWith("opencode-")) return "opencode";
	if (/(^|\/)omp(\s|$)/.test(args) || args.includes("@oh-my-pi/")) return "omp";
	if (
		args.includes("pi-coding-agent") ||
		/(^|\/)pi(\s|$)/.test(args.split(/\s+/).slice(0, 2).join(" "))
	)
		return "pi";
	if (exe === "cursor" || args.includes("Cursor.app")) return "cursor";
	if (exe === "gemini" || args.includes("@google/gemini-cli")) return "gemini";
	if (args.includes("Visual Studio Code.app") || exe === "code")
		return "vscode";
	return null;
}

/** Walks up from `pid` to the first process that is a known harness. */
export function findHarnessAncestor(
	pid: number,
	table = processTable(),
): { harness: Harness; pid: number } | null {
	let current = table.get(pid);
	for (let depth = 0; current && depth < 16; depth++) {
		const parent = table.get(current.ppid);
		if (!parent || parent.pid <= 1) return null;
		const harness = harnessOfArgs(parent.args);
		if (harness) return { harness, pid: parent.pid };
		current = parent;
	}
	return null;
}

/** True when OpenCode's shared background server is running (never starts one). */
export function opencodeServiceRunning(table = processTable()): boolean {
	for (const p of table.values())
		if (/opencode(\S*)? serve\b.*--service/.test(p.args)) return true;
	return false;
}
