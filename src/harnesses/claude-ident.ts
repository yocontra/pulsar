import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { debugLog } from "../log.ts";
import type { HarnessIdent } from "./types.ts";

/**
 * What the MCP server needs to know about Claude Code: which process is
 * Claude and which session it serves. Kept apart from the driver so that
 * one MCP server per agent doesn't load scanning, push, transcripts and
 * setup code.
 */

export interface ClaudeSessionRecord {
	pid: number;
	sessionId?: string;
	cwd?: string;
	name?: string;
	/** Who named it: `user` (/rename), `auto` (an AI title), `derived` (from the folder). */
	nameSource?: string;
	status?: string;
	/** Set while `status` is `waiting`: "permission prompt", "dialog open", … */
	waitingFor?: string;
	messagingSocketPath?: string;
	kind?: string;
	/** `session:@window.%pane` when the session runs inside tmux. */
	tmux?: string;
}

export function configDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function claudeSessionsDir(): string {
	return join(configDir(), "sessions");
}

async function readClaudeSession(
	pid: number,
): Promise<ClaudeSessionRecord | null> {
	try {
		return JSON.parse(
			await readFile(join(claudeSessionsDir(), `${pid}.json`), "utf8"),
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

/** Agent meta for a session's Claude name (src/harnesses/names.ts). */
export function claudeNameMeta(
	rec: ClaudeSessionRecord | null,
): Record<string, string> {
	if (!rec?.name) return {};
	return {
		claudeName: rec.name,
		harnessNameSource: rec.nameSource === "user" ? "user" : "auto",
	};
}

export const claudeIdent = {
	id: "claude",
	label: "Claude Code",

	matchProcess(args) {
		const argv0 = args.split(/\s+/)[0] ?? "";
		const exe = basename(argv0).toLowerCase();
		return exe === "claude" || /\/claude\/versions\//.test(argv0);
	},

	// The session record follows /resume and /clear; the MCP server does not.
	async currentSession(reg) {
		if (!reg.pid || process.env.PULSAR_SESSION_ID) return null;
		return (await readClaudeSession(reg.pid))?.sessionId ?? null;
	},

	async identify({ pid, sessionId, env }) {
		if (!pid) return {};
		const rec = await readClaudeSession(pid);
		const meta: Record<string, string> = {};
		if (rec?.messagingSocketPath) meta.socket = rec.messagingSocketPath;
		Object.assign(meta, claudeNameMeta(rec));
		return {
			sessionId:
				sessionId ?? rec?.sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? null,
			...(rec?.cwd ? { cwd: rec.cwd } : {}),
			meta,
		};
	},
} satisfies HarnessIdent;
