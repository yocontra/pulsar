import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

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

/**
 * Project = name of the main checkout's folder, so every worktree of a repo
 * shares one project tag. Branch and worktree are the folder's own.
 */
export function gitInfo(cwd: string | null): GitInfo {
	if (!cwd) return { project: null, branch: null, worktree: null };
	try {
		const out = execFileSync(
			"git",
			[
				"-C",
				cwd,
				"rev-parse",
				"--path-format=absolute",
				"--git-common-dir",
				"--git-dir",
				"--show-toplevel",
			],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
		)
			.trim()
			.split("\n");
		const [common = "", gitDir = "", top = ""] = out;
		const local = localBranch(cwd);
		// Worktrees often have random local names: report the branch it pushes to.
		const branch = (local && pushBranch(cwd)) || local;
		const root = basename(common) === ".git" ? dirname(common) : common;
		const worktree =
			gitDir && gitDir !== common && top ? slug(basename(top)) || null : null;
		return { project: slug(basename(root)) || null, branch, worktree };
	} catch {
		return {
			project: slug(basename(resolve(cwd))) || null,
			branch: null,
			worktree: null,
		};
	}
}

/** The checked-out branch, also before the first commit; null when detached. */
function localBranch(cwd: string): string | null {
	try {
		return (
			execFileSync(
				"git",
				["-C", cwd, "symbolic-ref", "--short", "-q", "HEAD"],
				{
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
					timeout: 3000,
				},
			).trim() || null
		);
	} catch {
		return null;
	}
}

/** The remote branch `git push` would update (`origin/fix-1378` → `fix-1378`), if any. */
function pushBranch(cwd: string): string | null {
	try {
		const ref = execFileSync(
			"git",
			[
				"-C",
				cwd,
				"rev-parse",
				"--abbrev-ref",
				"--symbolic-full-name",
				"@{push}",
			],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3000,
			},
		).trim();
		const slash = ref.indexOf("/");
		return slash > 0 ? ref.slice(slash + 1) : null;
	} catch {
		return null;
	}
}
