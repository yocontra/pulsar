import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkOf,
	commit,
	createPr,
	forgetPr,
	gitStatus,
	parsePorcelain,
	prDetails,
	push,
	pushError,
} from "../src/git-actions.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type { GitStatus } from "../src/http/wire.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { fakeGh } from "./fake-gh.ts";
import { cleanupRepos, g, gitRepo, tmpFolder } from "./git-repo.ts";

/**
 * The app's git actions (src/git-actions.ts, src/service/git.ts) against a
 * temp repo whose `origin` reads as a GitHub repo but pushes to a local
 * bare repo, with a fake `gh` on PATH.
 */

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const k of ["AUTHOR", "COMMITTER"]) {
	process.env[`GIT_${k}_NAME`] = "t";
	process.env[`GIT_${k}_EMAIL`] = "t@example.com";
}
const gh = fakeGh();
process.env.FAKE_GH_DIR = gh.dir;
const PATH = process.env.PATH ?? "";
process.env.PATH = `${gh.dir}:${PATH}`;

const SLUG = "acme/demo";

/** The first project, built with git once; every project() is a copy of it. */
let template: { d: string; bare: string } | undefined;

/**
 * A repo on `main`, pushed to a bare `origin` that reads as
 * github.com/acme/demo. Copied from a template in-process (no git
 * processes): building each one with git cost ~8 processes per case, which
 * under machine load pushed cases past bun's 5 s timeout.
 */
function project() {
	template ??= (() => {
		const bare = tmpFolder();
		g(bare, "init", "-q", "--bare");
		const d = gitRepo();
		g(d, "remote", "add", "origin", `https://github.com/${SLUG}.git`);
		g(d, "config", "remote.origin.pushurl", bare);
		g(d, "push", "-q", "-u", "origin", "main");
		g(d, "remote", "set-head", "origin", "main");
		return { d, bare };
	})();
	const bare = tmpFolder();
	const d = tmpFolder();
	cpSync(template.bare, bare, { recursive: true });
	cpSync(template.d, d, { recursive: true });
	// The copy pushes to its own bare repo, not the template's.
	const config = join(d, ".git", "config");
	writeFileSync(
		config,
		readFileSync(config, "utf8").replaceAll(template.bare, bare),
	);
	return { d, bare };
}

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (e as { code?: string }).code ?? (e as Error).message;
	}
}

async function message(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (e as Error).message;
	}
}

const lines = (s: string) => s.trim().split("\n").filter(Boolean);

afterAll(() => cleanupRepos());

describe("status", () => {
	test("parses porcelain v2 with a rename and a conflict", () => {
		const out = [
			"# branch.oid 0123456789abcdef",
			"# branch.head feat",
			"# branch.upstream origin/feat",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 a a a.txt",
			"2 R. N... 100644 100644 100644 a a R100 new.txt",
			"old.txt",
			"u UU N... 1 2 3 4 a b c c.txt",
			"? x.txt",
			"",
		].join("\0");
		expect(parsePorcelain(out)).toEqual({
			ab: true,
			branch: "feat",
			head: "0123456",
			upstream: "origin/feat",
			ahead: 2,
			behind: 1,
			dirty: 4,
			conflicted: 1,
		});
	});

	test("a clean default branch, pushed", async () => {
		const { d } = project();
		const s = await gitStatus("a", d);
		expect(s).toMatchObject({
			available: true,
			branch: "main",
			defaultBranch: "main",
			onDefault: true,
			remote: "origin",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			dirty: 0,
			operation: null,
			github: true,
			// No PR lookup on the default branch.
			gh: null,
			pr: null,
		} satisfies Partial<GitStatus>);
	});

	test("a dirty feature branch before its first push; no folder; not a repo", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		writeFileSync(join(d, "new.txt"), "n\n");
		const s = await gitStatus("a", d);
		expect(s).toMatchObject({
			branch: "feat",
			onDefault: false,
			upstream: null,
			dirty: 2,
			gh: "ok",
			pr: null,
		});
		expect((await gitStatus("a", null)).reason).toBe("no_cwd");
		expect((await gitStatus("a", tmpFolder())).reason).toBe("not_a_repo");
	});

	test("a merge in progress, detached HEAD, a repo with no remote", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "other");
		writeFileSync(join(d, "a.txt"), "theirs\n");
		g(d, "commit", "-qam", "theirs");
		g(d, "switch", "-q", "main");
		writeFileSync(join(d, "a.txt"), "ours\n");
		g(d, "commit", "-qam", "ours");
		try {
			g(d, "merge", "-q", "other");
		} catch {}
		const s = await gitStatus("a", d);
		expect(s.operation).toBe("merge");
		expect(s.conflicted).toBe(1);
		expect(await message(commit(d, { files: ["a.txt"], message: "m" }))).toBe(
			"A merge is in progress. Finish or abort it in the terminal first.",
		);
		g(d, "merge", "--abort");
		g(d, "switch", "-q", "--detach", "HEAD");
		expect((await gitStatus("a", d)).branch).toBeNull();
		const lone = gitRepo();
		expect(await gitStatus("a", lone)).toMatchObject({
			remote: null,
			github: false,
			defaultBranch: "main",
		});
	});
});

describe("commit", () => {
	test("exactly the chosen files: modified, untracked, deleted, renamed; not what the agent staged", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		writeFileSync(join(d, "new.txt"), "n\n");
		rmSync(join(d, "gone.txt"));
		g(d, "mv", "old name.txt", "new name.txt");
		// The agent staged a file the operator leaves out.
		writeFileSync(join(d, "agent.txt"), "wip\n");
		g(d, "add", "agent.txt");
		const r = await commit(d, {
			files: ["a.txt", "new.txt", "gone.txt", "new name.txt"],
			message: "Fix the thing\n\nWith a body.",
		});
		expect(r).toMatchObject({
			branch: "feat",
			subject: "Fix the thing",
			files: 4,
		});
		expect(r.sha).toMatch(/^[0-9a-f]{7,}$/);
		expect(
			lines(g(d, "show", "--name-status", "--format=", "-M", "HEAD")).sort(),
		).toEqual(
			[
				"M\ta.txt",
				"A\tnew.txt",
				"D\tgone.txt",
				"R100\told name.txt\tnew name.txt",
			].sort(),
		);
		// Still staged, still uncommitted.
		expect(lines(g(d, "diff", "--cached", "--name-only"))).toEqual([
			"agent.txt",
		]);
		expect(g(d, "log", "-1", "--format=%B").trim()).toBe(
			"Fix the thing\n\nWith a body.",
		);
	});

	test("a partly staged file commits as the worktree has it", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "staged\n");
		g(d, "add", "a.txt");
		appendFileSync(join(d, "a.txt"), "unstaged\n");
		await commit(d, { files: ["a.txt"], message: "both" });
		expect(g(d, "show", "HEAD:a.txt")).toBe(
			"one\ntwo\nthree\nstaged\nunstaged\n",
		);
		expect(g(d, "status", "--porcelain")).toBe("");
	});

	test("refuses unknown paths, a clean tree and detached HEAD; the default branch needs a confirm", async () => {
		const { d } = project();
		expect(await message(commit(d, { files: ["a.txt"], message: "m" }))).toBe(
			"Worktree is clean. Make changes before committing.",
		);
		appendFileSync(join(d, "a.txt"), "four\n");
		expect(await code(commit(d, { files: ["a.txt"], message: "m" }))).toBe(
			"confirm_default",
		);
		expect(
			await code(
				commit(d, { files: ["nope.txt"], message: "m", confirmDefault: true }),
			),
		).toBe("not_found");
		// Outside the repo, through the literal pathspec: never listed.
		expect(
			await code(
				commit(d, { files: ["../x"], message: "m", confirmDefault: true }),
			),
		).toBe("not_found");
		await commit(d, { files: ["a.txt"], message: "m", confirmDefault: true });
		expect(g(d, "log", "-1", "--format=%s").trim()).toBe("m");
		appendFileSync(join(d, "a.txt"), "five\n");
		g(d, "switch", "-q", "--detach", "HEAD");
		expect(await message(commit(d, { files: ["a.txt"], message: "m" }))).toBe(
			"Detached HEAD: commit on a new branch.",
		);
	});

	test("on a new branch; a bad branch name is refused", async () => {
		const { d } = project();
		appendFileSync(join(d, "a.txt"), "four\n");
		expect(
			await code(
				commit(d, { files: ["a.txt"], message: "m", newBranch: "bad..name" }),
			),
		).toBe("git_refused");
		const r = await commit(d, {
			files: ["a.txt"],
			message: "m",
			newBranch: "fix/one",
		});
		expect(r.branch).toBe("fix/one");
		expect(g(d, "branch", "--show-current").trim()).toBe("fix/one");
		expect(g(d, "log", "-1", "--format=%s", "main").trim()).toBe("init");
	});

	test("a failing hook: its message, and the files go back to unstaged", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		const hook = join(d, ".git", "hooks", "pre-commit");
		writeFileSync(
			hook,
			"#!/bin/sh\necho 'error: lint failed in new.txt' >&2\nexit 1\n",
		);
		chmodSync(hook, 0o755);
		writeFileSync(join(d, "new.txt"), "n\n");
		appendFileSync(join(d, "a.txt"), "four\n");
		expect(
			await message(commit(d, { files: ["new.txt", "a.txt"], message: "m" })),
		).toBe("error: lint failed in new.txt");
		expect(g(d, "diff", "--cached", "--name-only")).toBe("");
		expect(g(d, "status", "--porcelain", "--", "new.txt").trim()).toBe(
			"?? new.txt",
		);
		// On a new branch: back on the old one, the new one gone (a retry works).
		expect(
			await code(
				commit(d, { files: ["new.txt"], message: "m", newBranch: "try/one" }),
			),
		).toBe("git_failed");
		expect(g(d, "branch", "--show-current").trim()).toBe("feat");
		expect(g(d, "branch", "--list", "try/one")).toBe("");
		expect(g(d, "status", "--porcelain", "--", "new.txt").trim()).toBe(
			"?? new.txt",
		);
	});
});

describe("push", () => {
	test("sets the upstream on the first push; then nothing to push", async () => {
		const { d, bare } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "c1");
		expect(await push(d, {})).toEqual({
			branch: "feat",
			remote: "origin",
			upstream: "origin/feat",
			pushed: true,
		});
		expect(g(bare, "log", "-1", "--format=%s", "feat").trim()).toBe("c1");
		expect(g(d, "rev-parse", "--abbrev-ref", "feat@{upstream}").trim()).toBe(
			"origin/feat",
		);
		expect((await push(d, {})).pushed).toBe(false);
		appendFileSync(join(d, "a.txt"), "five\n");
		g(d, "commit", "-qam", "c2");
		expect((await push(d, {})).pushed).toBe(true);
		expect(g(bare, "log", "-1", "--format=%s", "feat").trim()).toBe("c2");
	});

	test("behind, diverged, the default branch, detached, no remote", async () => {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "c1");
		await push(d, {});
		g(d, "reset", "-q", "--hard", "HEAD~1");
		expect(await message(push(d, {}))).toBe(
			"Branch is behind upstream. Pull or rebase before pushing.",
		);
		writeFileSync(join(d, "x.txt"), "x\n");
		g(d, "add", "x.txt");
		g(d, "commit", "-qm", "other");
		expect(await message(push(d, {}))).toBe(
			"Branch has diverged from upstream. Rebase or merge first.",
		);
		g(d, "switch", "-q", "main");
		appendFileSync(join(d, "a.txt"), "m\n");
		g(d, "commit", "-qam", "on main");
		expect(await code(push(d, {}))).toBe("confirm_default");
		expect((await push(d, { confirmDefault: true })).pushed).toBe(true);
		g(d, "switch", "-q", "--detach", "HEAD");
		expect(await code(push(d, {}))).toBe("git_refused");
		const lone = gitRepo();
		g(lone, "switch", "-q", "-c", "feat");
		expect(await message(push(lone, {}))).toBe(
			"This repo has no remote to push to.",
		);
	});

	test("a branch that tracks the default branch pushes to its own name", async () => {
		const { d, bare } = project();
		// `checkout -b feature origin/main`: the upstream is origin/main.
		g(d, "checkout", "-q", "-b", "feature", "origin/main");
		expect(g(d, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe(
			"origin/main",
		);
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "on feature");
		const s = await gitStatus("a", d, { pr: false });
		expect(s).toMatchObject({
			upstream: "origin/main",
			pushTo: "origin/feature",
			onDefault: false,
			ahead: 0,
		});
		// No PR before the push: the branch is not on the remote yet.
		expect(await message(createPr(d, {}))).toBe("Push the branch first.");
		expect(await push(d, {})).toEqual({
			branch: "feature",
			remote: "origin",
			upstream: "origin/feature",
			pushed: true,
		});
		// main on the remote is untouched; the upstream now is origin/feature.
		expect(g(bare, "log", "-1", "--format=%s", "main").trim()).toBe("init");
		expect(g(bare, "log", "-1", "--format=%s", "feature").trim()).toBe(
			"on feature",
		);
		expect(g(d, "rev-parse", "--abbrev-ref", "feature@{upstream}").trim()).toBe(
			"origin/feature",
		);
		// --set-upstream-to another branch: the same.
		g(d, "switch", "-q", "-c", "hotfix");
		g(d, "branch", "-q", "--set-upstream-to", "origin/main");
		appendFileSync(join(d, "a.txt"), "five\n");
		g(d, "commit", "-qam", "hotfix");
		expect((await push(d, {})).upstream).toBe("origin/hotfix");
		expect(g(bare, "log", "-1", "--format=%s", "main").trim()).toBe("init");
	});

	test("an upstream whose branch is gone: push recreates it, no PR before", async () => {
		const { d, bare } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "c1");
		await push(d, {});
		// Deleted on the remote after a merge (and pruned here).
		g(bare, "branch", "-q", "-D", "feat");
		g(d, "update-ref", "-d", "refs/remotes/origin/feat");
		const s = await gitStatus("a", d, { pr: false });
		expect(s).toMatchObject({
			upstream: "origin/feat",
			upstreamGone: true,
			ahead: 0,
		});
		expect(await message(createPr(d, {}))).toBe("Push the branch first.");
		expect((await push(d, {})).pushed).toBe(true);
		expect(g(bare, "log", "-1", "--format=%s", "feat").trim()).toBe("c1");
		expect((await gitStatus("a", d, { pr: false })).upstreamGone).toBe(false);
	});

	test("a rejected push says what the remote said", async () => {
		const { d, bare } = project();
		const hook = join(bare, "hooks", "pre-receive");
		writeFileSync(
			hook,
			"#!/bin/sh\necho 'protected: pushes are closed' >&2\nexit 1\n",
		);
		chmodSync(hook, 0o755);
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "c1");
		const m = await message(push(d, {}));
		expect(m).toContain("protected: pushes are closed");
		expect(await code(push(d, {}))).toBe("git_failed");
	});
});

test("push errors: credentials first, then the remote's words and the reason", () => {
	expect(
		pushError(
			"",
			"git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n",
			"fatal: Could not read from remote repository.",
		),
	).toBe("git@github.com: Permission denied (publickey).");
	expect(
		pushError(
			"To /r\n!\tHEAD:refs/heads/feat\t[rejected] (non-fast-forward)\nDone\n",
			"error: failed to push some refs to '/r'\n",
			"error: failed to push some refs to '/r'",
		),
	).toBe("Push rejected (non-fast-forward)");
	expect(pushError("", "fatal: unknown\n", "fatal: unknown")).toBe(
		"fatal: unknown",
	);
});

describe("PR", () => {
	async function pushedBranch() {
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		g(d, "commit", "-qam", "Make it four");
		return d;
	}

	test("needs a push first; creates with gh; then finds it", async () => {
		gh.set({ prs: {} });
		const d = await pushedBranch();
		expect(await message(createPr(d, {}))).toBe("Push the branch first.");
		await push(d, {});
		const r = await createPr(d, {});
		expect(r.created).toBe(true);
		expect(r.pr).toMatchObject({
			number: 7,
			url: `https://github.com/${SLUG}/pull/7`,
			state: "open",
			base: "main",
			head: "feat",
		});
		const create = gh.calls().find((c) => c[1] === "create")!;
		expect(create).toEqual([
			"pr",
			"create",
			"--repo",
			SLUG,
			"--head",
			"feat",
			"--base",
			"main",
			"--fill",
		]);
		// Already there: the same PR, not a second one.
		const again = await createPr(d, {});
		expect(again).toEqual({ pr: r.pr, created: false });
		const s = await gitStatus("a", d);
		expect(s.pr?.number).toBe(7);
	});

	test("title, body and draft; gh's own error passes through", async () => {
		gh.set({ prs: {}, next: 12 });
		const d = await pushedBranch();
		await push(d, {});
		gh.set({
			prs: {},
			createError:
				"pull request create failed: GraphQL: No commits between main and feat",
		});
		expect(await message(createPr(d, {}))).toBe(
			"pull request create failed: GraphQL: No commits between main and feat",
		);
		gh.set({ prs: {}, next: 12 });
		forgetPr((await gitStatus("a", d, { pr: false })).root!);
		const r = await createPr(d, { title: "T", body: "B", draft: true });
		expect(r.pr).toMatchObject({ number: 12, title: "T", state: "draft" });
		const create = gh.calls().findLast((c) => c[1] === "create")!;
		expect(create.slice(-5)).toEqual([
			"--title",
			"T",
			"--body",
			"B",
			"--draft",
		]);
	});

	test("gh missing or logged out; the default branch; no GitHub remote", async () => {
		const d = await pushedBranch();
		await push(d, {});
		const root = (await gitStatus("a", d, { pr: false })).root!;
		gh.set({ prs: {}, mode: "logged_out" });
		forgetPr(root);
		expect(await message(createPr(d, {}))).toBe(
			"gh is not logged in on the agent's machine. Run gh auth login.",
		);
		forgetPr(root);
		expect((await gitStatus("a", d)).gh).toBe("logged_out");
		forgetPr(root);
		const gitOnly = tmpFolder();
		symlinkSync(Bun.which("git")!, join(gitOnly, "git"));
		process.env.PATH = gitOnly;
		try {
			expect(await message(createPr(d, {}))).toBe(
				"gh is not installed on the agent's machine.",
			);
			forgetPr(root);
			expect((await gitStatus("a", d)).gh).toBe("missing");
		} finally {
			process.env.PATH = `${gh.dir}:${PATH}`;
			forgetPr(root);
		}
		gh.set({ prs: {} });
		g(d, "switch", "-q", "main");
		expect(await message(createPr(d, {}))).toBe(
			"You're on the default branch. Commit on a new branch first.",
		);
		const lone = gitRepo();
		g(lone, "switch", "-q", "-c", "feat");
		expect(await message(createPr(lone, {}))).toBe("PRs need a GitHub remote.");
	});

	test("details: checks, the review verdict, review and inline comments", async () => {
		const d = await pushedBranch();
		gh.set({
			prs: {
				feat: {
					number: 3,
					url: `https://github.com/${SLUG}/pull/3`,
					title: "Four",
					state: "OPEN",
					isDraft: false,
					baseRefName: "main",
					headRefName: "feat",
					reviewDecision: "CHANGES_REQUESTED",
					statusCheckRollup: [
						{
							__typename: "CheckRun",
							name: "test",
							status: "COMPLETED",
							conclusion: "FAILURE",
							detailsUrl: "https://ci/1",
							workflowName: "CI",
						},
						{
							__typename: "CheckRun",
							name: "lint",
							status: "IN_PROGRESS",
							conclusion: null,
						},
						{
							__typename: "StatusContext",
							context: "deploy",
							state: "SUCCESS",
							targetUrl: "https://deploy",
						},
					],
					reviews: [
						{
							author: { login: "rev" },
							body: "Please handle the empty case.",
							state: "CHANGES_REQUESTED",
							submittedAt: "2026-11-19T10:00:00Z",
						},
						{ author: { login: "bot" }, body: "", state: "COMMENTED" },
					],
				},
			},
			comments: [
				{
					user: { login: "rev" },
					body: "Off by one here.",
					path: "a.txt",
					line: 4,
					html_url: "https://github.com/acme/demo/pull/3#r1",
					created_at: "2026-11-19T10:01:00Z",
				},
			],
		});
		const r = await prDetails("a", d);
		expect(r.pr).toMatchObject({ number: 3, state: "open" });
		expect(r.review).toBe("changes_requested");
		expect(r.checks).toEqual([
			{ name: "test", state: "fail", url: "https://ci/1", workflow: "CI" },
			{ name: "lint", state: "pending", url: null, workflow: null },
			{ name: "deploy", state: "pass", url: "https://deploy", workflow: null },
		]);
		expect(r.comments).toEqual([
			{
				author: "rev",
				body: "Please handle the empty case.",
				path: null,
				line: null,
				verdict: "changes_requested",
				url: null,
				at: "2026-11-19T10:00:00Z",
			},
			{
				author: "rev",
				body: "Off by one here.",
				path: "a.txt",
				line: 4,
				url: "https://github.com/acme/demo/pull/3#r1",
				at: "2026-11-19T10:01:00Z",
			},
		]);
		expect(checkOf({ status: "COMPLETED", conclusion: "SKIPPED" }).state).toBe(
			"skipped",
		);
		// No PR for the branch: an empty card, no error.
		gh.set({ prs: {} });
		forgetPr((await gitStatus("a", d, { pr: false })).root!);
		expect((await prDetails("a", d)).pr).toBeNull();
	});
});

describe("service and routes", () => {
	const OWNER = "me@example.com";
	const VERIFIED = {
		kind: "human" as const,
		login: OWNER,
		node: "phone",
		verified: true as const,
	};
	let dir: string;
	let store: Store;
	let service: PulsarService;
	let http: HttpTransport;
	let base: string;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-git-actions-"));
		store = new Store(join(dir, "pulsar.db"));
		service = new PulsarService({ store, scan: false, machine: "studio" });
		http = new HttpTransport(service, {
			identity: new StaticIdentity(OWNER, "phone"),
			owner: OWNER,
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: null,
			hub: { coalesceMs: 60_000 },
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}/api/v1`;
	});
	afterAll(async () => {
		await http.close();
		service.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const agentIn = (cwd: string, sessionId: string) =>
		service.registry.upsert({
			harness: "pi",
			sessionId,
			pid: null,
			cwd,
			project: "demo",
			branch: "feat",
			tags: [],
			meta: {},
			registered: false,
		});

	const post = (path: string, body: unknown) =>
		fetch(`${base}${path}`, {
			method: "POST",
			headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

	test("a working agent needs a confirm; commit, push and PR run as acting ops, audited", async () => {
		gh.set({ prs: {}, next: 21 });
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat");
		appendFileSync(join(d, "a.txt"), "four\n");
		const a = agentIn(d, "git-svc-1");
		a.status = "busy";
		const run = (op: "git.commit" | "git.push" | "git.pr", params: object) =>
			service.acting.run(VERIFIED, op, { agent: a.id }, params);
		expect(
			await code(run("git.commit", { files: ["a.txt"], message: "m" })),
		).toBe("confirm_busy");
		expect(
			await message(run("git.commit", { files: ["a.txt"], message: "m" })),
		).toBe(`${a.name} is working. Confirm to go ahead anyway.`);
		const c = (await run("git.commit", {
			files: ["a.txt"],
			message: "m",
			confirmBusy: true,
		})) as { branch: string };
		expect(c.branch).toBe("feat");
		expect(await code(run("git.push", {}))).toBe("confirm_busy");
		a.status = "idle";
		expect(((await run("git.push", {})) as { pushed: boolean }).pushed).toBe(
			true,
		);
		const pr = (await run("git.pr", {})) as { pr: { number: number } };
		expect(pr.pr.number).toBe(21);
		// Params are checked exactly: unknown fields and wrong types fail.
		expect(await code(run("git.push", { force: true }))).toBe("bad_request");
		expect(await code(run("git.commit", { files: [], message: "m" }))).toBe(
			"bad_request",
		);
		expect(await code(run("git.commit", { files: ["a"], message: "  " }))).toBe(
			"bad_request",
		);
		const ops = store.db
			.prepare(
				"SELECT op, ok FROM audit WHERE op LIKE 'git.%' AND target = ? ORDER BY id",
			)
			.all(a.id) as { op: string; ok: number }[];
		expect(ops.filter((o) => o.ok === 1).map((o) => o.op)).toEqual([
			"git.commit",
			"git.push",
			"git.pr",
		]);
	});

	test("routes: status and PR reads; writes need Prove Human and valid params", async () => {
		gh.set({ prs: {} });
		const { d } = project();
		g(d, "switch", "-q", "-c", "feat2");
		appendFileSync(join(d, "a.txt"), "four\n");
		const a = agentIn(d, "git-svc-2");
		const id = encodeURIComponent(a.id);
		const st = await fetch(`${base}/agents/${id}/git/status`, {
			headers: { "X-Pulsar": "1" },
		});
		expect(st.status).toBe(200);
		expect(await st.json()).toMatchObject({
			agent: a.id,
			branch: "feat2",
			dirty: 1,
		});
		const pr = await fetch(`${base}/agents/${id}/git/pr`, {
			headers: { "X-Pulsar": "1" },
		});
		expect(await pr.json()).toMatchObject({ agent: a.id, pr: null });
		const noSession = await post(`/agents/${id}/git/commit`, {
			files: ["a.txt"],
			message: "m",
		});
		expect(noSession.status).toBe(401);
		const bad = await post(`/agents/${id}/git/commit`, { files: "a.txt" });
		expect(bad.status).toBe(400);
		expect((await post(`/agents/${id}/git/push`, { force: true })).status).toBe(
			400,
		);
		const op = await fetch(`${base}/agents/cli%3Aoperator/git/status`, {
			headers: { "X-Pulsar": "1" },
		});
		expect(op.status).toBe(200);
		expect(await op.json()).toMatchObject({
			available: false,
			reason: "no_cwd",
		});
		expect(
			(
				await fetch(`${base}/agents/nope/git/status`, {
					headers: { "X-Pulsar": "1" },
				})
			).status,
		).toBe(404);
		expect(
			(
				(await (
					await fetch(`${base}/hello`, { headers: { "X-Pulsar": "1" } })
				).json()) as {
					features: string[];
				}
			).features,
		).toContain("git");
	});
});
