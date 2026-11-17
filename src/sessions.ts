import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "./log.ts";
import { opencodeServiceRunning } from "./processes.ts";

interface ClaudeSessionRecord {
	pid: number;
	sessionId?: string;
	cwd?: string;
	name?: string;
	status?: string;
	messagingSocketPath?: string;
	kind?: string;
}

export function claudeSessionsDir(): string {
	return join(
		process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
		"sessions",
	);
}

export function readClaudeSession(pid: number): ClaudeSessionRecord | null {
	try {
		return JSON.parse(
			readFileSync(join(claudeSessionsDir(), `${pid}.json`), "utf8"),
		) as ClaudeSessionRecord;
	} catch (e) {
		// ENOENT is a session that ended; anything else is a file we cannot read.
		if ((e as NodeJS.ErrnoException).code !== "ENOENT")
			debugLog(
				`claude session ${pid}.json unreadable: ${(e as Error).message}`,
			);
		return null;
	}
}

/**
 * Codex threads a codex process is writing, best guess first. Codex does not
 * tell MCP servers their thread id, but it holds each thread's
 * `rollout-<time>-<thread uuid>.jsonl` open. The app-server daemon serves many
 * threads from one process, so candidates whose recorded cwd matches come
 * first, newest first; the daemon refuses a thread another session claimed.
 */
function codexThreadIds(pid: number, cwd: string | null): string[] {
	let out = "";
	try {
		out = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
	} catch {
		return [];
	}
	const candidates: Array<{ id: string; cwdMatch: boolean; mtime: number }> =
		[];
	for (const line of out.split("\n")) {
		if (!line.startsWith("n") || !/rollout-.*\.jsonl$/.test(line)) continue;
		const file = line.slice(1);
		const id =
			/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
				file,
			)?.[1];
		if (!id) continue;
		try {
			const head = readFileSync(file, "utf8").slice(0, 8192);
			if (head.includes("parent_thread_id")) continue;
			const recorded = /"cwd":"([^"]+)"/.exec(head)?.[1] ?? null;
			if (recorded) codexThreadCwds.set(id, recorded);
			candidates.push({
				id,
				cwdMatch: !!cwd && recorded === cwd,
				mtime: statSync(file).mtimeMs,
			});
		} catch {}
	}
	return candidates
		.sort(
			(a, b) => Number(b.cwdMatch) - Number(a.cwdMatch) || b.mtime - a.mtime,
		)
		.map((c) => c.id);
}

/** Each Codex thread's folder, recorded by `codexThreadIds` from its rollout. */
const codexThreadCwds = new Map<string, string>();

/** The folder a Codex thread works in, from its rollout (not the MCP server's own folder). */
export function codexThreadCwd(threadId: string): string | null {
	return codexThreadCwds.get(threadId) ?? null;
}

/** The best Codex thread guess for a process, skipping ones already claimed. */
export function codexThreadId(
	pid: number,
	cwd: string | null,
	exclude: Set<string> = new Set(),
): string | null {
	return codexThreadIds(pid, cwd).find((id) => !exclude.has(id)) ?? null;
}

/** The folder an OpenCode session works in, from its server. */
export function opencodeSessionDir(sessionId: string): string | null {
	if (!opencodeServiceRunning()) return null;
	try {
		const out = execFileSync(
			"opencode",
			["api", "GET", `/api/session/${sessionId}`],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
			},
		);
		type Info = { directory?: string; location?: { directory?: string } };
		const raw = JSON.parse(out) as Info & { data?: Info };
		const info = raw.data ?? raw;
		return info.location?.directory ?? info.directory ?? null;
	} catch {
		return null;
	}
}
