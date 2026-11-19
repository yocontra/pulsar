/**
 * The git actions' choices (web/src/features/git/model.ts): which quick
 * action a worktree gets, why an action is off, and the texts drafted
 * without AI (commit message, branch name, the fix request).
 */
import { describe, expect, test } from "bun:test";
import type { ChangedFile, GitStatus } from "../src/api/types.ts";
import {
	blocked,
	branchFrom,
	commitReason,
	draftMessage,
	fixRequest,
	prReason,
	pushReason,
	quickAction,
} from "../src/features/git/model.ts";

const base: GitStatus = {
	agent: "a",
	available: true,
	root: "/w",
	branch: "feat",
	head: "abc1234",
	defaultBranch: "main",
	onDefault: false,
	remote: "origin",
	upstream: "origin/feat",
	pushTo: "origin/feat",
	upstreamGone: false,
	ahead: 0,
	behind: 0,
	dirty: 0,
	conflicted: 0,
	operation: null,
	github: true,
	gh: "ok",
	pr: null,
};
const st = (over: Partial<GitStatus>): GitStatus => ({ ...base, ...over });
const PR = {
	number: 7,
	url: "https://github.com/a/b/pull/7",
	title: "T",
	state: "open" as const,
	base: "main",
	head: "feat",
};

describe("quickAction", () => {
	const q = (over: Partial<GitStatus>) => quickAction(st(over), "studio");
	test("dirty: commit, push & PR; with a PR open, commit & push", () => {
		expect(q({ dirty: 2 })).toEqual({
			label: "Commit, push & PR",
			steps: ["commit", "push", "pr"],
		});
		expect(q({ dirty: 2, pr: PR }).label).toBe("Commit & push");
		// The default branch: no PR from it.
		expect(q({ dirty: 1, branch: "main", onDefault: true }).label).toBe(
			"Commit & push",
		);
		// No GitHub, or gh not usable: no PR step.
		expect(q({ dirty: 1, github: false }).label).toBe("Commit & push");
		expect(q({ dirty: 1, gh: "missing" }).label).toBe("Commit & push");
		// No remote, or behind it: commit only.
		expect(q({ dirty: 1, remote: null }).label).toBe("Commit");
		expect(q({ dirty: 1, behind: 1 }).label).toBe("Commit");
		// Detached: commit (the dialog asks for a branch).
		expect(q({ dirty: 1, branch: null }).steps).toEqual(["commit"]);
	});

	test("clean: push & create PR, push, create PR, view PR", () => {
		expect(q({ ahead: 2 }).steps).toEqual(["push", "pr"]);
		expect(q({ upstream: null }).label).toBe("Push & create PR");
		expect(q({ ahead: 2, pr: PR }).label).toBe("Push");
		expect(q({}).label).toBe("Create PR");
		expect(q({ pr: PR })).toEqual({
			label: "View PR #7",
			steps: [],
			href: PR.url,
		});
		// A merged PR: a new one can be opened.
		expect(q({ pr: { ...PR, state: "merged" } }).label).toBe("Create PR");
	});

	test("disabled, with the reason", () => {
		expect(q({ behind: 2 }).disabled).toBe(
			"Branch is behind upstream. Pull or rebase before pushing.",
		);
		expect(q({ behind: 2, ahead: 1 }).disabled).toBe(
			"Branch has diverged from upstream. Rebase or merge first.",
		);
		expect(q({ github: false }).disabled).toBe(
			"Worktree is clean. Make changes before committing.",
		);
		expect(q({ branch: null, github: false }).disabled).toBe(
			"Detached HEAD: check out a branch first.",
		);
		expect(q({ operation: "rebase", dirty: 3 }).disabled).toBe(
			"A rebase is in progress. Finish it in the terminal first.",
		);
		expect(q({ conflicted: 1, dirty: 1 }).disabled).toBe(
			"Resolve the merge conflicts first.",
		);
		expect(quickAction(undefined, "x").disabled).toBe("Reading the worktree…");
		expect(
			quickAction(st({ available: false, reason: "unsupported" }), "x")
				.disabled,
		).toBe("The agent's machine runs an older Pulsar.");
	});
});

describe("reasons", () => {
	test("commit, push, PR", () => {
		expect(commitReason(st({}))).toBe(
			"Worktree is clean. Make changes before committing.",
		);
		expect(commitReason(st({ dirty: 1 }))).toBeNull();
		expect(pushReason(st({}))).toBe("Nothing to push.");
		expect(pushReason(st({ remote: null, ahead: 1 }))).toBe(
			"This repo has no remote to push to.",
		);
		expect(pushReason(st({ branch: null }))).toBe(
			"Detached HEAD: check out a branch before pushing.",
		);
		expect(pushReason(st({ upstream: null }))).toBeNull();
		expect(prReason(st({ ahead: 1 }), "studio")).toBe("Push the branch first.");
		expect(prReason(st({ gh: "logged_out" }), "studio")).toBe(
			"gh isn't logged in on studio. Run gh auth login there.",
		);
		expect(prReason(st({ gh: "missing" }), undefined)).toBe(
			"gh isn't installed on the agent's machine.",
		);
		expect(prReason(st({ onDefault: true, branch: "main" }), "s")).toBe(
			"You're on the default branch. Commit on a new branch first.",
		);
		expect(prReason(st({ github: false }), "s")).toBe(
			"PRs need a GitHub remote.",
		);
		expect(blocked(st({}))).toBeNull();
	});
});

const file = (path: string, status: ChangedFile["status"], oldPath?: string) =>
	({
		path,
		status,
		...(oldPath ? { oldPath } : {}),
		staged: false,
		unstaged: true,
		binary: false,
		added: 1,
		removed: 0,
		key: path,
	}) satisfies ChangedFile;

describe("drafts", () => {
	test("a commit message from the files", () => {
		expect(draftMessage([])).toBe("");
		expect(draftMessage([file("src/a.ts", "modified")])).toBe(
			"Update src/a.ts",
		);
		expect(draftMessage([file("b.ts", "untracked")])).toBe("Add b.ts");
		expect(draftMessage([file("src/new.ts", "renamed", "src/old.ts")])).toBe(
			"Rename old.ts to new.ts",
		);
		expect(
			draftMessage([
				file("src/auth/a.ts", "modified"),
				file("src/auth/b.ts", "added"),
				file("src/auth/c/d.ts", "deleted"),
			]),
		).toBe(
			"Update src/auth: a.ts, b.ts and 1 more\n\n- src/auth/a.ts\n- src/auth/b.ts (added)\n- src/auth/c/d.ts (deleted)",
		);
		expect(
			draftMessage([file("x.ts", "added"), file("y.ts", "untracked")]).split(
				"\n",
			)[0],
		).toBe("Add x.ts, y.ts");
	});

	test("a branch name from the message", () => {
		expect(branchFrom("Fix the token race!\n\nbody", "pi")).toBe(
			"pulsar/fix-the-token-race",
		);
		expect(branchFrom("", "Codex Agent")).toBe("pulsar/codex-agent");
	});

	test("the fix request: failing checks and comments, capped", () => {
		const text = fixRequest({
			pr: { number: 3, url: "https://x/pull/3" },
			checks: [
				{ name: "test", state: "fail", url: "https://ci/1" },
				{ name: "lint", state: "pass", url: null },
			],
			comments: [
				{
					author: "rev",
					body: "Off\nby one",
					path: "a.ts",
					line: 4,
				},
				{ author: "bot", body: "x".repeat(2000), path: null, line: null },
			],
		});
		expect(text.split("\n").slice(0, 7)).toEqual([
			"Please fix PR #3 (https://x/pull/3).",
			"",
			"Failing checks:",
			"- test (https://ci/1)",
			"",
			"Review comments:",
			"- rev on a.ts:4: Off by one",
		]);
		expect(text).not.toContain("lint");
		expect(text.length).toBeLessThan(1000);
		expect(fixRequest({ pr: null, checks: [], comments: [] })).toBe("");
	});
});
