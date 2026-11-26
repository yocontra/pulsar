import { readdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { debugLog } from "../log.ts";
import { pidAlive, processSnapshot } from "../processes.ts";
import {
	type Action,
	addHook,
	mcpCommand,
	removeHook,
	type SetupContext,
	skillFor,
	type Undo,
} from "../setup/actions.ts";
import {
	editJson,
	exists,
	getPath,
	readJsonc,
	runCli,
	tryCli,
	which,
} from "../setup/files.ts";
import { isPane, panePid as panePidOf, sendKeys } from "../tmux.ts";
import { claudeTurnFailed } from "../transcripts/turn-outcome.ts";
import type { AgentStatus } from "../types.ts";
import { lastModel, statAsync, tailAsync } from "../util.ts";
import { claudeLocalAnswer } from "./claude-approvals.ts";
import {
	type ClaudeSessionRecord,
	claudeIdent,
	claudeNameMeta,
	claudeSessionsDir,
	configDir,
} from "./claude-ident.ts";
import { classifyClaude, decideClaude } from "./claude-interactions.ts";
import {
	claudeSessionDir,
	claudeSubagentStamp,
	claudeSubagentTranscript,
	listClaudeSubagents,
	TEAMMATE_QUIET_MS,
} from "./claude-subagents.ts";
import { parseClaude } from "./claude-transcript.ts";
import type {
	DeliveryResult,
	HarnessDriver,
	InterruptOutcome,
	Scanned,
} from "./types.ts";

/** A session record, read without blocking (the daemon's scan, push and interrupt). */
async function readClaudeSessionAsync(
	pid: number,
): Promise<ClaudeSessionRecord | null> {
	let rec: ClaudeSessionRecord | null = null;
	try {
		rec = JSON.parse(
			await readFile(join(claudeSessionsDir(), `${pid}.json`), "utf8"),
		) as ClaudeSessionRecord;
	} catch (e) {
		// ENOENT is a session that ended; anything else is a file we cannot read.
		if ((e as NodeJS.ErrnoException).code !== "ENOENT")
			debugLog(
				`claude session ${pid}.json unreadable: ${(e as Error).message}`,
			);
	}
	rememberRecord(pid, rec);
	return rec;
}

/**
 * Session records for `canInterrupt`, which runs for every row shown: the
 * scan keeps them current (it reads every live session's record). A record
 * not seen yet, or stale, is read in the background; the row shows the
 * interrupt once it arrives.
 */
const recordCache = new Map<
	number,
	{ at: number; rec: ClaudeSessionRecord | null }
>();
function rememberRecord(pid: number, rec: ClaudeSessionRecord | null) {
	if (recordCache.size > 1000) recordCache.clear();
	recordCache.set(pid, { at: Date.now(), rec });
}
function cachedClaudeSession(pid: number): ClaudeSessionRecord | null {
	const hit = recordCache.get(pid);
	if (!hit || Date.now() - hit.at > 5000) {
		// Marked fresh now, so a burst of rows starts one read, not many.
		rememberRecord(pid, hit?.rec ?? null);
		void readClaudeSessionAsync(pid);
	}
	return hit?.rec ?? null;
}

/** The tmux pane id (`%9`) in a session record's `tmux` field. */
function tmuxPane(rec: ClaudeSessionRecord | null): string | null {
	const m = /(%\d+)$/.exec(rec?.tmux ?? "");
	return m && isPane(m[1]) ? m[1] : null;
}

/**
 * Claude Code has no outside interrupt: its socket only takes messages and a
 * SIGINT ends the process. Inside tmux, the Esc key stops the turn the way a
 * person would. Only when the record says `busy`, and only into the pane whose
 * process is this session (or its shell).
 */
async function interruptClaude(pid: number): Promise<InterruptOutcome> {
	const via = "tmux-escape";
	const rec = await readClaudeSessionAsync(pid);
	const pane = tmuxPane(rec);
	if (!rec || !pane)
		return { result: "unsupported", via, detail: "the session is not in tmux" };
	if (rec.status !== "busy") return { result: "not-running", via };
	const panePid = await panePidOf(pane);
	if (panePid === null)
		return { result: "unsupported", via, detail: `no tmux pane ${pane}` };
	const table = await processSnapshot(0, "user");
	let p: number | undefined = pid;
	let owns = false;
	for (let hops = 0; p && hops < 4; hops++) {
		if (p === panePid) {
			owns = true;
			break;
		}
		p = table.get(p)?.ppid;
	}
	if (!owns)
		return {
			result: "unsupported",
			via,
			detail: `tmux pane ${pane} is not this session`,
		};
	// Read the status again right before the key: Esc on an idle prompt or a
	// dialog would do something else.
	if ((await readClaudeSessionAsync(pid))?.status !== "busy")
		return { result: "not-running", via };
	const sent = await sendKeys(pane, { keys: ["Escape"] });
	if (!sent.ok) return { result: "unsupported", via, detail: sent.error };
	return { result: "interrupted", via };
}

/**
 * A Claude Code session id as Claude writes it (a UUID): letters, digits
 * and dashes only. A registering client chooses the id, so anything else
 * (`../`, a slash) never reaches a file path.
 */
export function isClaudeSessionId(id: string): boolean {
	return /^[A-Za-z0-9-]{1,128}$/.test(id);
}

/** Claude Code transcript: ~/.claude/projects/<cwd with non-alphanumerics as ->/<session>.jsonl. */
function claudeTranscriptPath(
	cwd: string | null,
	sessionId: string,
): string | null {
	if (!cwd || !isClaudeSessionId(sessionId)) return null;
	return join(
		configDir(),
		"projects",
		cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		`${sessionId}.jsonl`,
	);
}

/** Transcripts found outside their cwd's folder, by session id. */
const movedTranscripts = new Map<string, string>();
/** Session ids no project folder held, and when: walked again after `MOVED_RETRY_MS`. */
const movedMisses = new Map<string, number>();
const MOVED_RETRY_MS = 5000;

/**
 * The transcript file when it exists. Claude Code names the project folder
 * for the folder the session started in; an agent that moved since
 * (`set_identity` with a worktree's cwd) is found in whichever folder holds
 * its session's file.
 */
export async function claudeTranscript(
	cwd: string | null,
	sessionId: string,
): Promise<string | null> {
	const file = claudeTranscriptPath(cwd, sessionId);
	if (file && (await statAsync(file))) return file;
	if (!isClaudeSessionId(sessionId)) return null;
	const root = join(configDir(), "projects");
	const key = `${root}\0${sessionId}`;
	const moved = movedTranscripts.get(key);
	if (moved && (await statAsync(moved))) return moved;
	const missed = movedMisses.get(key);
	if (missed !== undefined && Date.now() - missed < MOVED_RETRY_MS) return null;
	let folders: string[] = [];
	try {
		folders = await readdir(root);
	} catch {}
	for (const folder of folders) {
		const path = join(root, folder, `${sessionId}.jsonl`);
		if (path !== file && (await statAsync(path))) {
			if (movedTranscripts.size > 1000) movedTranscripts.clear();
			movedTranscripts.set(key, path);
			movedMisses.delete(key);
			return path;
		}
	}
	if (movedMisses.size > 1000) movedMisses.clear();
	movedMisses.set(key, Date.now());
	return null;
}

/** The model each transcript named last, by file, kept while the file is unchanged. */
const modelCache = new Map<
	string,
	{ size: number; mtimeMs: number; model: string | null }
>();

/** Claude Code: the model on the latest assistant entry of the session transcript. */
async function claudeModel(
	cwd: string | null,
	sessionId: string,
): Promise<string | null> {
	const file = claudeTranscriptPath(cwd, sessionId);
	const st = file ? await statAsync(file) : null;
	if (!file || !st) return null;
	const hit = modelCache.get(file);
	if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs)
		return hit.model;
	const model = lastModel(await tailAsync(file));
	if (modelCache.size > 1000) modelCache.clear();
	modelCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, model });
	return model;
}

/**
 * Claude Code's own session status (`~/.claude/sessions/<pid>.json`, read
 * from Claude Code 2.1.328): `busy` while a turn runs or delegated work
 * (background agents, teammates) does, `waiting` while a dialog waits on
 * the user, else `idle`. `waitingFor` names the dialog: a permission
 * prompt or a question stops a turn in the middle (busy: `wait idle:` must
 * not fire; pulsar's approvals hook shows the prompt as needs-you), while
 * `dialog open` (/config, a slash command's menu) is a session at its
 * prompt: idle, unless delegated work still runs (`delegated`: a subagent
 * log written within `DELEGATED_QUIET_MS`), which `waiting` hides.
 */
function claudeStatus(
	status: string | undefined,
	waitingFor?: string,
	delegated = false,
): AgentStatus {
	if (!status) return "unknown";
	if (status === "waiting")
		return waitingFor === "dialog open" && !delegated ? "idle" : "busy";
	return status === "idle" ? "idle" : "busy";
}

/** A subagent or teammate log written this recently counts as running. */
const DELEGATED_QUIET_MS = TEAMMATE_QUIET_MS;

/** True when one of the session's subagent logs was written in the last minute. */
async function delegatedActive(
	cwd: string | null,
	sessionId: string,
): Promise<boolean> {
	const dir = claudeSessionDir(cwd, sessionId);
	if (!dir) return false;
	const folder = join(dir, "subagents");
	let files: string[];
	try {
		files = (await readdir(folder)).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return false;
	}
	const since = Date.now() - DELEGATED_QUIET_MS;
	const stats = await Promise.all(files.map((f) => statAsync(join(folder, f))));
	return stats.some((st) => !!st && st.mtimeMs >= since);
}

/** Every live Claude Code session with an inbox socket (no blocking reads: it runs in the daemon). */
async function scanClaude(): Promise<Scanned[]> {
	let files: string[] = [];
	try {
		files = (await readdir(claudeSessionsDir())).filter((f) =>
			/^\d+\.json$/.test(f),
		);
	} catch {
		return [];
	}
	const found = await Promise.all(
		files.map(async (file): Promise<Scanned | null> => {
			try {
				const rec = await readClaudeSessionAsync(Number(file.slice(0, -5)));
				if (!rec?.pid || !rec.sessionId || !pidAlive(rec.pid)) return null;
				return {
					harness: claude.id,
					sessionId: rec.sessionId,
					pid: rec.pid,
					cwd: rec.cwd ?? null,
					status: claudeStatus(
						rec.status,
						rec.waitingFor,
						rec.status === "waiting" &&
							rec.waitingFor === "dialog open" &&
							(await delegatedActive(rec.cwd ?? null, rec.sessionId)),
					),
					model: await claudeModel(rec.cwd ?? null, rec.sessionId),
					waitingFor:
						rec.status === "waiting" ? rec.waitingFor || "a dialog" : null,
					meta: {
						...(rec.messagingSocketPath
							? { socket: rec.messagingSocketPath }
							: {}),
						...claudeNameMeta(rec),
					},
				};
			} catch (e) {
				debugLog(`claude scan skipped ${file}: ${(e as Error).message}`);
				return null;
			}
		}),
	);
	return found.filter((s): s is Scanned => s !== null);
}

/** Reads the inbox token a Claude session publishes for peers. */
async function claudePeerToken(pid: number): Promise<string | null> {
	try {
		const dir = claudeSessionsDir();
		const file = (await readdir(dir)).find(
			(f) => f.startsWith(`${pid}.`) && f.endsWith(".key"),
		);
		return file ? (await readFile(join(dir, file), "utf8")).trim() : null;
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
	const name = `${fromName} via Pulsar`.replace(/["<>\n\r]/g, "").slice(0, 120);
	const safe = body.replace(
		/<\/?cross-session-message/gi,
		"<cross_session_message",
	);
	return `<cross-session-message from-name="${name}">\n${safe}\n</cross-session-message>`;
}

const claudeJson = () => join(homedir(), ".claude.json");
const claudeSettings = () => join(homedir(), ".claude", "settings.json");

/** What marks pulsar's PermissionRequest hook in Claude's settings. */
const APPROVAL_HOOK_MARKER = " hook claude-permission";
/**
 * Claude's own hook timeout: a day. The command passes it on (`--timeout`),
 * so the daemon keeps a prompt answerable in the app until a minute before
 * Claude gives up on the hook (approvalDeadlineMs). Claude shows its own
 * prompt while the hook runs, so a long wait never holds the terminal up.
 */
export const APPROVAL_HOOK_TIMEOUT_S = 86_400;

const shellQuote = (s: string) =>
	/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

const CHILD_HOOK_MARKER = " hook claude-subagent";
const CHILD_HOOKS = [
	"SubagentStart",
	"PreToolUse",
	"PostToolUse",
	"SubagentStop",
] as const;

function claudeChildHookActions(ctx: SetupContext): Action[] {
	const hook = {
		type: "command",
		command: `exec ${shellQuote(ctx.node)} ${shellQuote(ctx.cli)}${CHILD_HOOK_MARKER}`,
		timeout: 2,
	};
	return CHILD_HOOKS.map((event) => {
		const isPreTool = event === "PreToolUse";
		const entry = {
			...hook,
			...(isPreTool && { onFailure: "block" }),
		};
		return {
			client: "claude",
			describe: `add a ${event} hook for the Claude subagent inbox`,
			apply: () =>
				addHook(claudeSettings(), event, CHILD_HOOK_MARKER, {
					...(isPreTool && { matcher: "^mcp__pulsar__" }),
					hooks: [entry],
				}),
			undo: {
				type: "hook",
				file: claudeSettings(),
				event,
				marker: CHILD_HOOK_MARKER,
			},
		};
	});
}

/** The PermissionRequest hook group setup writes. */
function approvalHookGroup(ctx: Pick<SetupContext, "node" | "cli">) {
	return {
		matcher: "*",
		hooks: [
			{
				type: "command",
				command: `${shellQuote(ctx.node)} ${shellQuote(ctx.cli)}${APPROVAL_HOOK_MARKER} --timeout ${APPROVAL_HOOK_TIMEOUT_S}`,
				timeout: APPROVAL_HOOK_TIMEOUT_S,
			},
		],
	};
}

/** The undo record for the approvals hook (`pulsar setup --uninstall`). */
export const approvalHookUndo = (): Undo => ({
	type: "hook",
	file: claudeSettings(),
	event: "PermissionRequest",
	marker: APPROVAL_HOOK_MARKER,
});

/** Adds (or refreshes) pulsar's PermissionRequest hook; returns its undo record. */
export function installApprovalHook(
	ctx: Pick<SetupContext, "node" | "cli">,
): Undo {
	addHook(
		claudeSettings(),
		"PermissionRequest",
		APPROVAL_HOOK_MARKER,
		approvalHookGroup(ctx),
	);
	return approvalHookUndo();
}

/** Removes pulsar's PermissionRequest hook; true when there was one. */
export function removeApprovalHook(): boolean {
	if (!installedApprovalHook()) return false;
	removeHook(claudeSettings(), "PermissionRequest", APPROVAL_HOOK_MARKER);
	return true;
}

/** The installed hook's timeout in seconds (Claude's default 60 when unset), or null. */
export function installedApprovalHookTimeout(): number | null {
	const list = getPath(readJsonc(claudeSettings()), [
		"hooks",
		"PermissionRequest",
	]);
	if (!Array.isArray(list)) return null;
	for (const g of list as {
		hooks?: { command?: unknown; timeout?: unknown }[];
	}[])
		for (const h of g?.hooks ?? [])
			if (
				typeof h?.command === "string" &&
				h.command.includes(APPROVAL_HOOK_MARKER)
			)
				return typeof h.timeout === "number" ? h.timeout : 60;
	return null;
}

/** pulsar's PermissionRequest hook command in ~/.claude/settings.json, if installed. */
export function installedApprovalHook(): string | null {
	const list = getPath(readJsonc(claudeSettings()), [
		"hooks",
		"PermissionRequest",
	]);
	if (!Array.isArray(list)) return null;
	for (const g of list as { hooks?: { command?: unknown }[] }[])
		for (const h of g?.hooks ?? [])
			if (
				typeof h?.command === "string" &&
				h.command.includes(APPROVAL_HOOK_MARKER)
			)
				return h.command;
	return null;
}

export const claude: HarnessDriver = {
	...claudeIdent,

	scan: { intervalMs: 4000, sessions: scanClaude, tracksPid: true },

	async tmuxPane(agent) {
		if (agent.harness !== claude.id || agent.pid === null) return null;
		return tmuxPane(await readClaudeSessionAsync(agent.pid));
	},

	canInterrupt(agent) {
		return (
			agent.harness === claude.id &&
			agent.pid !== null &&
			tmuxPane(cachedClaudeSession(agent.pid)) !== null
		);
	},
	interrupt(agent) {
		if (agent.pid === null)
			return Promise.resolve({
				result: "unsupported",
				via: "tmux-escape",
				detail: "no process",
			});
		return interruptClaude(agent.pid);
	},

	push: {
		canPush(agent) {
			return agent.harness === claude.id && agent.pid !== null;
		},
		canSteer(agent) {
			return agent.pid !== null;
		},
		async deliver(agent, text, priority, fromName) {
			const pid = agent.pid!;
			const socketFile =
				// Claude's own session file first: a registration's meta is only a
				// fallback (another client could have claimed the session).
				(await readClaudeSessionAsync(pid))?.messagingSocketPath ??
				agent.meta.socket;
			if (!socketFile)
				return {
					ok: false,
					via: "claude-socket",
					detail: "session has no inbox socket",
				};
			const token = await claudePeerToken(pid);
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
			return new Promise<DeliveryResult>((resolve) => {
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

	// The main log marks subagent records as sidechains (folded under the
	// Task call); each subagent's own log is `subagents.transcript`.
	transcript: {
		async locate(agent) {
			const file = agent.sessionId
				? await claudeTranscript(agent.cwd, agent.sessionId)
				: null;
			return file ? { kind: "file", path: file } : null;
		},
		needsSession: true,
		parse: parseClaude,
		turnFailed: claudeTurnFailed,
	},

	subagents: {
		stamp: claudeSubagentStamp,
		list: (agent) => listClaudeSubagents(agent),
		transcript: claudeSubagentTranscript,
	},

	approvals: {
		watch: (agent, prompt) =>
			claudeLocalAnswer(claudeSessionsDir(), agent, prompt),
	},

	interactions: { classify: classifyClaude, decide: decideClaude },

	async sessionLog(agent) {
		if (!agent.sessionId) return "";
		const file = claudeTranscriptPath(agent.cwd, agent.sessionId);
		return file ? tailAsync(file, 512 * 1024) : "";
	},

	setup: {
		detect: (path) =>
			!!which("claude", path) || exists(join(homedir(), ".claude")),
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
			...claudeChildHookActions(ctx),
			...skillFor("claude", join(homedir(), ".claude", "skills"), ctx),
		],
	},
};
