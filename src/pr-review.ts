import {
	checkOf,
	forgetPr,
	GH_TIMEOUT_MS,
	ghFailure,
	httpsUrl,
	PR_FIELDS,
	type PrRepos,
	prRepos,
	pushRemote,
	type RawCheck,
	type RawPr,
	reader,
	toPr,
} from "./git-actions.ts";
import { type GitResult, runGh } from "./git-write.ts";
import type {
	GitCommentParams,
	GitPrReview,
	GitReplyParams,
	GitResolveParams,
	GitReviewComment,
	GitReviewFile,
	GitReviewParams,
	GitReviewPatch,
	GitReviewThread,
} from "./http/wire.ts";
import { RpcError } from "./rpc.ts";

/**
 * Reviewing an agent's PR from the app: the PR's description, its files
 * and patches as GitHub has them at the PR's head (comments anchor there,
 * not to the worktree), review threads with their resolved state (GraphQL
 * only), checks and reviews; and the writes: a line comment, a reply, a
 * resolve, a review. Everything runs through `gh` on the foundation runner
 * (argv only, no stdin, no prompt). Operator text travels as `-f` raw
 * fields only (`-F` reads `@file` and coerces types); `-F` carries only
 * integers checked here. src/service/pr-review.ts wires these to routes
 * and acting ops.
 */

const REVIEW_TTL_MS = 15_000;
const FILE_PAGES = 3;
const PAGE = 100;
const MAX_PATCH = 512 * 1024;
const MAX_BODY_CHARS = 20_000;
const MAX_REVIEWS = 50;
/** Head commits whose patches stay in memory (a few PRs open at once). */
const PATCH_SETS = 8;

/** GitHub's node ids: `PRRT_kwDO…`. */
export const NODE_ID = /^[A-Za-z0-9_=-]{1,200}$/;
export const SHA = /^[0-9a-f]{40}$/;

const clip = (s: unknown, max = MAX_BODY_CHARS) =>
	String(s ?? "").slice(0, max);

interface Located {
	cwd: string;
	root: string;
	repos: PrRepos;
}

type Patches = Map<string, { patch: string | null; tooLarge: boolean }>;

const reviewCache = new Map<
	string,
	{ at: number; review: Omit<GitPrReview, "agent"> }
>();
/** Patches by `<key>\0<head sha>`, oldest first. */
const patchCache = new Map<string, Patches>();

const keyOf = (l: Located) => `${l.root}\0${l.repos.base}\0${l.repos.headRef}`;

/** Forget cached review reads for a worktree, and the PR card's (after a write). */
export function forgetReview(root: string) {
	for (const m of [reviewCache, patchCache])
		for (const k of m.keys()) if (k.startsWith(`${root}\0`)) m.delete(k);
	forgetPr(root);
}

/** The worktree's branch and the repos its PR involves; null without them. */
async function locate(cwd: string | null): Promise<Located | null> {
	if (!cwd) return null;
	const read = reader(cwd);
	const head = await read(["symbolic-ref", "-q", "--short", "HEAD"]);
	if (!head.ok) return null;
	const branch = head.stdout.trim();
	if (!branch) return null;
	const repos = await prRepos(read, await pushRemote(read, branch), branch);
	return repos ? { cwd, root: head.root, repos } : null;
}

function ghReason(r: Extract<GitResult, { ok: false }>) {
	const f = ghFailure(r);
	if (f === "none") return null;
	return f === "missing"
		? "gh_missing"
		: f === "logged_out"
			? "gh_logged_out"
			: "gh_error";
}

const gh = (cwd: string, args: string[], write = false) =>
	runGh(cwd, args, {
		...(write ? {} : { mode: "read" as const }),
		timeoutMs: GH_TIMEOUT_MS,
	});

function json<T>(r: GitResult): T | null {
	if (!r.ok) return null;
	try {
		return JSON.parse(r.stdout) as T;
	} catch {
		return null;
	}
}

const THREADS_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){viewerDidAuthor reviewThreads(first:100){nodes{id isResolved isOutdated viewerCanResolve viewerCanUnresolve viewerCanReply path line startLine originalLine diffSide comments(first:50){nodes{databaseId author{login} body createdAt url}}}}}}}`;

interface RawThread {
	id?: string;
	isResolved?: boolean;
	isOutdated?: boolean;
	viewerCanResolve?: boolean;
	viewerCanUnresolve?: boolean;
	viewerCanReply?: boolean;
	path?: string;
	line?: number | null;
	startLine?: number | null;
	originalLine?: number | null;
	diffSide?: string;
	comments?: {
		nodes?: {
			databaseId?: number;
			author?: { login?: string } | null;
			body?: string;
			createdAt?: string;
			url?: string;
		}[];
	};
}

const num = (v: unknown) =>
	Number.isInteger(v) && Number(v) > 0 ? Number(v) : null;

export function threadOf(t: RawThread): GitReviewThread | null {
	if (!t.id || !NODE_ID.test(t.id) || !t.path) return null;
	const resolved = !!t.isResolved;
	return {
		id: t.id,
		path: String(t.path),
		line: num(t.line),
		startLine: num(t.startLine),
		originalLine: num(t.originalLine),
		side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
		outdated: !!t.isOutdated,
		resolved,
		canResolve: resolved ? !!t.viewerCanUnresolve : !!t.viewerCanResolve,
		canReply: !!t.viewerCanReply,
		comments: (t.comments?.nodes ?? []).map((c) => ({
			id: Number(c.databaseId) || 0,
			author: String(c.author?.login ?? "someone"),
			body: clip(c.body),
			at: c.createdAt ?? null,
			url: httpsUrl(c.url),
		})),
	};
}

interface RawFile {
	filename?: string;
	previous_filename?: string;
	status?: string;
	additions?: number;
	deletions?: number;
	changes?: number;
	patch?: string;
}

export function fileOf(f: RawFile): {
	file: GitReviewFile;
	patch: string | null;
} | null {
	if (!f.filename) return null;
	const s = String(f.status);
	const patch = typeof f.patch === "string" ? f.patch : null;
	const big = patch !== null && patch.length > MAX_PATCH;
	// No patch: GitHub left it out (too large) when lines changed; else a
	// binary or empty file, or a pure rename (GitHub doesn't say which).
	const noPatch = patch === null;
	const counted = Number(f.changes ?? 0) > 0;
	return {
		file: {
			path: String(f.filename),
			oldPath: f.previous_filename ? String(f.previous_filename) : null,
			status:
				s === "added"
					? "added"
					: s === "removed"
						? "removed"
						: s === "renamed"
							? "renamed"
							: "modified",
			added: Number(f.additions) || 0,
			removed: Number(f.deletions) || 0,
			binary: false,
			tooLarge: big || (noPatch && counted),
		},
		patch: big ? null : patch,
	};
}

function reviewsOf(
	raw: {
		author?: { login?: string };
		body?: string;
		state?: string;
		submittedAt?: string;
	}[],
): GitReviewComment[] {
	const out: GitReviewComment[] = [];
	for (const rv of raw) {
		const s = String(rv.state ?? "").toUpperCase();
		if (!rv.body?.trim() && s !== "CHANGES_REQUESTED" && s !== "APPROVED")
			continue;
		out.push({
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
	return out.slice(-MAX_REVIEWS);
}

const empty = (
	agent: string,
	reason?: GitPrReview["reason"],
	message?: string,
): GitPrReview => ({
	agent,
	pr: null,
	...(reason ? { reason } : {}),
	...(message ? { message } : {}),
	head: null,
	body: "",
	author: null,
	ownPr: false,
	checks: [],
	review: null,
	reviews: [],
	files: [],
	truncated: false,
	threads: [],
});

/** The branch's PR for review (cached briefly; `fresh` reads again). */
export async function prReview(
	agent: string,
	cwd: string | null,
	fresh = false,
): Promise<GitPrReview> {
	const at = await locate(cwd);
	if (!at) return empty(agent, cwd ? undefined : "no_github");
	const key = keyOf(at);
	const hit = reviewCache.get(key);
	if (!fresh && hit && Date.now() - hit.at < REVIEW_TTL_MS)
		return { agent, ...hit.review };
	const { repos } = at;
	const view = await gh(at.cwd, [
		"pr",
		"view",
		repos.headRef,
		"--repo",
		repos.base,
		"--json",
		`${PR_FIELDS},body,headRefOid,author,reviewDecision,statusCheckRollup,reviews,changedFiles`,
	]);
	if (!view.ok) {
		const reason = ghReason(view);
		return reason ? empty(agent, reason, view.message) : empty(agent);
	}
	const raw = json<
		RawPr & {
			body?: string;
			headRefOid?: string;
			author?: { login?: string };
			reviewDecision?: string;
			statusCheckRollup?: RawCheck[];
			reviews?: Parameters<typeof reviewsOf>[0];
			changedFiles?: number;
		}
	>(view);
	if (!raw) return empty(agent, "gh_error", "gh sent something unreadable");
	const pr = toPr(raw);
	const head =
		typeof raw.headRefOid === "string" && SHA.test(raw.headRefOid)
			? raw.headRefOid
			: null;
	const [owner, name] = repos.base.split("/") as [string, string];
	const [threadsRes, filesRes] = await Promise.all([
		gh(at.cwd, [
			"api",
			"graphql",
			"-f",
			`query=${THREADS_QUERY}`,
			"-f",
			`owner=${owner}`,
			"-f",
			`name=${name}`,
			"-F",
			`number=${pr.number}`,
		]),
		readFiles(at, pr.number),
	]);
	const g = json<{
		data?: {
			repository?: {
				pullRequest?: {
					viewerDidAuthor?: boolean;
					reviewThreads?: { nodes?: RawThread[] };
				};
			};
		};
	}>(threadsRes)?.data?.repository?.pullRequest;
	const threads = (g?.reviewThreads?.nodes ?? [])
		.map(threadOf)
		.filter((t): t is GitReviewThread => !!t);
	const d = String(raw.reviewDecision ?? "").toUpperCase();
	const review: Omit<GitPrReview, "agent"> = {
		pr,
		head,
		body: clip(raw.body, 60_000),
		author: raw.author?.login ? String(raw.author.login) : null,
		ownPr: !!g?.viewerDidAuthor,
		checks: (raw.statusCheckRollup ?? []).map(checkOf),
		review:
			d === "APPROVED"
				? "approved"
				: d === "CHANGES_REQUESTED"
					? "changes_requested"
					: d === "REVIEW_REQUIRED"
						? "review_required"
						: null,
		reviews: reviewsOf(raw.reviews ?? []),
		files: filesRes.files,
		truncated:
			filesRes.more || Number(raw.changedFiles ?? 0) > filesRes.files.length,
		threads,
		...(!threadsRes.ok
			? { message: `Couldn't read review threads: ${threadsRes.message}` }
			: !filesRes.ok
				? { message: "Couldn't read the PR's files." }
				: {}),
	};
	if (head && filesRes.ok) {
		const pk = `${key}\0${head}`;
		patchCache.delete(pk);
		patchCache.set(pk, filesRes.patches);
		while (patchCache.size > PATCH_SETS)
			patchCache.delete(patchCache.keys().next().value!);
	}
	reviewCache.set(key, { at: Date.now(), review });
	return { agent, ...review };
}

async function readFiles(at: Located, number: number) {
	const files: GitReviewFile[] = [];
	const patches: Patches = new Map();
	for (let page = 1; page <= FILE_PAGES; page++) {
		const r = await gh(at.cwd, [
			"api",
			"-X",
			"GET",
			`repos/${at.repos.base}/pulls/${number}/files`,
			"-f",
			`per_page=${PAGE}`,
			"-f",
			`page=${page}`,
		]);
		const list = json<RawFile[]>(r);
		if (!Array.isArray(list)) return { ok: false, files, patches, more: false };
		for (const raw of list) {
			const f = fileOf(raw);
			if (!f) continue;
			files.push(f.file);
			patches.set(f.file.path, { patch: f.patch, tooLarge: f.file.tooLarge });
		}
		if (list.length < PAGE) return { ok: true, files, patches, more: false };
	}
	return { ok: true, files, patches, more: true };
}

/** One listed file's patch at the PR's head; only paths the review lists. */
export async function prReviewFile(
	agent: string,
	cwd: string | null,
	path: string,
): Promise<GitReviewPatch> {
	const at = await locate(cwd);
	if (!at) throw new RpcError("not_found", "this branch has no PR");
	const key = keyOf(at);
	let r = reviewCache.get(key)?.review;
	let set = r?.head ? patchCache.get(`${key}\0${r.head}`) : undefined;
	if (!set) {
		r = await prReview(agent, cwd, true);
		set = r.head ? patchCache.get(`${key}\0${r.head}`) : undefined;
	}
	const file = r?.files.find((f) => f.path === path);
	if (!file || !set) throw new RpcError("not_found", "the PR has no such file");
	const p = set.get(path);
	return {
		agent,
		path,
		patch: p?.patch ?? null,
		binary: file.binary,
		tooLarge: file.tooLarge,
	};
}

// ------------------------------------------------------------------ writes

function refuse(message: string): never {
	throw new RpcError("git_refused", message);
}

function failed(r: Extract<GitResult, { ok: false }>, what: string): never {
	const reason = ghReason(r);
	if (reason === "gh_missing")
		refuse("gh is not installed on the agent's machine.");
	if (reason === "gh_logged_out")
		refuse("gh is not logged in on the agent's machine. Run gh auth login.");
	throw new RpcError(
		"git_failed",
		(r.message || `${what} failed`).slice(0, 500),
	);
}

/** The branch's PR now: it must still be the one the operator reviewed. */
async function current(
	cwd: string | null,
	number: number,
): Promise<Located & { head: string | null }> {
	const at = await locate(cwd);
	if (!at) refuse("This branch has no PR on GitHub.");
	const r = await gh(at.cwd, [
		"pr",
		"view",
		at.repos.headRef,
		"--repo",
		at.repos.base,
		"--json",
		"number,headRefOid,state",
	]);
	if (!r.ok) {
		if (ghFailure(r) === "none") refuse("This branch has no PR any more.");
		failed(r, "gh pr view");
	}
	const pr = json<{ number?: number; headRefOid?: string }>(r);
	if (!pr) throw new RpcError("git_failed", "gh sent something unreadable");
	if (Number(pr.number) !== number) {
		// The reload that follows must read the PR as it is now.
		forgetReview(at.root);
		refuse("The branch's PR changed. Reload and try again.");
	}
	return { ...at, head: pr.headRefOid ?? null };
}

/** A thread id names a thread of this PR (not one elsewhere the account sees). */
async function ownThread(at: Located, number: number, thread: string) {
	const r = await gh(at.cwd, [
		"api",
		"graphql",
		"-f",
		"query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{pullRequest{number repository{nameWithOwner}}}}}",
		"-f",
		`id=${thread}`,
	]);
	if (!r.ok) failed(r, "gh api graphql");
	const pr = json<{
		data?: {
			node?: {
				pullRequest?: {
					number?: number;
					repository?: { nameWithOwner?: string };
				};
			} | null;
		};
	}>(r)?.data?.node?.pullRequest;
	if (
		!pr ||
		Number(pr.number) !== number ||
		String(pr.repository?.nameWithOwner ?? "").toLowerCase() !==
			at.repos.base.toLowerCase()
	)
		refuse("That thread is not on this PR.");
}

export async function addComment(
	cwd: string | null,
	p: GitCommentParams,
): Promise<{ ok: true }> {
	const at = await current(cwd, p.number);
	if (at.head !== p.head) {
		forgetReview(at.root);
		refuse("The PR has new commits. Reload to comment on the latest code.");
	}
	const r = await gh(
		at.cwd,
		[
			"api",
			"-X",
			"POST",
			`repos/${at.repos.base}/pulls/${p.number}/comments`,
			"-f",
			`body=${p.body}`,
			"-f",
			`commit_id=${p.head}`,
			"-f",
			`path=${p.path}`,
			"-F",
			`line=${p.line}`,
			"-f",
			`side=${p.side}`,
		],
		true,
	);
	if (!r.ok) failed(r, "gh api");
	forgetReview(at.root);
	return { ok: true };
}

export async function replyThread(
	cwd: string | null,
	p: GitReplyParams,
): Promise<{ ok: true }> {
	const at = await current(cwd, p.number);
	await ownThread(at, p.number, p.thread);
	const r = await gh(
		at.cwd,
		[
			"api",
			"graphql",
			"-f",
			"query=mutation($thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$thread,body:$body}){comment{id}}}",
			"-f",
			`thread=${p.thread}`,
			"-f",
			`body=${p.body}`,
		],
		true,
	);
	if (!r.ok) failed(r, "gh api graphql");
	forgetReview(at.root);
	return { ok: true };
}

export async function resolveThread(
	cwd: string | null,
	p: GitResolveParams,
): Promise<{ ok: true; resolved: boolean }> {
	const at = await current(cwd, p.number);
	await ownThread(at, p.number, p.thread);
	const m = p.resolved ? "resolveReviewThread" : "unresolveReviewThread";
	const r = await gh(
		at.cwd,
		[
			"api",
			"graphql",
			"-f",
			`query=mutation($thread:ID!){${m}(input:{threadId:$thread}){thread{id isResolved}}}`,
			"-f",
			`thread=${p.thread}`,
		],
		true,
	);
	if (!r.ok) failed(r, "gh api graphql");
	forgetReview(at.root);
	return { ok: true, resolved: p.resolved };
}

const EVENT_FLAG: Record<GitReviewParams["event"], string> = {
	comment: "--comment",
	approve: "--approve",
	request_changes: "--request-changes",
};

export async function submitReview(
	cwd: string | null,
	p: GitReviewParams,
): Promise<{ ok: true }> {
	const at = await current(cwd, p.number);
	const r = await gh(
		at.cwd,
		[
			"pr",
			"review",
			String(p.number),
			"--repo",
			at.repos.base,
			EVENT_FLAG[p.event],
			// One argv word: a body that starts with "-" stays the body.
			`--body=${p.body}`,
		],
		true,
	);
	if (!r.ok) failed(r, "gh pr review");
	forgetReview(at.root);
	return { ok: true };
}
