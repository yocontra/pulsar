import { execFile } from "node:child_process";
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
import { opencodeServiceRunning } from "./identity.ts";

/** Last `bytes` of a file as text (transcripts can be large). */
function tail(file: string, bytes = 96 * 1024): string {
	try {
		const size = statSync(file).size;
		const fd = openSync(file, "r");
		try {
			const len = Math.min(size, bytes);
			const buf = Buffer.alloc(len);
			readSync(fd, buf, 0, len, size - len);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** The last model id written in a JSONL log, skipping placeholders like `<synthetic>`. */
function lastModel(text: string, key = "model"): string | null {
	const re = new RegExp(`"${key}"\\s*:\\s*"([^"<>]+)"`, "g");
	let found: string | null = null;
	for (let m = re.exec(text); m; m = re.exec(text)) found = m[1] ?? found;
	return found;
}

/** Claude Code: the model on the latest assistant entry of the session transcript. */
export function claudeModel(
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
	return existsSync(file) ? lastModel(tail(file)) : null;
}

const codexFiles = new Map<string, string>();

/** Finds `rollout-…-<thread>.jsonl` in the last few days of ~/.codex/sessions. */
function codexRollout(threadId: string): string | null {
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

/** First `bytes` of a file as text. */
function head(file: string, bytes = 256 * 1024): string {
	try {
		const fd = openSync(file, "r");
		try {
			const buf = Buffer.alloc(Math.min(statSync(file).size, bytes));
			readSync(fd, buf, 0, buf.length, 0);
			return buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
	} catch {
		return "";
	}
}

/** Codex: the model in the thread's latest turn context (long rollouts state it near the start). */
export function codexModel(threadId: string): string | null {
	const file = codexRollout(threadId);
	if (!file) return null;
	return lastModel(tail(file, 512 * 1024)) ?? lastModel(head(file));
}

/** OpenCode: the model of the session's newest assistant message. */
export function opencodeModel(sessionId: string): Promise<string | null> {
	if (!opencodeServiceRunning()) return Promise.resolve(null);
	return new Promise((resolve) => {
		execFile(
			"opencode",
			["api", "GET", `/api/session/${sessionId}/message`],
			{ timeout: 8000, maxBuffer: 32 * 1024 * 1024 },
			(err, stdout) => {
				if (err) return resolve(null);
				try {
					const raw = JSON.parse(stdout) as { data?: unknown } | unknown[];
					const list =
						(Array.isArray(raw) ? raw : (raw as { data?: unknown[] }).data) ??
						[];
					for (const m of list as Array<{
						type?: string;
						model?: { id?: string };
					}>) {
						if (m.type === "assistant" && m.model?.id)
							return resolve(m.model.id);
					}
					resolve(null);
				} catch {
					resolve(null);
				}
			},
		);
	});
}
