import { type GitInfo, gitInfo } from "./git.ts";
import { findHarnessAncestor, harnessOfArgs } from "./processes.ts";
import {
	codexThreadCwd,
	codexThreadId,
	readClaudeSession,
} from "./sessions.ts";
import { HARNESSES, type Harness, type Registration } from "./types.ts";

/** Tags pulsar sets and refreshes itself; agents add any others. */
export function isAutoTag(tag: string): boolean {
	return /^(harness|project|branch|worktree|pr|model):/.test(tag);
}

/** Points a Codex registration at its thread: id, the thread's folder, and its git tags. */
export function adoptCodexThread(reg: Registration, threadId: string | null) {
	reg.sessionId = threadId;
	const cwd = threadId ? codexThreadCwd(threadId) : null;
	if (!cwd || cwd === reg.cwd) return;
	reg.cwd = cwd;
	const git = gitInfo(cwd);
	reg.project = git.project;
	reg.branch = git.branch;
	reg.tags = [
		...autoTags(reg.harness, git),
		...reg.tags.filter((t) => !isAutoTag(t)),
	];
}

/** Auto-tags every agent gets. Self-tags are added on top. */
export function autoTags(harness: Harness, git: GitInfo): string[] {
	const tags = [`harness:${harness}`];
	if (git.project) tags.push(`project:${git.project}`);
	if (git.branch) tags.push(`branch:${git.branch}`);
	if (git.worktree) tags.push(`worktree:${git.worktree}`);
	return tags;
}

/** Tags from PULSAR_TAGS (comma or space separated), for launch-time tagging. */
export function envTags(): string[] {
	return (process.env.PULSAR_TAGS ?? "")
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

/** PULSAR_HARNESS when it names a known harness; anything else falls back to detection. */
function forcedHarness(): Harness | undefined {
	const value = process.env.PULSAR_HARNESS;
	if (!value) return undefined;
	if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
	// stderr only: stdout carries the MCP protocol.
	console.error(
		`pulsar: ignoring unknown PULSAR_HARNESS "${value}" (expected one of ${HARNESSES.join(", ")})`,
	);
	return undefined;
}

/**
 * Works out who this MCP server (or extension) is serving: the harness, its
 * session id and folder. Runs once at start.
 */
export function detectRegistration(role: Registration["role"]): Registration {
	const cwd = process.cwd();
	const forced = forcedHarness();
	const ancestor =
		role === "extension"
			? {
					harness: forced ?? harnessOfArgs(process.argv.join(" ")) ?? "pi",
					pid: process.pid,
				}
			: findHarnessAncestor(process.pid);
	const harness: Harness =
		forced ?? ancestor?.harness ?? (role === "cli" ? "cli" : "unknown");
	const pid = ancestor?.pid ?? null;
	const meta: Record<string, string> = {};
	let sessionId: string | null = process.env.PULSAR_SESSION_ID ?? null;
	let name: string | undefined;
	let sessionCwd = cwd;

	if (harness === "claude" && pid) {
		const rec = readClaudeSession(pid);
		if (rec) {
			sessionId ??= rec.sessionId ?? null;
			if (rec.cwd) sessionCwd = rec.cwd;
			if (rec.messagingSocketPath) meta.socket = rec.messagingSocketPath;
			if (rec.name) meta.claudeName = rec.name;
		}
		sessionId ??= process.env.CLAUDE_CODE_SESSION_ID ?? null;
	} else if (harness === "codex") {
		sessionId ??=
			process.env.CODEX_THREAD_ID ??
			process.env.CODEX_SESSION_ID ??
			(pid ? codexThreadId(pid, sessionCwd) : null);
		// Under the app-server, this process's folder is not the thread's: use the rollout's.
		if (sessionId) sessionCwd = codexThreadCwd(sessionId) ?? sessionCwd;
	} else if (harness === "opencode") {
		sessionId ??= process.env.OPENCODE_SESSION_ID ?? null;
	}
	if (process.env.PULSAR_NAME) name = process.env.PULSAR_NAME;

	const git = gitInfo(sessionCwd);
	return {
		harness,
		sessionId,
		pid,
		cwd: sessionCwd,
		project: git.project,
		branch: git.branch,
		tags: [...autoTags(harness, git), ...envTags()],
		...(name ? { name } : {}),
		meta,
		role,
	};
}
