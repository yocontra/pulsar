import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { opencodeServiceRunning } from "./processes.ts";
import type { Harness } from "./types.ts";
import { runJson } from "./util.ts";

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

/** Claude Code transcript: ~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl. */
export function claudeTranscript(
	cwd: string | null,
	sessionId: string,
): string | null {
	if (!cwd) return null;
	const base = join(
		process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
		"projects",
	);
	const file = join(
		base,
		cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${sessionId}.jsonl`,
	);
	return existsSync(file) ? file : null;
}

const codexFiles = new Map<string, string>();

/** Codex rollout: `rollout-…-<thread>.jsonl` in the last month of ~/.codex/sessions. */
export function codexRollout(threadId: string): string | null {
	const cached = codexFiles.get(threadId);
	if (cached && existsSync(cached)) return cached;
	const root = join(
		process.env.CODEX_HOME ?? join(homedir(), ".codex"),
		"sessions",
	);
	try {
		const days: string[] = [];
		for (const y of readdirSync(root).sort().reverse().slice(0, 2))
			for (const m of readdirSync(join(root, y)).sort().reverse().slice(0, 2))
				for (const d of readdirSync(join(root, y, m))
					.sort()
					.reverse())
					days.push(join(root, y, m, d));
		for (const dir of days.slice(0, 31)) {
			const file = readdirSync(dir).find((f) =>
				f.endsWith(`${threadId}.jsonl`),
			);
			if (file) {
				codexFiles.set(threadId, join(dir, file));
				return join(dir, file);
			}
		}
	} catch {}
	return null;
}

/** pi / omp: the newest session file for a folder (`sessions/--<cwd with / as ->--/*.jsonl`). */
export function piSessionFile(
	harness: Harness,
	cwd: string | null,
): string | null {
	if (!cwd || (harness !== "pi" && harness !== "omp")) return null;
	const root = join(
		homedir(),
		harness === "pi" ? ".pi" : ".omp",
		"agent",
		"sessions",
	);
	const dir = join(root, `--${cwd.replace(/^\//, "").replace(/\//g, "-")}--`);
	try {
		const newest = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.t - a.t)[0];
		return newest ? join(dir, newest.f) : null;
	} catch {
		return null;
	}
}

/** OpenCode: a session's messages from its local server, newest first; [] when unavailable. */
export async function opencodeMessages(sessionId: string): Promise<unknown[]> {
	if (!opencodeServiceRunning()) return [];
	const raw = (await runJson(
		"opencode",
		["api", "GET", `/api/session/${sessionId}/message`],
		{
			maxBuffer: 32 * 1024 * 1024,
		},
	)) as { data?: unknown[] } | unknown[] | null;
	const list = Array.isArray(raw) ? raw : raw?.data;
	return Array.isArray(list) ? list : [];
}

/** The recent text of an agent's session log, whatever its harness ("" when unknown). */
export async function sessionText(agent: {
	harness: Harness;
	sessionId: string | null;
	cwd: string | null;
}): Promise<string> {
	if (agent.harness === "claude" && agent.sessionId) {
		const file = claudeTranscript(agent.cwd, agent.sessionId);
		return file ? tail(file, 512 * 1024) : "";
	}
	if (agent.harness === "codex" && agent.sessionId) {
		const file = codexRollout(agent.sessionId);
		return file ? tail(file, 512 * 1024) : "";
	}
	if (agent.harness === "opencode" && agent.sessionId) {
		return JSON.stringify(
			(await opencodeMessages(agent.sessionId)).slice(0, 50),
		);
	}
	const file = piSessionFile(agent.harness, agent.cwd);
	return file ? tail(file, 512 * 1024) : "";
}
