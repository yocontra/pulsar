import { runGh, runGit } from "./git-write.ts";
import type { IssueDetails, IssueInfo } from "./http/wire.ts";
import { githubSlug } from "./prs.ts";

/**
 * GitHub issue awareness: which issue an agent works on, from its branch
 * name, its PR's body, or the operator's first message, and the issue's
 * card from `gh issue view`. The detectors are pure; the gh reads are
 * async, bounded and cached.
 */

/** Issue numbers pulsar accepts: plain digits, at most 7. */
const NUM = /^\d{1,7}$/;

const asNumber = (s: string | undefined): number | null =>
	s && NUM.test(s) && Number(s) > 0 ? Number(s) : null;

/**
 * The issue a branch name points at: `fix-1378`, `issue-1378`, `issues/1378`,
 * `gh-12`, `bug/7-crash`, `1378-foo`, `me/1378-foo`. The number must be a
 * whole segment of 1 to 6 digits, so `pool-polish4`, `int2`, a date like
 * `x-20261114` or `2026-11-14-notes` do not count.
 */
export function issueFromBranch(
	branch: string | null | undefined,
): number | null {
	if (!branch || branch.length > 250) return null;
	const keyword =
		/(?:^|[/_-])(?:issues?|fix(?:es)?|bug|gh|closes?|resolves?)[-_/#]?(\d{1,6})(?=$|[/_.-])/i.exec(
			branch,
		);
	if (keyword) return asNumber(keyword[1]);
	// A leading number (optionally after one `owner/` folder), not a date.
	const lead = /^(?:[\w.-]+\/)?(\d{1,6})[-_](?!\d)/.exec(branch);
	return lead ? asNumber(lead[1]) : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Markdown without fenced and inline code (an example `#12` is not a reference). */
function prose(md: string): string {
	return md
		.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, " ")
		.replace(/`[^`\n]*`/g, " ");
}

/**
 * The first issue a PR body closes in its own repo: "Fixes #12",
 * "closes acme/demo#12", "Resolves https://github.com/acme/demo/issues/12".
 * References to other repos are skipped.
 */
export function issueFromPrBody(
	body: string | null | undefined,
	slug: string | null,
): number | null {
	if (!body) return null;
	const re =
		/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:([\w.-]+\/[\w.-]+)#(\d+)|#(\d+)|https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+))/gi;
	const text = prose(body.slice(0, 100_000));
	for (let m = re.exec(text); m; m = re.exec(text)) {
		const repo = (m[1] ?? m[4])?.toLowerCase();
		if (repo && repo !== slug) continue;
		const n = asNumber(m[2] ?? m[3] ?? m[5]);
		if (n) return n;
	}
	return null;
}

/**
 * The issue the operator's first message names: a link to an issue of the
 * agent's repo first, else the first `#1378` in prose. `skip` (the agent's
 * own PR) never counts.
 */
export function issueFromText(
	text: string | null | undefined,
	slug: string | null,
	skip?: number | null,
): number | null {
	if (!text) return null;
	const body = prose(text.slice(0, 20_000));
	if (slug) {
		const url = new RegExp(`github\\.com/${esc(slug)}/issues/(\\d+)`, "gi");
		for (let m = url.exec(body); m; m = url.exec(body)) {
			const n = asNumber(m[1]);
			if (n && n !== skip) return n;
		}
	}
	// Not inside a URL (`/pull/12#issuecomment`), a word or an HTML entity.
	const hash = /(^|[\s([,;:])#(\d{1,7})\b(?![\w-])/g;
	for (let m = hash.exec(body); m; m = hash.exec(body)) {
		const n = asNumber(m[2]);
		if (n && n !== skip) return n;
	}
	return null;
}

// ------------------------------------------------------------ git / gh

const GH_TIMEOUT_MS = 20_000;
/** An issue card stays this long (the app polls while it is open). */
export const ISSUE_TTL_MS = 60_000;
/** A PR's closing references stay this long (background detection). */
const PR_REFS_TTL_MS = 10 * 60_000;
/** Longest body excerpt the card carries. */
export const BODY_MAX = 4000;

/**
 * The GitHub repo a folder's issues live in: `upstream` when it is a GitHub
 * repo (a fork), else the remote the branch pushes to, else `origin`.
 */
export async function issueRepo(cwd: string): Promise<string | null> {
	const hit = repos.get(cwd);
	if (hit && Date.now() - hit.at < REPO_TTL_MS) return hit.slug;
	const slug = await readIssueRepo(cwd);
	repos.set(cwd, { at: Date.now(), slug });
	return slug;
}

/** Each folder's issue repo, re-read after `REPO_TTL_MS` (remotes rarely change). */
const repos = new Map<string, { at: number; slug: string | null }>();
const REPO_TTL_MS = 5 * 60_000;

async function readIssueRepo(cwd: string): Promise<string | null> {
	const read = async (args: string[]) => {
		const r = await runGit(cwd, args, {
			mode: "read",
			lane: "background",
			timeoutMs: 4000,
		});
		return r.ok ? r.stdout.trim() || null : null;
	};
	const up = githubSlug(await read(["remote", "get-url", "upstream"]));
	if (up) return up;
	const branch = await read(["symbolic-ref", "--short", "-q", "HEAD"]);
	const remote =
		(branch && (await read(["config", `branch.${branch}.pushRemote`]))) ||
		(branch && (await read(["config", `branch.${branch}.remote`]))) ||
		"origin";
	return githubSlug(await read(["remote", "get-url", remote]));
}

/** How a failed `gh issue view` reads. */
function issueFailure(r: {
	code: string;
	message: string;
	stderr: string;
}): NonNullable<IssueDetails["reason"]> {
	if (r.code === "spawn") return "gh_missing";
	const text = `${r.stderr}\n${r.message}`;
	if (/gh auth login|not logged in|authentication|GH_TOKEN|401/i.test(text))
		return "gh_logged_out";
	if (/could not resolve to an issue|not found|no issue/i.test(text))
		return "not_found";
	return "gh_error";
}

const httpsUrl = (u: unknown): string | null =>
	typeof u === "string" && /^https:\/\/[^\s]+$/.test(u) ? u : null;

const str = (v: unknown, max: number): string =>
	typeof v === "string" ? v.slice(0, max) : "";

/** The body cut to `BODY_MAX`, at a paragraph or line break when one is near. */
export function excerpt(body: string): { body: string; truncated: boolean } {
	if (body.length <= BODY_MAX) return { body, truncated: false };
	const cut = body.slice(0, BODY_MAX);
	const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf("\n"));
	return {
		body: at > BODY_MAX * 0.6 ? cut.slice(0, at) : cut,
		truncated: true,
	};
}

/** gh's JSON, kept to the card's fields, checked and bounded. */
export function toIssue(raw: Record<string, unknown>): IssueInfo {
	const state = String(raw.state ?? "").toUpperCase();
	const reason = String(raw.stateReason ?? "").toUpperCase();
	const labels = Array.isArray(raw.labels) ? raw.labels : [];
	const assignees = Array.isArray(raw.assignees) ? raw.assignees : [];
	const author = raw.author as { login?: unknown } | undefined;
	const { body, truncated } = excerpt(str(raw.body, 200_000));
	return {
		number: Number(raw.number),
		title: str(raw.title, 500),
		state: state === "CLOSED" ? "closed" : "open",
		stateReason:
			reason === "COMPLETED"
				? "completed"
				: reason === "NOT_PLANNED"
					? "not_planned"
					: null,
		url: httpsUrl(raw.url),
		labels: labels.slice(0, 20).map((l) => {
			const o = (l ?? {}) as { name?: unknown; color?: unknown };
			const color = str(o.color, 6);
			return {
				name: str(o.name, 100),
				color: /^[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : null,
			};
		}),
		assignees: assignees
			.slice(0, 20)
			.map((a) => str((a as { login?: unknown })?.login, 100))
			.filter(Boolean),
		author: str(author?.login, 100) || null,
		body,
		truncated,
		updatedAt: str(raw.updatedAt, 40) || null,
	};
}

const ISSUE_FIELDS =
	"number,title,state,stateReason,url,labels,assignees,author,body,updatedAt";

const cards = new Map<
	string,
	{ at: number; out: Pick<IssueDetails, "issue" | "reason" | "message"> }
>();

/**
 * One issue's card, read with `gh issue view` in the agent's folder against
 * its repo (`--repo`). Cached for `ISSUE_TTL_MS` per repo and number.
 */
export async function readIssue(
	cwd: string,
	n: number,
): Promise<Pick<IssueDetails, "issue" | "reason" | "message">> {
	if (!Number.isSafeInteger(n) || n <= 0 || !NUM.test(String(n)))
		return { issue: null, reason: "no_issue" };
	const repo = await issueRepo(cwd);
	if (!repo) return { issue: null, reason: "no_github" };
	const key = `${repo}#${n}`;
	const hit = cards.get(key);
	if (hit && Date.now() - hit.at < ISSUE_TTL_MS) return hit.out;
	const r = await runGh(
		cwd,
		["issue", "view", String(n), "--repo", repo, "--json", ISSUE_FIELDS],
		{ mode: "read", timeoutMs: GH_TIMEOUT_MS },
	);
	let out: Pick<IssueDetails, "issue" | "reason" | "message">;
	if (r.ok) {
		try {
			const issue = toIssue(JSON.parse(r.stdout) as Record<string, unknown>);
			// gh can answer a PR's number with the PR: that is not an issue.
			out = issue.url?.includes("/pull/")
				? {
						issue: null,
						reason: "not_found",
						message: `#${n} is a pull request.`,
					}
				: { issue };
		} catch {
			out = {
				issue: null,
				reason: "gh_error",
				message: "Unreadable reply from gh.",
			};
		}
	} else {
		const reason = issueFailure(r);
		out = {
			issue: null,
			reason,
			...(reason === "gh_error" ? { message: r.message.slice(0, 300) } : {}),
		};
	}
	cards.set(key, { at: Date.now(), out });
	return out;
}

const prRefs = new Map<string, { at: number; n: number | null }>();

/**
 * The issue a PR closes: GitHub's own closing references first (keywords
 * and links), else a closing keyword in its body. Null when gh cannot say.
 * Background work: cached for minutes per repo and PR.
 */
export async function issueFromPr(
	cwd: string,
	pr: number,
): Promise<number | null> {
	const repo = await issueRepo(cwd);
	if (!repo) return null;
	const key = `${repo}#${pr}`;
	const hit = prRefs.get(key);
	if (hit && Date.now() - hit.at < PR_REFS_TTL_MS) return hit.n;
	const r = await runGh(
		cwd,
		[
			"pr",
			"view",
			String(pr),
			"--repo",
			repo,
			"--json",
			"body,closingIssuesReferences",
		],
		{ mode: "read", lane: "background", timeoutMs: GH_TIMEOUT_MS },
	);
	let n: number | null = null;
	if (r.ok) {
		try {
			const raw = JSON.parse(r.stdout) as {
				body?: unknown;
				closingIssuesReferences?: {
					number?: unknown;
					repository?: { owner?: { login?: unknown }; name?: unknown };
				}[];
			};
			for (const ref of raw.closingIssuesReferences ?? []) {
				const owner = ref.repository?.owner?.login;
				const name = ref.repository?.name;
				const same =
					!owner || !name || `${owner}/${name}`.toLowerCase() === repo;
				const num = asNumber(String(ref.number ?? ""));
				if (same && num) {
					n = num;
					break;
				}
			}
			n ??= issueFromPrBody(typeof raw.body === "string" ? raw.body : "", repo);
		} catch {
			n = null;
		}
	}
	prRefs.set(key, { at: Date.now(), n });
	return n;
}

/** Forget cached gh reads (tests). */
export function forgetIssues() {
	repos.clear();
	cards.clear();
	prRefs.clear();
}
