import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { claudeSessionsDir, readClaudeSession } from "../identity.ts";
import type { Agent, Priority } from "../types.ts";

export interface DeliveryResult {
	ok: boolean;
	via: string;
	detail?: string;
}

/**
 * Pushes text into a running session from outside it. Each harness has its
 * own door: Claude's inbox socket, `codex queue`, OpenCode's server API.
 * pi and omp are reached through the pulsar extension instead (see daemon).
 */
export interface Adapter {
	canPush(agent: Agent): boolean;
	deliver(
		agent: Agent,
		text: string,
		priority: Priority,
		fromName: string,
	): Promise<DeliveryResult>;
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			cmd,
			args,
			{ timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				if (err)
					reject(
						new Error(
							`${cmd} failed: ${String(stderr || err.message)
								.trim()
								.slice(0, 300)}`,
						),
					);
				else resolve(stdout);
			},
		);
	});
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

export const claudeAdapter: Adapter = {
	canPush(agent) {
		return agent.harness === "claude" && agent.pid !== null;
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
};

export const codexAdapter: Adapter = {
	canPush(agent) {
		return agent.harness === "codex" && !!agent.sessionId;
	},
	async deliver(agent, text) {
		try {
			await run("codex", [
				"queue",
				"--thread",
				agent.sessionId!,
				"--message",
				text,
				"--resume",
			]);
			return { ok: true, via: "codex-queue" };
		} catch (e) {
			return { ok: false, via: "codex-queue", detail: (e as Error).message };
		}
	},
};

export const opencodeAdapter: Adapter = {
	canPush(agent) {
		return agent.harness === "opencode" && !!agent.sessionId;
	},
	async deliver(agent, text, priority) {
		const body = JSON.stringify({
			text,
			delivery: priority === "urgent" ? "steer" : "queue",
			resume: true,
		});
		try {
			await run("opencode", [
				"api",
				"POST",
				`/api/session/${agent.sessionId}/prompt`,
				"-d",
				body,
			]);
			return { ok: true, via: "opencode-api" };
		} catch (e) {
			return { ok: false, via: "opencode-api", detail: (e as Error).message };
		}
	},
};

export const adapters: Adapter[] = [
	claudeAdapter,
	codexAdapter,
	opencodeAdapter,
];

export function adapterFor(agent: Agent): Adapter | null {
	return adapters.find((a) => a.canPush(agent)) ?? null;
}
