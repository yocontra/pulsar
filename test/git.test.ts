import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitInfoAsync } from "../src/git.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], {
		stdio: "ignore",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
	});

describe("git identity", () => {
	test("a randomly named worktree reports the branch it pushes to", async () => {
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

		const info = await gitInfoAsync(wt);
		expect(info.project).toBe("apparish");
		expect(info.branch).toBe("fix-1378");
		expect(info.worktree).toBe("wt-k3x9q");
		expect(await gitInfoAsync(repo)).toEqual({
			project: "apparish",
			branch: "main",
			worktree: null,
		});
	});

	test("without a push target, the local branch is used", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pulsar-git-"));
		execFileSync("git", ["init", "-q", "-b", "feature-x", repo]);
		expect((await gitInfoAsync(repo)).branch).toBe("feature-x");
	});

	test("the daemon's lookup is cached until the repo's HEAD moves (also in a worktree)", async () => {
		const base = mkdtempSync(join(tmpdir(), "pulsar-git-"));
		const repo = join(base, "cachetest");
		const wt = join(base, "wt");
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
		git(repo, "worktree", "add", "-q", "-b", "wt-a", wt);
		expect((await gitInfoAsync(repo)).branch).toBe("main");
		expect((await gitInfoAsync(wt)).branch).toBe("wt-a");
		// A branch made without checking it out leaves HEAD alone: still cached.
		git(repo, "branch", "other");
		expect((await gitInfoAsync(repo)).branch).toBe("main");
		// A checkout rewrites HEAD (in the worktree's own git dir, too).
		await new Promise((r) => setTimeout(r, 20));
		git(repo, "checkout", "-q", "other");
		git(wt, "checkout", "-q", "-b", "wt-b");
		expect((await gitInfoAsync(repo)).branch).toBe("other");
		expect((await gitInfoAsync(wt)).branch).toBe("wt-b");
	});

	test("concurrent lookups of one folder share one git run", async () => {
		const repo = mkdtempSync(join(tmpdir(), "pulsar-git-"));
		execFileSync("git", ["init", "-q", "-b", "solo", repo]);
		const all = await Promise.all(
			Array.from({ length: 5 }, () => gitInfoAsync(repo, { force: true })),
		);
		expect(new Set(all).size).toBe(1);
		expect(all[0]!.branch).toBe("solo");
	});
});
