import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { readChanges } from "./changes/read.ts";
import { type GitResult, runGh, runGit } from "./git-write.ts";
import type {
	GitCheck,
	GitCommitResult,
	GitPr,
	GitPrDetails,
	GitPushResult,
	GitReviewComment,
	GitStatus,
} from "./http/wire.ts";
import { githubSlug } from "./prs.ts";
import { RpcError } from "./rpc.ts";

/**
 * Commit, push and PR in an agent's worktree, for the operator (the app's
 * git actions; src/service/git.ts wires them to acting ops and routes).
 * Everything runs through the foundation runner (src/git-write.ts): argv
 * only, no prompts, hooks with a timeout. Reads use `mode: "read"`, so they
 * never take a lock next to a working agent.
 */

const COMMIT_TIMEOUT_MS = 120_000;
const PUSH_TIMEOUT_MS = 150_000;
const GH_TIMEOUT_MS = 30_000;
/** A PR lookup is kept this long (status polls must not hit GitHub each time). */
const PR_TTL_MS = 60_000;
const DETAILS_TTL_MS = 15_000;
/** How long a status read waits for gh before it answers from the cache. */
const PR_WAIT_MS = 3000;
const MAX_COMMENTS = 50;
const MAX_COMMENT_CHARS = 4000;

type Read = (args: string[]) => Promise<GitResult>;

const reader =
	(cwd: string): Read =>
	(args) =>
		runGit(cwd, args, { mode: "read" });

function unavailable(
	agent: string,
	reason: NonNullable<GitStatus["reason"]>,
): GitStatus {
	return {
		agent,
		available: false,
		reason,
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
}

/** What `git status --porcelain=v2 --branch` says, plus the files it counts. */
interface Porcelain {
	/** `# branch.ab` was there: the upstream's branch exists. */
	ab: boolean;
	branch: string | null;
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	dirty: number;
	conflicted: number;
}

export function parsePorcelain(out: string): Porcelain {
	const p: Porcelain = {
		ab: false,
		branch: null,
		head: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		dirty: 0,
		conflicted: 0,
	};
	const recs = out.split("\0");
	for (let i = 0; i < recs.length; i++) {
		const r = recs[i]!;
		if (!r) continue;
		if (r.startsWith("# branch.oid ")) {
			const oid = r.slice(13);
			p.head = oid === "(initial)" ? null : oid.slice(0, 7);
		} else if (r.startsWith("# branch.head ")) {
			const h = r.slice(14);
			p.branch = h === "(detached)" ? null : h;
		} else if (r.startsWith("# branch.upstream ")) p.upstream = r.slice(18);
		else if (r.startsWith("# branch.ab ")) {
			const m = /^\+(\d+) -(\d+)$/.exec(r.slice(12));
			p.ab = true;
			if (m) {
				p.ahead = Number(m[1]);
				p.behind = Number(m[2]);
			}
		} else if (r.startsWith("#")) continue;
		else {
			p.dirty++;
			if (r.startsWith("u ")) p.conflicted++;
			// A rename's record is followed by its source path.
			if (r.startsWith("2 ")) i++;
		}
	}
	return p;
}

/** One `git config --get` value, or null. */
async function config(read: Read, key: string): Promise<string | null> {
	const r = await read(["config", "--get", key]);
	return r.ok ? r.stdout.trim() || null : null;
}

/**
 * The remote a push of `branch` goes to: its pushRemote, remote.pushDefault,
 * its upstream's remote, `origin`, else the only remote. Null without one.
 */
async function pushRemote(
	read: Read,
	branch: string | null,
): Promise<string | null> {
	const list = await read(["remote"]);
	const remotes = list.ok
		? list.stdout
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean)
		: [];
	if (remotes.length === 0) return null;
	const pick = [
		branch ? await config(read, `branch.${branch}.pushRemote`) : null,
		await config(read, "remote.pushDefault"),
		branch ? await config(read, `branch.${branch}.remote`) : null,
	].find((r) => r && remotes.includes(r));
	if (pick) return pick;
	if (remotes.includes("origin")) return "origin";
	return remotes.length === 1 ? remotes[0]! : null;
}

/** The default branch: the remote's HEAD, else main / master that exist. */
async function defaultBranch(
	read: Read,
	remote: string | null,
): Promise<string | null> {
	if (remote) {
		const head = await read([
			"symbolic-ref",
			"-q",
			"--short",
			`refs/remotes/${remote}/HEAD`,
		]);
		const ref = head.ok ? head.stdout.trim() : "";
		if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
	}
	const refs = await read([
		"for-each-ref",
		"--format=%(refname)",
		...(remote
			? [`refs/remotes/${remote}/main`, `refs/remotes/${remote}/master`]
			: []),
		"refs/heads/main",
		"refs/heads/master",
	]);
	const names = refs.ok ? refs.stdout.split("\n") : [];
	if (names.some((n) => /\/main$/.test(n))) return "main";
	if (names.some((n) => /\/master$/.test(n))) return "master";
	return null;
}

/** A merge, rebase, cherry-pick or revert in progress (its marker in the git dir). */
async function operation(read: Read): Promise<GitStatus["operation"]> {
	const r = await read([
		"rev-parse",
		"--git-path",
		"MERGE_HEAD",
		"--git-path",
		"rebase-merge",
		"--git-path",
		"rebase-apply",
		"--git-path",
		"CHERRY_PICK_HEAD",
		"--git-path",
		"REVERT_HEAD",
	]);
	if (!r.ok) return null;
	const [merge, rm, ra, pick, revert] = r.stdout.split("\n");
	const at = async (p: string | undefined) => {
		if (!p) return false;
		const abs = isAbsolute(p) ? p : join(r.root, p);
		return access(abs).then(
			() => true,
			() => false,
		);
	};
	if (await at(merge)) return "merge";
	if ((await at(rm)) || (await at(ra))) return "rebase";
	if (await at(pick)) return "cherry-pick";
	if (await at(revert)) return "revert";
	return null;
}

/** The repos a PR involves: where it is opened (base) and where the branch lives (head). */
interface PrRepos {
	base: string;
	head: string;
	/** `gh`'s head selector: the branch, or `owner:branch` from a fork. */
	headRef: string;
}

async function prRepos(
	read: Read,
	remote: string | null,
	branch: string,
): Promise<PrRepos | null> {
	if (!remote) return null;
	const url = async (name: string) => {
		const r = await read(["remote", "get-url", name]);
		return r.ok ? r.stdout.trim() : null;
	};
	const head = githubSlug(await url(remote));
	if (!head) return null;
	// A fork's PRs go to `upstream` when it is a GitHub repo.
	const up = remote === "upstream" ? null : githubSlug(await url("upstream"));
	const base = up ?? head;
	const headRef = base === head ? branch : `${head.split("/")[0]}:${branch}`;
	return { base, head, headRef };
}

// ------------------------------------------------------------------ gh

type GhState = NonNullable<GitStatus["gh"]>;

/** How a failed `gh` reads: not installed, logged out, no PR, or another error. */
function ghFailure(r: Extract<GitResult, { ok: false }>): GhState | "none" {
	if (r.code === "spawn") return "missing";
	const text = `${r.stderr}\n${r.message}`;
	if (/no (open )?pull requests? found/i.test(text)) return "none";
	if (/gh auth login|not logged in|authentication|GH_TOKEN|401/i.test(text))
		return "logged_out";
	return "error";
}

interface RawPr {
	number: number;
	url: string;
	title: string;
	state: string;
	isDraft?: boolean;
	baseRefName: string;
	headRefName: string;
}

const PR_FIELDS = "number,url,title,state,isDraft,baseRefName,headRefName";

/** A link from GitHub's data, only when it is https (the app opens it). */
export const httpsUrl = (u: unknown): string | null =>
	typeof u === "string" && /^https:\/\/[^\s]+$/.test(u) ? u : null;

function toPr(raw: RawPr): GitPr {
	const s = String(raw.state).toUpperCase();
	return {
		number: Number(raw.number),
		url: httpsUrl(raw.url) ?? "",
		title: String(raw.title ?? ""),
		state:
			s === "MERGED"
				? "merged"
				: s === "CLOSED"
					? "closed"
					: raw.isDraft
						? "draft"
						: "open",
		base: String(raw.baseRefName ?? ""),
		head: String(raw.headRefName ?? ""),
	};
}

const prCache = new Map<
	string,
	{ at: number; gh: GhState; pr: GitPr | null }
>();
const detailsCache = new Map<
	string,
	{ at: number; details: Omit<GitPrDetails, "agent"> }
>();

/** Forget cached PR reads for a worktree (after a push or a new PR). */
export function forgetPr(root: string) {
	for (const m of [prCache, detailsCache])
		for (const k of m.keys()) if (k.startsWith(`${root}\0`)) m.delete(k);
}

const prKey = (root: string, repos: PrRepos) =>
	`${root}\0${repos.base}\0${repos.headRef}`;

async function lookupPr(
	cwd: string,
	root: string,
	repos: PrRepos,
	fresh = false,
): Promise<{ gh: GhState; pr: GitPr | null }> {
	const key = prKey(root, repos);
	const hit = prCache.get(key);
	if (!fresh && hit && Date.now() - hit.at < PR_TTL_MS) return hit;
	const r = await runGh(
		cwd,
		["pr", "view", repos.headRef, "--repo", repos.base, "--json", PR_FIELDS],
		{ mode: "read", timeoutMs: GH_TIMEOUT_MS },
	);
	let out: { gh: GhState; pr: GitPr | null };
	if (r.ok) {
		try {
			out = { gh: "ok", pr: toPr(JSON.parse(r.stdout) as RawPr) };
		} catch {
			out = { gh: "error", pr: null };
		}
	} else {
		const f = ghFailure(r);
		out = f === "none" ? { gh: "ok", pr: null } : { gh: f, pr: null };
	}
	prCache.set(key, { at: Date.now(), ...out });
	return out;
}

// -------------------------------------------------------------- status

/** Everything the git actions need about the worktree holding `cwd`. */
export async function gitStatus(
	agent: string,
	cwd: string | null,
	opts: { pr?: boolean } = {},
): Promise<GitStatus> {
	if (!cwd) return unavailable(agent, "no_cwd");
	const read = reader(cwd);
	const st = await read([
		"status",
		"--porcelain=v2",
		"--branch",
		"-z",
		"--untracked-files=normal",
		"--ignore-submodules=dirty",
	]);
	if (!st.ok)
		return unavailable(
			agent,
			st.code === "not_a_worktree" ? "not_a_repo" : "git_failed",
		);
	const p = parsePorcelain(st.stdout);
	const remote = await pushRemote(read, p.branch);
	const [def, op, repos] = await Promise.all([
		defaultBranch(read, remote),
		operation(read),
		p.branch ? prRepos(read, remote, p.branch) : Promise.resolve(null),
	]);
	// A push goes to the same-named branch on the push remote, never to an
	// upstream with another name (`checkout -b feat origin/main` tracks main).
	const pushTo = remote && p.branch ? `${remote}/${p.branch}` : null;
	const tracking = !!pushTo && p.upstream === pushTo && p.ab;
	const status: GitStatus = {
		agent,
		available: true,
		root: st.root,
		branch: p.branch,
		head: p.head,
		defaultBranch: def,
		onDefault: !!p.branch && p.branch === def,
		remote,
		upstream: p.upstream,
		pushTo,
		upstreamGone: !!p.upstream && !p.ab,
		// Counts only against the branch a push goes to (see pushTo).
		ahead: tracking ? p.ahead : 0,
		behind: tracking ? p.behind : 0,
		dirty: p.dirty,
		conflicted: p.conflicted,
		operation: op,
		github: !!repos,
		gh: null,
		pr: null,
	};
	if (repos && opts.pr !== false && !status.onDefault) {
		// GitHub may be slow: wait a little, else answer from the last lookup
		// (the one running fills the cache for the next poll).
		const lookup = lookupPr(cwd, st.root, repos);
		const r = await Promise.race([
			lookup,
			new Promise<null>((ok) => setTimeout(ok, PR_WAIT_MS, null).unref?.()),
		]);
		const got = r ?? prCache.get(prKey(st.root, repos)) ?? null;
		status.gh = got?.gh ?? null;
		status.pr = got?.pr ?? null;
	}
	return status;
}

// ----------------------------------------------------------------- PR details

interface RawCheck {
	__typename?: string;
	name?: string;
	context?: string;
	status?: string;
	conclusion?: string | null;
	state?: string;
	detailsUrl?: string | null;
	targetUrl?: string | null;
	workflowName?: string | null;
}

export function checkOf(c: RawCheck): GitCheck {
	const name = String(c.name ?? c.context ?? "check");
	const url = httpsUrl(c.detailsUrl ?? c.targetUrl);
	const workflow = c.workflowName || null;
	let state: GitCheck["state"];
	if (c.__typename === "StatusContext" || (c.state && !c.status)) {
		const s = String(c.state).toUpperCase();
		state =
			s === "SUCCESS"
				? "pass"
				: s === "FAILURE" || s === "ERROR"
					? "fail"
					: "pending";
	} else if (String(c.status).toUpperCase() !== "COMPLETED") state = "pending";
	else {
		const k = String(c.conclusion ?? "").toUpperCase();
		state =
			k === "SUCCESS"
				? "pass"
				: k === "SKIPPED" || k === "NEUTRAL"
					? "skipped"
					: "fail";
	}
	return { name, state, url, workflow };
}

const clip = (s: unknown) => String(s ?? "").slice(0, MAX_COMMENT_CHARS);

/** The branch's PR with its checks, review verdict and review comments. */
export async function prDetails(
	agent: string,
	cwd: string | null,
): Promise<GitPrDetails> {
	const empty = (
		reason?: GitPrDetails["reason"],
		message?: string,
	): GitPrDetails => ({
		agent,
		pr: null,
		...(reason ? { reason } : {}),
		...(message ? { message } : {}),
		checks: [],
		review: null,
		comments: [],
	});
	if (!cwd) return empty("no_github");
	const read = reader(cwd);
	const head = await read(["symbolic-ref", "-q", "--short", "HEAD"]);
	if (!head.ok) return empty();
	const branch = head.stdout.trim();
	if (!branch) return empty();
	const repos = await prRepos(read, await pushRemote(read, branch), branch);
	if (!repos) return empty("no_github");
	const key = `${head.root}\0${repos.base}\0${repos.headRef}`;
	const hit = detailsCache.get(key);
	if (hit && Date.now() - hit.at < DETAILS_TTL_MS)
		return { agent, ...hit.details };
	const r = await runGh(
		cwd,
		[
			"pr",
			"view",
			repos.headRef,
			"--repo",
			repos.base,
			"--json",
			`${PR_FIELDS},reviewDecision,statusCheckRollup,reviews`,
		],
		{ mode: "read", timeoutMs: GH_TIMEOUT_MS },
	);
	if (!r.ok) {
		const f = ghFailure(r);
		if (f === "none") return empty();
		return empty(
			f === "missing"
				? "gh_missing"
				: f === "logged_out"
					? "gh_logged_out"
					: "gh_error",
			r.message,
		);
	}
	let raw: RawPr & {
		reviewDecision?: string;
		statusCheckRollup?: RawCheck[];
		reviews?: {
			author?: { login?: string };
			body?: string;
			state?: string;
			submittedAt?: string;
		}[];
	};
	try {
		raw = JSON.parse(r.stdout);
	} catch {
		return empty("gh_error", "gh sent something unreadable");
	}
	const pr = toPr(raw);
	const d = String(raw.reviewDecision ?? "").toUpperCase();
	const comments: GitReviewComment[] = [];
	for (const rv of raw.reviews ?? []) {
		const s = String(rv.state ?? "").toUpperCase();
		if (!rv.body?.trim() && s !== "CHANGES_REQUESTED") continue;
		comments.push({
			author: String(rv.author?.login ?? "someone"),
			body: clip(rv.body),
			path: null,
			line: null,
			verdict:
				s === "APPROVED"
					? "approved"
					: s === "CHANGES_REQUESTED"
						? "changes_requested"
						: "commented",
			url: null,
			at: rv.submittedAt ?? null,
		});
	}
	// Inline review comments (not in `gh pr view`'s fields).
	const inline = await runGh(
		cwd,
		[
			"api",
			"-X",
			"GET",
			`repos/${repos.base}/pulls/${pr.number}/comments`,
			"-f",
			"per_page=100",
		],
		{ mode: "read", timeoutMs: GH_TIMEOUT_MS },
	);
	if (inline.ok)
		try {
			const list = JSON.parse(inline.stdout) as {
				user?: { login?: string };
				body?: string;
				path?: string;
				line?: number | null;
				original_line?: number | null;
				html_url?: string;
				created_at?: string;
			}[];
			for (const c of list.slice(-MAX_COMMENTS))
				comments.push({
					author: String(c.user?.login ?? "someone"),
					body: clip(c.body),
					path: c.path ? String(c.path) : null,
					line: Number(c.line ?? c.original_line) || null,
					url: httpsUrl(c.html_url),
					at: c.created_at ?? null,
				});
		} catch {}
	const details: Omit<GitPrDetails, "agent"> = {
		pr,
		checks: (raw.statusCheckRollup ?? []).map(checkOf),
		review:
			d === "APPROVED"
				? "approved"
				: d === "CHANGES_REQUESTED"
					? "changes_requested"
					: d === "REVIEW_REQUIRED"
						? "review_required"
						: null,
		comments: comments.slice(-MAX_COMMENTS),
	};
	detailsCache.set(key, { at: Date.now(), details });
	return { agent, ...details };
}

// ----------------------------------------------------------------- acting

function fail(r: Extract<GitResult, { ok: false }>, what: string): never {
	if (r.code === "not_a_worktree")
		throw new RpcError("not_found", "the agent's folder is not a git worktree");
	throw new RpcError("git_failed", r.message || `${what} failed`);
}

function refuse(message: string): never {
	throw new RpcError("git_refused", message);
}

/** Guards every write shares: an operation in progress, conflicts. */
function writable(s: GitStatus) {
	if (!s.available)
		refuse(
			s.reason === "no_cwd"
				? "This agent has no folder."
				: "The agent's folder is not a git worktree.",
		);
	if (s.operation)
		refuse(
			`A ${s.operation} is in progress. Finish or abort it in the terminal first.`,
		);
	if (s.conflicted) refuse("Resolve the merge conflicts first.");
}

export async function commit(
	cwd: string | null,
	p: {
		files: string[];
		message: string;
		newBranch?: string;
		confirmDefault?: boolean;
	},
): Promise<GitCommitResult> {
	const s = await gitStatus("", cwd, { pr: false });
	writable(s);
	const dir = cwd as string;
	if (s.dirty === 0)
		refuse("Worktree is clean. Make changes before committing.");
	if (!p.newBranch && !s.branch)
		refuse("Detached HEAD: commit on a new branch.");
	if (!p.newBranch && s.onDefault && !p.confirmDefault)
		throw new RpcError(
			"confirm_default",
			`This commits on the default branch (${s.branch}).`,
		);
	// Only files the operator saw: what the worktree summary lists now.
	const { summary } = await readChanges(dir, "worktree", "user");
	const known = new Map<string, { staged: boolean; oldPath?: string }>();
	for (const f of summary.files) {
		known.set(f.path, {
			staged: f.staged,
			...(f.oldPath ? { oldPath: f.oldPath } : {}),
		});
		if (f.oldPath) known.set(f.oldPath, { staged: f.staged });
	}
	const paths = new Set<string>();
	for (const f of p.files) {
		const k = known.get(f);
		if (!k) throw new RpcError("not_found", `no change to ${f}`);
		paths.add(f);
		if (k.oldPath) paths.add(k.oldPath);
	}
	const list = [...paths];
	if (p.newBranch) {
		const ok = await runGit(
			dir,
			["check-ref-format", "--branch", p.newBranch],
			{
				mode: "read",
			},
		);
		if (!ok.ok) refuse(`"${p.newBranch}" is not a valid branch name.`);
		const sw = await runGit(dir, ["switch", "-c", p.newBranch]);
		if (!sw.ok) fail(sw, "creating the branch");
	}
	// A commit that fails leaves the worktree where it was: on its branch
	// (or detached HEAD), without the new branch, so a retry can create it.
	const undoBranch = async () => {
		if (!p.newBranch) return;
		const back = await runGit(dir, ["switch", "-q", "-"]);
		if (back.ok) await runGit(dir, ["branch", "-q", "-D", p.newBranch]);
	};
	// Stage exactly these paths, then commit only them: what the agent (or
	// anyone) staged for other files stays staged and out of this commit.
	// A staged rename's old path is in neither the index nor the worktree
	// any more: commit it, but don't `add` it (git would not match it).
	const add = await runGit(dir, ["add", "-A", "--", ...p.files]);
	if (!add.ok) {
		await undoBranch();
		fail(add, "staging");
	}
	const c = await runGit(
		dir,
		["commit", "-q", "--no-edit", "-m", p.message, "--", ...list],
		{ timeoutMs: COMMIT_TIMEOUT_MS },
	);
	if (!c.ok) {
		// Put back what was not staged before (a hook said no, a signing failure).
		const unstaged = list.filter((f) => known.get(f)?.staged === false);
		if (unstaged.length) await runGit(dir, ["reset", "-q", "--", ...unstaged]);
		await undoBranch();
		fail(c, "commit");
	}
	const head = await runGit(dir, ["log", "-1", "--format=%h%x00%s"], {
		mode: "read",
	});
	const [sha = "", subject = ""] = head.ok
		? head.stdout.trim().split("\0")
		: [];
	return {
		sha,
		branch: p.newBranch ?? s.branch,
		subject,
		files: p.files.length,
	};
}

/** The upstream is the push target and its branch exists. */
const isTracking = (s: GitStatus) =>
	!!s.pushTo && s.upstream === s.pushTo && !s.upstreamGone;

export async function push(
	cwd: string | null,
	p: { confirmDefault?: boolean },
): Promise<GitPushResult> {
	const s = await gitStatus("", cwd, { pr: false });
	writable(s);
	const dir = cwd as string;
	const branch = s.branch;
	if (!branch) refuse("Detached HEAD: check out a branch before pushing.");
	if (!s.head) refuse("There are no commits to push yet.");
	if (!s.remote || !s.pushTo) refuse("This repo has no remote to push to.");
	const remote = s.remote;
	// The branch tracks its push target: ahead/behind count against it.
	const tracking = isTracking(s);
	if (tracking && s.ahead > 0 && s.behind > 0)
		refuse("Branch has diverged from upstream. Rebase or merge first.");
	if (tracking && s.behind > 0)
		refuse("Branch is behind upstream. Pull or rebase before pushing.");
	if (tracking && s.ahead === 0)
		return { branch, remote, upstream: s.pushTo, pushed: false };
	// The target is the same-named branch: the default branch only when
	// this is it.
	if (s.onDefault && !p.confirmDefault)
		throw new RpcError(
			"confirm_default",
			`This pushes the default branch (${branch}).`,
		);
	// Never to an upstream with another name: to `<remote>/<branch>`, which
	// becomes the upstream (also when the old upstream's branch is gone).
	const target = `HEAD:refs/heads/${branch}`;
	const args = tracking
		? ["push", "--porcelain", remote, target]
		: ["push", "--porcelain", "--set-upstream", remote, target];
	const r = await runGit(dir, args, { timeoutMs: PUSH_TIMEOUT_MS });
	if (!r.ok) {
		if (r.code !== "failed") fail(r, "push");
		throw new RpcError("git_failed", pushError(r.stdout, r.stderr, r.message));
	}
	if (s.root) forgetPr(s.root);
	return {
		branch,
		remote,
		upstream: s.pushTo,
		pushed: true,
	};
}

/**
 * The useful part of a failed push: what the remote said and why the ref
 * was refused, or the credential problem, before git's generic last line.
 */
export function pushError(
	stdout: string,
	stderr: string,
	fallback: string,
): string {
	const err = stderr.split("\n").map((l) => l.trim());
	const auth = err.find((l) =>
		/permission denied|authentication failed|could not read username|terminal prompts disabled|host key verification failed|could not resolve host/i.test(
			l,
		),
	);
	if (auth) return auth.slice(0, 500);
	const remote = err
		.filter((l) => l.startsWith("remote:"))
		.map((l) => l.slice(7).trim())
		.filter((l) => l && !/^-+$/.test(l));
	// --porcelain: "!\t<from>:<to>\t[rejected] (non-fast-forward)".
	const refused = stdout
		.split("\n")
		.find((l) => l.startsWith("!"))
		?.split("\t")
		.at(-1)
		?.trim();
	const why = refused
		? (/\(([^)]+)\)\s*$/.exec(refused)?.[1] ?? refused.replace(/[[\]]/g, ""))
		: "";
	const said = remote.slice(-3).join(" ");
	const msg = said
		? `Push rejected: ${said}${why ? ` (${why})` : ""}`
		: why
			? `Push rejected (${why})`
			: fallback;
	return msg.slice(0, 500);
}

export async function createPr(
	cwd: string | null,
	p: { title?: string; body?: string; draft?: boolean },
): Promise<{ pr: GitPr; created: boolean }> {
	const s = await gitStatus("", cwd, { pr: false });
	if (!s.available) writable(s);
	const dir = cwd as string;
	const branch = s.branch;
	if (!branch) refuse("Detached HEAD: check out a branch first.");
	if (s.onDefault || !s.defaultBranch)
		refuse(
			s.onDefault
				? "You're on the default branch. Commit on a new branch first."
				: "No default branch found to open a PR against.",
		);
	const repos = await prRepos(reader(dir), s.remote, branch);
	if (!repos) refuse("PRs need a GitHub remote.");
	const existing = await lookupPr(dir, s.root!, repos, true);
	if (existing.gh === "missing")
		refuse("gh is not installed on the agent's machine.");
	if (existing.gh === "logged_out")
		refuse("gh is not logged in on the agent's machine. Run gh auth login.");
	if (existing.pr?.state === "open" || existing.pr?.state === "draft")
		return { pr: existing.pr, created: false };
	if (!isTracking(s) || s.ahead > 0) refuse("Push the branch first.");
	const args = [
		"pr",
		"create",
		"--repo",
		repos.base,
		"--head",
		repos.headRef,
		"--base",
		s.defaultBranch,
	];
	if (p.title?.trim()) args.push("--title", p.title, "--body", p.body ?? "");
	else args.push("--fill");
	if (p.draft) args.push("--draft");
	const r = await runGh(dir, args, { timeoutMs: GH_TIMEOUT_MS * 2 });
	if (!r.ok) fail(r, "gh pr create");
	forgetPr(s.root!);
	const after = await lookupPr(dir, s.root!, repos, true);
	if (after.pr) return { pr: after.pr, created: true };
	// gh printed the URL but the lookup lags: build the PR from the URL.
	const url = /https:\/\/\S+\/pull\/(\d+)/.exec(r.stdout);
	if (!url) throw new RpcError("git_failed", "gh created no PR");
	return {
		pr: {
			number: Number(url[1]),
			url: url[0],
			title: p.title ?? "",
			state: p.draft ? "draft" : "open",
			base: s.defaultBranch,
			head: branch,
		},
		created: true,
	};
}
