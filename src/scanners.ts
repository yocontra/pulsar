import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ClaudeSessionRecord, claudeSessionsDir } from "./identity.ts";
import type { AgentStatus, Harness } from "./types.ts";

/** A live session found on disk or through a harness API. */
export interface Scanned {
	harness: Harness;
	sessionId: string;
	pid: number | null;
	cwd: string | null;
	status: AgentStatus;
	meta: Record<string, string>;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

function claudeStatus(status: string | undefined): AgentStatus {
	if (!status) return "unknown";
	return status === "idle" ? "idle" : "busy";
}

/** Every live Claude Code session with an inbox socket. */
export function scanClaude(): Scanned[] {
	let files: string[] = [];
	try {
		files = readdirSync(claudeSessionsDir()).filter((f) =>
			/^\d+\.json$/.test(f),
		);
	} catch {
		return [];
	}
	const out: Scanned[] = [];
	for (const file of files) {
		try {
			const rec = JSON.parse(
				readFileSync(join(claudeSessionsDir(), file), "utf8"),
			) as ClaudeSessionRecord;
			if (!rec.pid || !rec.sessionId || !pidAlive(rec.pid)) continue;
			out.push({
				harness: "claude",
				sessionId: rec.sessionId,
				pid: rec.pid,
				cwd: rec.cwd ?? null,
				status: claudeStatus(rec.status),
				meta: {
					...(rec.messagingSocketPath
						? { socket: rec.messagingSocketPath }
						: {}),
					...(rec.name ? { claudeName: rec.name } : {}),
				},
			});
		} catch {}
	}
	return out;
}

function runJson(cmd: string, args: string[]): Promise<unknown> {
	return new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout) => {
				if (err) return resolve(null);
				try {
					resolve(JSON.parse(stdout));
				} catch {
					resolve(null);
				}
			},
		);
	});
}

/** OpenCode sessions that are running right now, from its shared server. */
export async function scanOpencode(): Promise<Scanned[]> {
	const active = (await runJson("opencode", [
		"api",
		"session.active",
	])) as Record<string, { type?: string }> | null;
	if (!active || typeof active !== "object") return [];
	const out: Scanned[] = [];
	for (const [id, state] of Object.entries(active)) {
		const info = (await runJson("opencode", [
			"api",
			"GET",
			`/api/session/${id}`,
		])) as {
			directory?: string;
			title?: string;
			parentID?: string | null;
		} | null;
		if (info?.parentID) continue;
		out.push({
			harness: "opencode",
			sessionId: id,
			pid: null,
			cwd: info?.directory ?? null,
			status: state?.type === "running" ? "busy" : "idle",
			meta: info?.title ? { title: info.title } : {},
		});
	}
	return out;
}
