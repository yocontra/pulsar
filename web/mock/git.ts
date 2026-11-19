/**
 * Mock git actions (src/git-actions.ts): each agent's branch, upstream and
 * PR, and commit / push / PR that change them, with the daemon's guards
 * (a working agent and the default branch need a confirm). apparish-auth
 * has an open PR with a failing check and review comments; omp@apparish
 * has no repo. `/__mock/git` changes an agent's state or makes the next
 * action fail (the e2e tests).
 */
import type {
	ChangesSummary,
	GitCheck,
	GitCommitResult,
	GitPr,
	GitPrDetails,
	GitPrResult,
	GitPushResult,
	GitReviewComment,
	GitStatus,
} from "../../src/http/wire.ts";
import { commitChanges } from "./changes.ts";
import type { MockAgent } from "./data.ts";

export class GitMockError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

interface MockGit {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	remote: string | null;
	github: boolean;
	gh: "ok" | "missing" | "logged_out";
	pr: GitPr | null;
	checks: GitCheck[];
	review: GitPrDetails["review"];
	comments: GitReviewComment[];
	/** The next action of this kind fails with this. */
	fail?: { op: string; code: string; message: string };
	/** A head counter for commit ids. */
	commits: number;
}

const DEFAULT = "main";
const state = new Map<string, MockGit>();

function prOf(a: MockAgent, n: string, branch: string): GitPr {
	return {
		number: Number(n),
		url: `${a.repoUrl ?? "https://github.com/acme/app"}/pull/${n}`,
		title:
			a.name === "apparish-auth"
				? "Fix the token refresh race"
				: `Work on ${branch}`,
		state: "open",
		base: DEFAULT,
		head: branch,
	};
}

function gitOf(a: MockAgent): MockGit {
	let g = state.get(a.id);
	if (g) return g;
	const branch = a.branch;
	g = {
		branch,
		upstream: branch ? `origin/${branch}` : null,
		ahead: 0,
		behind: 0,
		remote: "origin",
		github: true,
		gh: "ok",
		pr: null,
		checks: [],
		review: null,
		comments: [],
		commits: 0,
	};
	if (a.name === "apparish-auth" && branch) {
		g.pr = prOf(a, "1402", branch);
		g.review = "changes_requested";
		g.checks = [
			{
				name: "test (ubuntu)",
				state: "fail",
				url: "https://ci.example/1",
				workflow: "CI",
			},
			{
				name: "lint",
				state: "pass",
				url: "https://ci.example/2",
				workflow: "CI",
			},
			{ name: "e2e", state: "pending", url: null, workflow: "CI" },
		];
		g.comments = [
			{
				author: "reviewer",
				body: "The retry path still races when two refreshes start together.",
				path: null,
				line: null,
				verdict: "changes_requested",
				url: null,
				at: "2026-11-19T10:00:00Z",
			},
			{
				author: "reviewer",
				body: "Use the mutex here too.",
				path: "src/auth/refresh.ts",
				line: 42,
				url: `${a.repoUrl ?? "https://github.com/acme/app"}/pull/1402#r1`,
				at: "2026-11-19T10:01:00Z",
			},
		];
	} else if (a.name === "codex@apparish") {
		// Committed, not pushed, no PR: "Push & create PR".
		g.ahead = 2;
	} else if (a.pr && branch && branch !== DEFAULT) g.pr = prOf(a, a.pr, branch);
	state.set(a.id, g);
	return g;
}

export function resetGit() {
	state.clear();
	nextPr = FIRST_PR;
}

export function gitStatus(a: MockAgent, s: ChangesSummary): GitStatus {
	if (!s.available)
		return {
			agent: a.id,
			available: false,
			reason: s.reason === "no_cwd" ? "no_cwd" : "not_a_repo",
			root: null,
			branch: null,
			head: null,
			defaultBranch: null,
			onDefault: false,
			remote: null,
			upstream: null,
			pushTo: null,
			upstreamGone: false,
			ahead: 0,
			behind: 0,
			dirty: 0,
			conflicted: 0,
			operation: null,
			github: false,
			gh: null,
			pr: null,
		};
	const g = gitOf(a);
	const onDefault = g.branch === DEFAULT;
	return {
		agent: a.id,
		available: true,
		root: s.root,
		branch: g.branch,
		head: (0x9b7e4d2 + g.commits).toString(16),
		defaultBranch: DEFAULT,
		onDefault,
		remote: g.remote,
		upstream: g.upstream,
		pushTo: g.remote && g.branch ? `${g.remote}/${g.branch}` : null,
		upstreamGone: false,
		ahead: g.ahead,
		behind: g.behind,
		dirty: s.total,
		conflicted: 0,
		operation: null,
		github: g.github,
		gh: g.github && !onDefault ? g.gh : null,
		pr: g.gh === "ok" && !onDefault ? g.pr : null,
	};
}

export function gitPrDetails(a: MockAgent): GitPrDetails {
	const g = gitOf(a);
	const base = { agent: a.id, checks: [], review: null, comments: [] };
	if (!g.github) return { ...base, pr: null, reason: "no_github" };
	if (g.gh !== "ok")
		return {
			...base,
			pr: null,
			reason: g.gh === "missing" ? "gh_missing" : "gh_logged_out",
		};
	return {
		agent: a.id,
		pr: g.pr,
		checks: g.pr ? g.checks : [],
		review: g.pr ? g.review : null,
		comments: g.pr ? g.comments : [],
	};
}

const refuse = (message: string) =>
	new GitMockError(409, "git_refused", message);

function failNext(g: MockGit, op: string) {
	if (g.fail?.op !== op) return;
	const f = g.fail;
	delete g.fail;
	throw new GitMockError(409, f.code, f.message);
}

function busyGuard(a: MockAgent, confirmed: unknown) {
	if (!confirmed && (a.status === "busy" || a.status === "needs-you"))
		throw new GitMockError(
			409,
			"confirm_busy",
			`${a.name} is working. Confirm to go ahead anyway.`,
		);
}

export function gitCommit(
	a: MockAgent,
	s: ChangesSummary,
	p: {
		files?: unknown;
		message?: unknown;
		newBranch?: unknown;
		confirmBusy?: unknown;
		confirmDefault?: unknown;
	},
): GitCommitResult {
	const g = gitOf(a);
	if (!Array.isArray(p.files) || p.files.length === 0)
		throw new GitMockError(400, "bad_request", "files: pick at least one file");
	if (typeof p.message !== "string" || !p.message.trim())
		throw new GitMockError(
			400,
			"bad_request",
			"message: write a commit message",
		);
	busyGuard(a, p.confirmBusy);
	failNext(g, "commit");
	if (s.total === 0)
		throw refuse("Worktree is clean. Make changes before committing.");
	if (!p.newBranch && g.branch === DEFAULT && !p.confirmDefault)
		throw new GitMockError(
			409,
			"confirm_default",
			`This commits on the default branch (${DEFAULT}).`,
		);
	const known = new Set(s.files.map((f) => f.path));
	for (const f of p.files as string[])
		if (!known.has(f))
			throw new GitMockError(404, "not_found", `no change to ${f}`);
	if (typeof p.newBranch === "string") {
		g.branch = p.newBranch;
		g.upstream = null;
		g.ahead = 0;
		g.pr = null;
	}
	commitChanges(a, p.files as string[]);
	g.ahead++;
	g.commits++;
	return {
		sha: (0x9b7e4d2 + g.commits).toString(16),
		branch: g.branch,
		subject: p.message.trim().split("\n")[0]!,
		files: (p.files as string[]).length,
	};
}

export function gitPush(
	a: MockAgent,
	p: { confirmBusy?: unknown; confirmDefault?: unknown },
): GitPushResult {
	const g = gitOf(a);
	busyGuard(a, p.confirmBusy);
	failNext(g, "push");
	if (!g.branch)
		throw refuse("Detached HEAD: check out a branch before pushing.");
	if (!g.remote) throw refuse("This repo has no remote to push to.");
	if (g.upstream && g.behind > 0)
		throw refuse("Branch is behind upstream. Pull or rebase before pushing.");
	if (g.upstream && g.ahead === 0)
		return {
			branch: g.branch,
			remote: g.remote,
			upstream: g.upstream,
			pushed: false,
		};
	if (g.branch === DEFAULT && !p.confirmDefault)
		throw new GitMockError(
			409,
			"confirm_default",
			`This pushes the default branch (${DEFAULT}).`,
		);
	g.upstream ??= `${g.remote}/${g.branch}`;
	g.ahead = 0;
	return {
		branch: g.branch,
		remote: g.remote,
		upstream: g.upstream,
		pushed: true,
	};
}

const FIRST_PR = 1500;
let nextPr = FIRST_PR;

export function gitCreatePr(
	a: MockAgent,
	p: { title?: unknown; draft?: unknown },
): GitPrResult {
	const g = gitOf(a);
	failNext(g, "pr");
	if (!g.branch || g.branch === DEFAULT)
		throw refuse("You're on the default branch. Commit on a new branch first.");
	if (!g.github) throw refuse("PRs need a GitHub remote.");
	if (g.gh === "logged_out")
		throw refuse(
			"gh is not logged in on the agent's machine. Run gh auth login.",
		);
	if (g.pr && (g.pr.state === "open" || g.pr.state === "draft"))
		return { pr: g.pr, created: false };
	if (!g.upstream || g.ahead > 0) throw refuse("Push the branch first.");
	const n = String(nextPr++);
	g.pr = {
		...prOf(a, n, g.branch),
		title:
			typeof p.title === "string" && p.title ? p.title : `Work on ${g.branch}`,
		state: p.draft ? "draft" : "open",
	};
	g.checks = [{ name: "test", state: "pending", url: null, workflow: "CI" }];
	g.review = "review_required";
	g.comments = [];
	return { pr: g.pr, created: true };
}

/** `/__mock/git`: `{ agent: name, set?: Partial<MockGit>, fail?: { op, code, message } }`. */
export function gitControl(
	a: MockAgent,
	body: { set?: Partial<MockGit>; fail?: MockGit["fail"] },
) {
	const g = gitOf(a);
	if (body.set) Object.assign(g, body.set);
	if (body.fail) g.fail = body.fail;
	return { ok: true };
}
