import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfo } from "../src/git.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		stdio: "ignore",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});

describe("git identity", () => {
	test("a randomly named worktree reports the branch it pushes to", () => {
		const base = mkdtempSync(join(tmpdir(), "pulsar-git-"));
		const remote = join(base, "remote.git");
		const repo = join(base, "apparish");
		const wt = join(base, "wt-k3x9q");
		execFileSync("git", ["init", "-q", "--bare", remote]);
		execFileSync("git", ["init", "-q", "-b", "main", repo]);
		git(
			repo,
			"-c",
			"user.email=t@t",
			"-c",
			"user.name=t",
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			"init",
		);
		git(repo, "remote", "add", "origin", remote);
		git(repo, "push", "-q", "origin", "main");
		// Local branch has a throwaway name; it pushes to fix-1378 on the remote.
		git(repo, "worktree", "add", "-q", "-b", "wt-k3x9q", wt);
		git(wt, "push", "-q", "origin", "wt-k3x9q:fix-1378");
		git(wt, "branch", "--set-upstream-to=origin/fix-1378");
		git(wt, "config", "push.default", "upstream");

		const info = gitInfo(wt);
		expect(info.project).toBe("apparish");
		expect(info.branch).toBe("fix-1378");
		expect(info.worktree).toBe("wt-k3x9q");
		expect(gitInfo(repo)).toEqual({
			project: "apparish",
			branch: "main",
			worktree: null,
		});
	});

	test("without a push target, the local branch is used", () => {
		const repo = mkdtempSync(join(tmpdir(), "pulsar-git-"));
		execFileSync("git", ["init", "-q", "-b", "feature-x", repo]);
		expect(gitInfo(repo).branch).toBe("feature-x");
	});
});
