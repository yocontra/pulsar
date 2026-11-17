import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { debugLog } from "../log.ts";
import { pidAlive } from "../processes.ts";
import { type Action, mcpCommand, skillFor } from "../setup/actions.ts";
import {
	editJson,
	getPath,
	readJsonc,
	runCli,
	tryCli,
} from "../setup/files.ts";
import type { AgentStatus } from "../types.ts";
import { lastModel, tail, which } from "../util.ts";
import type { DeliveryResult, HarnessDriver, Scanned } from "./types.ts";

interface ClaudeSessionRecord {
	pid: number;
	sessionId?: string;
	cwd?: string;
	name?: string;
	status?: string;
	messagingSocketPath?: string;
	kind?: string;
}

function configDir(): string {
	return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function claudeSessionsDir(): string {
	return join(configDir(), "sessions");
}

function readClaudeSession(pid: number): ClaudeSessionRecord | null {
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

/** Claude Code transcript: ~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl. */
function claudeTranscript(
	cwd: string | null,
	sessionId: string,
): string | null {
	if (!cwd) return null;
	const file = join(
		configDir(),
		"projects",
		cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${sessionId}.jsonl`,
	);
	return existsSync(file) ? file : null;
}

/** Claude Code: the model on the latest assistant entry of the session transcript. */
function claudeModel(cwd: string | null, sessionId: string): string | null {
	const file = claudeTranscript(cwd, sessionId);
	return file ? lastModel(tail(file)) : null;
}

function claudeStatus(status: string | undefined): AgentStatus {
	if (!status) return "unknown";
	return status === "idle" ? "idle" : "busy";
}

/** Every live Claude Code session with an inbox socket. */
function scanClaude(): Scanned[] {
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
			const rec = readClaudeSession(Number(file.slice(0, -5)));
			if (!rec?.pid || !rec.sessionId || !pidAlive(rec.pid)) continue;
			out.push({
				harness: claude.id,
				sessionId: rec.sessionId,
				pid: rec.pid,
				cwd: rec.cwd ?? null,
				status: claudeStatus(rec.status),
				model: claudeModel(rec.cwd ?? null, rec.sessionId),
				meta: {
					...(rec.messagingSocketPath
						? { socket: rec.messagingSocketPath }
						: {}),
					...(rec.name ? { claudeName: rec.name } : {}),
				},
			});
		} catch (e) {
			debugLog(`claude scan skipped ${file}: ${(e as Error).message}`);
		}
	}
	return out;
}

/** Reads the inbox token a Claude session publishes for peers. */
function claudePeerToken(pid: number): string | null {
	try {
		const dir = claudeSessionsDir();
		const file = readdirSync(dir).find(
			(f) => f.startsWith(`${pid}.`) && f.endsWith(".key"),
		);
		return file ? readFileSync(join(dir, file), "utf8").trim() : null;
	} catch {
		return null;
	}
}

/**
 * Claude's cross-session envelope, so the receiver shows who sent it. Only the
 * sender's name is stated. pulsar never states a permission mode (`from-mode`):
 * that is the receiver's safety check, and setup asks the user to allow pulsar
 * through it with Claude's own `crossSessionInbound` setting instead.
 */
export function claudeEnvelope(fromName: string, body: string): string {
	const name = `${fromName} via pulsar`.replace(/["<>\n\r]/g, "").slice(0, 120);
	const safe = body.replace(
		/<\/?cross-session-message/gi,
		"<cross_session_message",
	);
	return `<cross-session-message from-name="${name}">\n${safe}\n</cross-session-message>`;
}

const claudeJson = () => join(homedir(), ".claude.json");

export const claude: HarnessDriver = {
	id: "claude",
	label: "Claude Code",

	matchProcess(args) {
		const argv0 = args.split(/\s+/)[0] ?? "";
		const exe = basename(argv0).toLowerCase();
		return exe === "claude" || /\/claude\/versions\//.test(argv0);
	},

	identify({ pid, sessionId, env }) {
		if (!pid) return {};
		const rec = readClaudeSession(pid);
		const meta: Record<string, string> = {};
		if (rec?.messagingSocketPath) meta.socket = rec.messagingSocketPath;
		if (rec?.name) meta.claudeName = rec.name;
		return {
			sessionId:
				sessionId ?? rec?.sessionId ?? env.CLAUDE_CODE_SESSION_ID ?? null,
			...(rec?.cwd ? { cwd: rec.cwd } : {}),
			meta,
		};
	},

	scan: { intervalMs: 4000, sessions: scanClaude, tracksPid: true },

	push: {
		canPush(agent) {
			return agent.harness === claude.id && agent.pid !== null;
		},
		deliver(agent, text, priority, fromName) {
			const pid = agent.pid!;
			const socketFile =
				agent.meta.socket ?? readClaudeSession(pid)?.messagingSocketPath;
			if (!socketFile)
				return Promise.resolve({
					ok: false,
					via: "claude-socket",
					detail: "session has no inbox socket",
				});
			const token = claudePeerToken(pid);
			// `next` lands between tool calls; `later` waits for the turn to end and wakes an idle session.
			const claudePriority = priority === "urgent" ? "next" : "later";
			const lines = [
				...(token ? [JSON.stringify({ type: "auth", token })] : []),
				JSON.stringify({
					type: "user",
					message: { role: "user", content: claudeEnvelope(fromName, text) },
					priority: claudePriority,
				}),
			];
			return new Promise((resolve) => {
				const socket = connect(socketFile);
				let settled = false;
				const done = (r: DeliveryResult) => {
					if (settled) return;
					settled = true;
					resolve(r);
				};
				socket.setTimeout(5000, () => {
					socket.destroy();
					done({ ok: false, via: "claude-socket", detail: "timed out" });
				});
				socket.on("error", (e) =>
					done({ ok: false, via: "claude-socket", detail: e.message }),
				);
				socket.on("connect", () => {
					socket.write(`${lines.join("\n")}\n`, () => {
						// Give the receiver a moment to read before closing (macOS drops unread data on close).
						setTimeout(() => {
							socket.end();
							done({ ok: true, via: "claude-socket" });
						}, 150);
					});
				});
			});
		},
	},

	sessionLog(agent) {
		if (!agent.sessionId) return "";
		const file = claudeTranscript(agent.cwd, agent.sessionId);
		return file ? tail(file, 512 * 1024) : "";
	},

	setup: {
		detect: () => !!which("claude") || existsSync(join(homedir(), ".claude")),
		configured: () =>
			!!getPath(readJsonc(claudeJson()), ["mcpServers", "pulsar"]),
		plan: (ctx) => [
			...(ctx.mcp
				? [
						{
							client: "claude",
							describe: "claude mcp add-json pulsar --scope user",
							apply: () => {
								tryCli("claude", [
									"mcp",
									"remove",
									"pulsar",
									"--scope",
									"user",
								]);
								runCli("claude", [
									"mcp",
									"add-json",
									"pulsar",
									JSON.stringify({ type: "stdio", ...mcpCommand(ctx) }),
									"--scope",
									"user",
								]);
							},
							undo: {
								type: "cli",
								cmd: "claude",
								args: ["mcp", "remove", "pulsar", "--scope", "user"],
							},
						} satisfies Action,
					]
				: []),
			{
				client: "claude",
				describe:
					'set crossSessionInbound: "accept" in ~/.claude/settings.json (lets messages from other agents reach sessions that skip permission prompts, without an approval dialog; they still cannot approve anything)',
				apply: () =>
					editJson(
						join(homedir(), ".claude", "settings.json"),
						["crossSessionInbound"],
						"accept",
					),
				undo: {
					type: "json",
					file: join(homedir(), ".claude", "settings.json"),
					path: ["crossSessionInbound"],
				},
			} satisfies Action,
			...skillFor("claude", join(homedir(), ".claude", "skills"), ctx),
		],
	},
};
