import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Harness, Registration } from "./types.ts";

export interface ProcessInfo {
	pid: number;
	ppid: number;
	args: string;
}

/** One `ps` call; returns every process keyed by pid. */
export function processTable(): Map<number, ProcessInfo> {
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

export interface GitInfo {
	project: string | null;
	branch: string | null;
}

/** Project = name of the main checkout's folder, so worktrees share one tag. */
export function gitInfo(cwd: string | null): GitInfo {
	if (!cwd) return { project: null, branch: null };
	try {
		const out = execFileSync(
			"git",
			[
				"-C",
				cwd,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
				"--abbrev-ref",
				"HEAD",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		)
			.trim()
			.split("\n");
		const common = out[0] ?? "";
		const branch = out[1] && out[1] !== "HEAD" ? out[1] : null;
		const root = basename(common) === ".git" ? dirname(common) : common;
		return { project: slug(basename(root)) || null, branch };
	} catch {
		return { project: slug(basename(resolve(cwd))) || null, branch: null };
	}
}

export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export interface ClaudeSessionRecord {
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
	} catch {
		return null;
	}
}

/**
 * The Codex thread a codex process is writing, from the rollout file it holds
 * open (`rollout-<time>-<thread uuid>.jsonl`). Codex does not tell MCP servers
 * their thread id. When one process serves several threads, the one whose
 * recorded cwd matches wins, newest first.
 */
export function codexThreadId(pid: number, cwd: string | null): string | null {
	let out = "";
	try {
		out = execFileSync("lsof", ["-p", String(pid), "-Fn"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
	} catch {
		return null;
	}
	const files = out
		.split("\n")
		.filter((l) => l.startsWith("n") && /rollout-.*\.jsonl$/.test(l))
		.map((l) => l.slice(1));
	const candidates: Array<{ id: string; cwd: string | null; file: string }> =
		[];
	for (const file of files) {
		const id =
			/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
				file,
			)?.[1];
		if (!id) continue;
		let recorded: string | null = null;
		try {
			const head = readFileSync(file, "utf8").slice(0, 8192);
			recorded = /"cwd":"([^"]+)"/.exec(head)?.[1] ?? null;
			if (head.includes("parent_thread_id")) continue;
		} catch {}
		candidates.push({ id, cwd: recorded, file });
	}
	const match =
		candidates.find((c) => cwd && c.cwd === cwd) ??
		(candidates.length === 1 ? candidates[0] : undefined);
	return match?.id ?? null;
}

/** Auto-tags every agent gets. Self-tags are added on top. */
export function autoTags(harness: Harness, git: GitInfo): string[] {
	const tags = [`harness:${harness}`];
	if (git.project) tags.push(`project:${git.project}`);
	if (git.branch) tags.push(`branch:${git.branch}`);
	return tags;
}

/** Tags from PULSAR_TAGS (comma or space separated), for launch-time tagging. */
export function envTags(): string[] {
	return (process.env.PULSAR_TAGS ?? "")
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}

/**
 * Works out who this MCP server (or extension) is serving: the harness, its
 * session id and folder. Runs once at start.
 */
export function detectRegistration(role: Registration["role"]): Registration {
	const cwd = process.cwd();
	const forced = process.env.PULSAR_HARNESS as Harness | undefined;
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
		}
		sessionId ??= process.env.CLAUDE_CODE_SESSION_ID ?? null;
	} else if (harness === "codex") {
		sessionId ??=
			process.env.CODEX_THREAD_ID ??
			process.env.CODEX_SESSION_ID ??
			(pid ? codexThreadId(pid, sessionCwd) : null);
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
