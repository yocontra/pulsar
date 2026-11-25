import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { exec } from "../exec.ts";
import { gitInfoAsync } from "../git.ts";
import { processTable } from "../processes.ts";
import { autoTags, isAutoTag } from "../tags.ts";
import type { Registration } from "../types.ts";
import type { HarnessIdent } from "./types.ts";

/** Codex process matching and thread discovery (see claude-ident.ts for why apart). */

export const CODEX_THREAD_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function codexToolThreadId(meta: Record<string, unknown> | undefined) {
	const value = meta?.threadId;
	return typeof value === "string" && CODEX_THREAD_ID.test(value)
		? value
		: null;
}

/**
 * Codex threads a codex process is writing, best guess first. Codex does not
 * tell MCP servers their thread id, but it holds each thread's
 * `rollout-<time>-<thread uuid>.jsonl` open. The app-server daemon serves many
 * threads from one process, so candidates whose recorded cwd matches come
 * first, newest first; the daemon refuses a thread another session claimed.
 */
async function codexThreadIds(
	pid: number,
	cwd: string | null,
): Promise<string[]> {
	const r = await exec("lsof", ["-p", String(pid), "-Fn"], {
		lane: "user",
		timeoutMs: 3000,
	});
	if (!r.ok) return [];
	const out = r.stdout;
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
			const head = await readHead(file, 8192);
			if (head.includes("parent_thread_id")) continue;
			const recorded = /"cwd":"([^"]+)"/.exec(head)?.[1] ?? null;
			if (recorded) codexThreadCwds.set(id, recorded);
			candidates.push({
				id,
				cwdMatch: !!cwd && recorded === cwd,
				mtime: (await stat(file)).mtimeMs,
			});
		} catch {}
	}
	return candidates
		.sort(
			(a, b) => Number(b.cwdMatch) - Number(a.cwdMatch) || b.mtime - a.mtime,
		)
		.map((c) => c.id);
}

/** The first `bytes` of a file as text. */
async function readHead(file: string, bytes: number): Promise<string> {
	const fh = await open(file, "r");
	try {
		const buf = Buffer.alloc(bytes);
		const { bytesRead } = await fh.read(buf, 0, bytes, 0);
		return buf.subarray(0, bytesRead).toString("utf8");
	} finally {
		await fh.close();
	}
}

/** Each Codex thread's folder, recorded by `codexThreadIds` from its rollout. */
const codexThreadCwds = new Map<string, string>();

/** The folder a Codex thread works in, from its rollout (not the MCP server's own folder). */
function codexThreadCwd(threadId: string): string | null {
	return codexThreadCwds.get(threadId) ?? null;
}

/** The best Codex thread guess for a process, skipping ones already claimed. */
async function codexThreadId(
	pid: number,
	cwd: string | null,
	exclude: ReadonlySet<string> = new Set(),
): Promise<string | null> {
	return (
		(await codexThreadIds(pid, cwd)).find((id) => !exclude.has(id)) ?? null
	);
}

/** Points a Codex registration at its thread: id, the thread's folder, and its git tags. */
async function adoptCodexThread(reg: Registration, threadId: string | null) {
	reg.sessionId = threadId;
	const cwd = threadId ? codexThreadCwd(threadId) : null;
	if (!cwd || cwd === reg.cwd) return;
	reg.cwd = cwd;
	const git = await gitInfoAsync(cwd, { lane: "user" });
	reg.project = git.project;
	reg.branch = git.branch;
	reg.tags = [
		...autoTags(reg.harness, git),
		...reg.tags.filter((t) => !isAutoTag(t)),
	];
}

export const codexIdent = {
	id: "codex",
	label: "Codex",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "codex" || exe === "codex-exec-server";
	},

	async identify({ pid, cwd, sessionId, env }) {
		const id =
			sessionId ??
			env.CODEX_THREAD_ID ??
			env.CODEX_SESSION_ID ??
			(pid ? await codexThreadId(pid, cwd) : null);
		// Under the app-server, this process's folder is not the thread's: use the
		// rollout's, and claim no folder until the thread is known.
		const appServer = pid
			? /\bapp-server\b/.test((await processTable()).get(pid)?.args ?? "")
			: false;
		if (id) return { sessionId: id, cwd: codexThreadCwd(id) ?? cwd };
		return appServer ? { sessionId: id, cwd: null } : { sessionId: id };
	},

	// Codex creates its thread (and rollout file) after starting MCP servers.
	lateSession: {
		find: async (reg, exclude) =>
			reg.pid ? codexThreadId(reg.pid, reg.cwd, exclude) : null,
		adopt: adoptCodexThread,
	},
} satisfies HarnessIdent;
