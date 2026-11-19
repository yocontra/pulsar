import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runGh, runGit, safeGitEnv, worktreeRoot } from "../src/git-write.ts";
import { cleanupRepos, g, gitRepo, tmpFolder } from "./git-repo.ts";

/**
 * The git runner for operator actions (src/git-write.ts), on temp repos
 * only: never the user's git config (GIT_CONFIG_GLOBAL=/dev/null).
 */

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const ID = {
	GIT_AUTHOR_NAME: "t",
	GIT_AUTHOR_EMAIL: "t@example.com",
	GIT_COMMITTER_NAME: "t",
	GIT_COMMITTER_EMAIL: "t@example.com",
};

afterAll(cleanupRepos);

/** An executable script in a temp folder. */
function script(dir: string, name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, `#!/bin/sh\n${body}\n`);
	chmodSync(p, 0o755);
	return p;
}

describe("worktree check", () => {
	test("only an absolute path inside a worktree", async () => {
		const repo = gitRepo();
		mkdirSync(join(repo, "sub"));
		expect(await worktreeRoot(join(repo, "sub"))).toBe(realpathSync(repo));
		expect(await worktreeRoot("relative/path")).toBeNull();
		expect(await worktreeRoot(join(repo, "missing"))).toBeNull();
		expect(await worktreeRoot(tmpFolder())).toBeNull();
		// A bare repo has no worktree.
		const bare = tmpFolder();
		g(bare, "init", "-q", "--bare");
		expect(await worktreeRoot(bare)).toBeNull();
		const r = await runGit(bare, ["status"]);
		expect(r).toMatchObject({ ok: false, code: "not_a_worktree" });
	});

	test("an inherited GIT_DIR / GIT_WORK_TREE does not redirect it", async () => {
		const repo = gitRepo();
		const other = gitRepo();
		const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE };
		process.env.GIT_DIR = join(other, ".git");
		process.env.GIT_WORK_TREE = other;
		try {
			writeFileSync(join(repo, "new.txt"), "x\n");
			const r = await runGit(repo, ["status", "--porcelain"]);
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.root).toBe(realpathSync(repo));
				expect(r.stdout).toContain("new.txt");
			}
		} finally {
			if (saved.dir === undefined) delete process.env.GIT_DIR;
			else process.env.GIT_DIR = saved.dir;
			if (saved.wt === undefined) delete process.env.GIT_WORK_TREE;
			else process.env.GIT_WORK_TREE = saved.wt;
		}
	});
});

describe("writes", () => {
	test("commit selected files; paths are literal", async () => {
		const repo = gitRepo();
		writeFileSync(join(repo, "a.txt"), "changed\n");
		writeFileSync(join(repo, "*.txt"), "a file named star\n");
		const add = await runGit(repo, ["add", "--", "*.txt"]);
		expect(add.ok).toBe(true);
		// Only the file literally named `*.txt` was staged, not a.txt.
		const staged = await runGit(repo, ["diff", "--cached", "--name-only"]);
		expect(staged.ok && staged.stdout.trim()).toBe("*.txt");
		const c = await runGit(
			repo,
			["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add star"],
			{ env: ID },
		);
		expect(c).toMatchObject({ ok: true });
		expect(g(repo, "log", "-1", "--format=%s").trim()).toBe("add star");
	});

	test("a failure carries git's message, exit code and stderr", async () => {
		const repo = gitRepo();
		const r = await runGit(repo, ["checkout", "no-such-branch"]);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.code).toBe("failed");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("no-such-branch");
		expect(r.message).toMatch(/^error: .*no-such-branch/);
	});

	test("no editor: a commit without a message fails instead of waiting", async () => {
		const repo = gitRepo();
		writeFileSync(join(repo, "a.txt"), "edited\n");
		g(repo, "add", "a.txt");
		const r = await runGit(repo, ["-c", "commit.gpgsign=false", "commit"], {
			env: ID,
			timeoutMs: 20_000,
		});
		expect(r).toMatchObject({ ok: false, code: "failed" });
		if (!r.ok) expect(r.stderr).toMatch(/empty commit message/i);
	});

	test("hooks run", async () => {
		const repo = gitRepo();
		const marker = join(tmpFolder(), "hook-ran");
		script(join(repo, ".git", "hooks"), "pre-commit", `echo yes > '${marker}'`);
		writeFileSync(join(repo, "a.txt"), "hooked\n");
		g(repo, "add", "a.txt");
		const r = await runGit(
			repo,
			["-c", "commit.gpgsign=false", "commit", "-q", "-m", "h"],
			{ env: ID },
		);
		expect(r.ok).toBe(true);
		expect(readFileSync(marker, "utf8").trim()).toBe("yes");
	});

	test("a hook past the timeout stops, with its children, and leaves no lock", async () => {
		const repo = gitRepo();
		script(join(repo, ".git", "hooks"), "pre-commit", "sleep 30");
		writeFileSync(join(repo, "a.txt"), "slow\n");
		g(repo, "add", "a.txt");
		const t0 = Date.now();
		const r = await runGit(
			repo,
			["-c", "commit.gpgsign=false", "commit", "-q", "-m", "slow"],
			{ env: ID, timeoutMs: 1500 },
		);
		expect(r).toMatchObject({ ok: false, code: "timeout" });
		// The hook's `sleep` held git's output open: it was stopped too.
		expect(Date.now() - t0).toBeLessThan(15_000);
		expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
		// The worktree takes the next write.
		const next = await runGit(repo, ["reset", "-q"]);
		expect(next.ok).toBe(true);
	});

	test("writes to one worktree run one at a time, in order", async () => {
		const repo = gitRepo();
		const log = join(tmpFolder(), "order");
		const hook = script(
			tmpFolder(),
			"slow-git",
			`echo start >> '${log}'; sleep 0.3; echo end >> '${log}'`,
		);
		const runs = [1, 2, 3].map(() =>
			runGit(repo, ["-c", `alias.slow=!${hook}`, "slow"]),
		);
		const results = await Promise.all(runs);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
			"start",
			"end",
			"start",
			"end",
			"start",
			"end",
		]);
	});
});

describe("no prompts", () => {
	test("the environment turns every prompt off", () => {
		const env = safeGitEnv("write", "ssh", {
			PATH: "/usr/bin:/bin",
			GIT_DIR: "/elsewhere",
			GIT_INDEX_FILE: "/elsewhere/index",
			GIT_OPTIONAL_LOCKS: "0",
		});
		expect(env).toMatchObject({
			GIT_TERMINAL_PROMPT: "0",
			GCM_INTERACTIVE: "never",
			SSH_ASKPASS_REQUIRE: "never",
			GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
			GIT_EDITOR: "true",
			GH_PROMPT_DISABLED: "1",
		});
		expect(env.GIT_DIR).toBeUndefined();
		expect(env.GIT_INDEX_FILE).toBeUndefined();
		// Writes take locks; reads next to a working agent don't.
		expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined();
		expect(safeGitEnv("read").GIT_OPTIONAL_LOCKS).toBe("0");
		// The askpass program exists here and answers nothing, failing.
		const askpass = env.GIT_ASKPASS!;
		expect(existsSync(askpass)).toBe(true);
		let failed = false;
		try {
			execFileSync(askpass, ["Password for x:"], { encoding: "utf8" });
		} catch {
			failed = true;
		}
		expect(failed).toBe(true);
	});

	test("ssh runs in batch mode, keeping the operator's ssh command", async () => {
		const repo = gitRepo();
		const dir = tmpFolder();
		const seen = join(dir, "argv");
		const fakeSsh = script(dir, "fake-ssh", `echo "$@" > '${seen}'; exit 255`);
		g(repo, "remote", "add", "origin", "git@example.invalid:o/r.git");
		// core.sshCommand set by the operator: kept, with batch mode added.
		g(repo, "config", "core.sshCommand", `${fakeSsh} -o Foo=bar`);
		const r = await runGit(repo, ["push", "origin", "main"], {
			timeoutMs: 20_000,
		});
		expect(r).toMatchObject({ ok: false, code: "failed" });
		const argv = readFileSync(seen, "utf8");
		expect(argv).toContain("-o Foo=bar");
		expect(argv).toContain("-o BatchMode=yes");
		expect(argv).toContain("example.invalid");
	});

	test("gh runs in the worktree with the same environment", async () => {
		const repo = gitRepo();
		const dir = tmpFolder();
		script(
			dir,
			"gh",
			'echo "cwd=$(pwd) prompt=$GH_PROMPT_DISABLED term=$GIT_TERMINAL_PROMPT args=$*"',
		);
		const path = process.env.PATH;
		process.env.PATH = `${dir}:${path}`;
		try {
			const r = await runGh(join(repo), ["pr", "view", "--json", "state"], {
				mode: "read",
			});
			expect(r.ok).toBe(true);
			if (r.ok)
				expect(r.stdout.trim()).toBe(
					`cwd=${realpathSync(repo)} prompt=1 term=0 args=pr view --json state`,
				);
		} finally {
			process.env.PATH = path;
		}
		const missing = await runGh(tmpFolder(), ["pr", "view"]);
		expect(missing).toMatchObject({ ok: false, code: "not_a_worktree" });
	});
});
