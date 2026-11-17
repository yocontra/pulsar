import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { gitInfo } from "../git.ts";
import { processTable } from "../processes.ts";
import { type Action, skillFor } from "../setup/actions.ts";
import { runCli, setTomlKey, tryCli } from "../setup/files.ts";
import { autoTags, isAutoTag } from "../tags.ts";
import { MAX_BLOCK_SECONDS, type Registration } from "../types.ts";
import { head, lastModel, run, tail, which } from "../util.ts";
import type { HarnessDriver } from "./types.ts";

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
function codexThreadCwd(threadId: string): string | null {
	return codexThreadCwds.get(threadId) ?? null;
}

/** The best Codex thread guess for a process, skipping ones already claimed. */
function codexThreadId(
	pid: number,
	cwd: string | null,
	exclude: ReadonlySet<string> = new Set(),
): string | null {
	return codexThreadIds(pid, cwd).find((id) => !exclude.has(id)) ?? null;
}

/** Points a Codex registration at its thread: id, the thread's folder, and its git tags. */
function adoptCodexThread(reg: Registration, threadId: string | null) {
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

const codexFiles = new Map<string, string>();

/** Codex rollout: `rollout-…-<thread>.jsonl` in the last month of ~/.codex/sessions. */
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

export const codex: HarnessDriver = {
	id: "codex",
	label: "Codex",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "codex" || exe === "codex-exec-server";
	},

	identify({ pid, cwd, sessionId, env }) {
		const id =
			sessionId ??
			env.CODEX_THREAD_ID ??
			env.CODEX_SESSION_ID ??
			(pid ? codexThreadId(pid, cwd) : null);
		// Under the app-server, this process's folder is not the thread's: use the
		// rollout's, and claim no folder until the thread is known.
		const appServer = pid
			? /\bapp-server\b/.test(processTable().get(pid)?.args ?? "")
			: false;
		if (id) return { sessionId: id, cwd: codexThreadCwd(id) ?? cwd };
		return appServer ? { sessionId: id, cwd: null } : { sessionId: id };
	},

	// Codex creates its thread (and rollout file) after starting MCP servers.
	lateSession: {
		find: (reg, exclude) =>
			reg.pid ? codexThreadId(reg.pid, reg.cwd, exclude) : null,
		adopt: adoptCodexThread,
	},

	push: {
		canPush(agent) {
			return agent.harness === codex.id && !!agent.sessionId;
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
	},

	/** The model in the thread's latest turn context (long rollouts state it near the start). */
	model(agent) {
		const file = agent.sessionId ? codexRollout(agent.sessionId) : null;
		if (!file) return null;
		return lastModel(tail(file, 512 * 1024)) ?? lastModel(head(file));
	},

	sessionLog(agent) {
		const file = agent.sessionId ? codexRollout(agent.sessionId) : null;
		return file ? tail(file, 512 * 1024) : "";
	},

	setup: {
		detect: () => !!which("codex") || existsSync(join(homedir(), ".codex")),
		configured: () => {
			try {
				return runCli("codex", ["mcp", "get", "pulsar"]).includes("pulsar");
			} catch {
				return false;
			}
		},
		plan: (ctx) => [
			...(ctx.mcp
				? [
						{
							client: "codex",
							describe: "codex mcp add pulsar",
							apply: () => {
								tryCli("codex", ["mcp", "remove", "pulsar"]);
								runCli("codex", [
									"mcp",
									"add",
									"pulsar",
									"--",
									ctx.node,
									ctx.cli,
									"mcp",
								]);
								// pulsar's tools only message other agents: approve them, and let ask/wait block past 60s.
								const toml = join(homedir(), ".codex", "config.toml");
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"default_tools_approval_mode",
									'"approve"',
								);
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"tool_timeout_sec",
									String(MAX_BLOCK_SECONDS + 100),
								);
							},
							undo: {
								type: "cli",
								cmd: "codex",
								args: ["mcp", "remove", "pulsar"],
							},
						} satisfies Action,
					]
				: []),
			...skillFor("codex", join(homedir(), ".codex", "skills"), ctx),
		],
	},
};
