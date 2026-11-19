import { stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { exec, type Lane } from "./exec.ts";

export interface GitInfo {
	project: string | null;
	branch: string | null;
	/** Folder name of a linked worktree; null in the main checkout. */
	worktree: string | null;
}

export function slug(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

interface CachedGit {
	info: GitInfo;
	at: number;
	/** The repo's HEAD file and its mtime when read: a checkout changes it. */
	head: string | null;
	headMtime: number;
}

/** How long a folder's git info is trusted when its HEAD did not move. */
const GIT_CACHE_MS = 120_000;
const MAX_CACHED = 500;
const gitCache = new Map<string, CachedGit>();
const gitPending = new Map<string, Promise<GitInfo>>();

async function headMtime(head: string | null): Promise<number> {
	if (!head) return 0;
	try {
		return (await stat(head)).mtimeMs;
	} catch {
		return -1;
	}
}

/** The cached git info for a folder, if any (never runs git). */
export function cachedGitInfo(cwd: string): GitInfo | null {
	return gitCache.get(cwd)?.info ?? null;
}

/**
 * A folder's project, branch and worktree. Project = name of the main
 * checkout's folder, so every worktree of a repo shares one project tag.
 * Branch and worktree are the folder's own; a worktree reports the branch it
 * pushes to (they often have random local names). Asynchronous, cached per folder for
 * `GIT_CACHE_MS` and dropped as soon as the repo's HEAD file changes (a
 * checkout or a new branch), one lookup per folder at a time. A git that
 * times out (a busy machine) keeps the last answer instead of flapping the
 * agent's project and branch.
 */
export async function gitInfoAsync(
	cwd: string | null,
	opts: { lane?: Lane; force?: boolean } = {},
): Promise<GitInfo> {
	if (!cwd) return { project: null, branch: null, worktree: null };
	const hit = gitCache.get(cwd);
	if (
		hit &&
		!opts.force &&
		Date.now() - hit.at < GIT_CACHE_MS &&
		(await headMtime(hit.head)) === hit.headMtime
	)
		return hit.info;
	let p = gitPending.get(cwd);
	if (!p) {
		p = readGit(cwd, opts.lane ?? "background").finally(() =>
			gitPending.delete(cwd),
		);
		gitPending.set(cwd, p);
	}
	return p;
}

async function readGit(cwd: string, lane: Lane): Promise<GitInfo> {
	const git = (args: string[]) =>
		exec("git", ["-C", cwd, ...args], { lane, timeoutMs: 4000 });
	const [dirs, sym] = await Promise.all([
		git([
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
			"--git-dir",
			"--show-toplevel",
		]),
		git(["symbolic-ref", "--short", "-q", "HEAD"]),
	]);
	const previous = gitCache.get(cwd);
	if (!dirs.ok) {
		if (dirs.timedOut && previous) return previous.info;
		const info = {
			project: slug(basename(resolve(cwd))) || null,
			branch: null,
			worktree: null,
		};
		// A slow answer is not cached: the next refresh asks again.
		if (!dirs.timedOut) remember(cwd, info, null, 0);
		return info;
	}
	const [common = "", gitDir = "", top = ""] = dirs.stdout.trim().split("\n");
	const local = sym.ok ? sym.stdout.trim() || null : null;
	let branch = local;
	if (local) {
		// Worktrees often have random local names: report the branch it pushes to.
		const push = await git([
			"rev-parse",
			"--abbrev-ref",
			"--symbolic-full-name",
			"@{push}",
		]);
		const ref = push.ok ? push.stdout.trim() : "";
		const slash = ref.indexOf("/");
		if (slash > 0) branch = ref.slice(slash + 1) || local;
		else if (push.timedOut && previous) branch = previous.info.branch;
	} else if (sym.timedOut && previous) branch = previous.info.branch;
	const root = basename(common) === ".git" ? dirname(common) : common;
	const worktree =
		gitDir && gitDir !== common && top ? slug(basename(top)) || null : null;
	const info = { project: slug(basename(root)) || null, branch, worktree };
	const head = gitDir ? join(gitDir, "HEAD") : null;
	remember(cwd, info, head, await headMtime(head));
	return info;
}

function remember(
	cwd: string,
	info: GitInfo,
	head: string | null,
	mtime: number,
) {
	gitCache.delete(cwd);
	gitCache.set(cwd, { info, at: Date.now(), head, headMtime: mtime });
	if (gitCache.size > MAX_CACHED) {
		const oldest = gitCache.keys().next().value;
		if (oldest !== undefined) gitCache.delete(oldest);
	}
}
