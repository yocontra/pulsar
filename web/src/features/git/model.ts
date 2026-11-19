/**
 * What the git actions offer for a worktree, and why something is off:
 * pure functions over the daemon's GitStatus (src/git-actions.ts), shared
 * by the desktop split button and the phone sheet.
 */
import type { AgentRow, ChangedFile, GitStatus } from "../../api/types.ts";

export type Step = "commit" | "push" | "pr";

export interface QuickAction {
	label: string;
	/** What it runs, in order; empty: a link (`View PR`) or nothing. */
	steps: Step[];
	/** Why it can't run now (shown in a tooltip / under the button). */
	disabled?: string;
	/** Opens the PR instead of running steps. */
	href?: string;
}

const PR_OPEN = new Set(["open", "draft"]);

export const prOpen = (s: GitStatus) => !!s.pr && PR_OPEN.has(s.pr.state);

/** A link from GitHub's data, only when it is https (null otherwise). */
export const httpsOnly = (u: string | null | undefined) =>
	u && /^https:\/\/\S+$/.test(u) ? u : null;

/** Why nothing at all can run here, or null. */
export function blocked(s: GitStatus | undefined): string | null {
	if (!s) return "Reading the worktree…";
	if (!s.available)
		return s.reason === "no_cwd"
			? "This agent has no folder."
			: s.reason === "unsupported"
				? "The agent's machine runs an older Pulsar."
				: s.reason === "git_failed"
					? "Git couldn't read the worktree."
					: "The agent's folder is not a git repo.";
	if (s.operation)
		return `A ${s.operation} is in progress. Finish it in the terminal first.`;
	if (s.conflicted) return "Resolve the merge conflicts first.";
	return null;
}

export function commitReason(s: GitStatus | undefined): string | null {
	const b = blocked(s);
	if (b) return b;
	if (s!.dirty === 0)
		return "Worktree is clean. Make changes before committing.";
	return null;
}

/** Commits to push exist (or the branch was never pushed). */
export const needsPush = (s: GitStatus) =>
	!!s.remote && !!s.branch && !!s.head && (!s.upstream || s.ahead > 0);

export function pushReason(s: GitStatus | undefined): string | null {
	const b = blocked(s);
	if (b) return b;
	const g = s!;
	if (!g.branch) return "Detached HEAD: check out a branch before pushing.";
	if (!g.remote) return "This repo has no remote to push to.";
	if (g.upstream && g.ahead > 0 && g.behind > 0)
		return "Branch has diverged from upstream. Rebase or merge first.";
	if (g.upstream && g.behind > 0)
		return "Branch is behind upstream. Pull or rebase before pushing.";
	if (!needsPush(g)) return "Nothing to push.";
	return null;
}

/** Why a PR can't be opened, ignoring whether the branch is pushed yet. */
export function prBaseReason(
	s: GitStatus | undefined,
	machine: string | undefined,
): string | null {
	const b = blocked(s);
	if (b) return b;
	const g = s!;
	if (!g.branch) return "Detached HEAD: check out a branch first.";
	if (!g.github) return "PRs need a GitHub remote.";
	const on = machine || "the agent's machine";
	if (g.gh === "missing") return `gh isn't installed on ${on}.`;
	if (g.gh === "logged_out")
		return `gh isn't logged in on ${on}. Run gh auth login there.`;
	if (g.onDefault)
		return "You're on the default branch. Commit on a new branch first.";
	if (!g.defaultBranch) return "No default branch to open a PR against.";
	return null;
}

export function prReason(
	s: GitStatus | undefined,
	machine: string | undefined,
): string | null {
	const b = prBaseReason(s, machine);
	if (b) return b;
	if (needsPush(s!)) return "Push the branch first.";
	return null;
}

/** The split button's primary action for this worktree. */
export function quickAction(
	s: GitStatus | undefined,
	machine: string | undefined,
): QuickAction {
	const b = blocked(s);
	if (b) return { label: "Commit", steps: [], disabled: b };
	const g = s!;
	const canPr = !prBaseReason(g, machine) && !prOpen(g);
	// A push after the commit can work: a remote, and not behind it.
	const pushable = !!g.remote && !(g.upstream && g.behind > 0);
	if (g.dirty > 0) {
		// Detached: the commit dialog asks for a new branch first.
		if (!g.branch) return { label: "Commit", steps: ["commit"] };
		if (pushable && canPr)
			return { label: "Commit, push & PR", steps: ["commit", "push", "pr"] };
		if (pushable) return { label: "Commit & push", steps: ["commit", "push"] };
		return { label: "Commit", steps: ["commit"] };
	}
	const pr = pushReason(g);
	if (!pr) {
		if (canPr) return { label: "Push & create PR", steps: ["push", "pr"] };
		return { label: "Push", steps: ["push"] };
	}
	if (g.upstream && g.behind > 0)
		return { label: "Push", steps: [], disabled: pr };
	if (canPr) return { label: "Create PR", steps: ["pr"] };
	if (g.pr && prOpen(g)) {
		const href = httpsOnly(g.pr.url);
		return href
			? { label: `View PR #${g.pr.number}`, steps: [], href }
			: { label: `PR #${g.pr.number}`, steps: [], disabled: "The PR is open." };
	}
	if (!g.branch)
		return {
			label: "Commit",
			steps: [],
			disabled: "Detached HEAD: check out a branch first.",
		};
	return {
		label: "Commit",
		steps: [],
		disabled: "Worktree is clean. Make changes before committing.",
	};
}

/** The agent is mid-turn: committing under it needs a confirm. */
export const working = (a: AgentRow) =>
	a.state === "busy" || a.state === "needs-you";

const VERB: Record<string, string> = {
	modified: "Update",
	added: "Add",
	untracked: "Add",
	deleted: "Delete",
	renamed: "Rename",
	copied: "Copy",
	typechange: "Update",
	conflicted: "Update",
};

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const dir = (p: string) =>
	p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

/** The folder all paths share ("" when none). */
function commonDir(paths: string[]): string {
	if (paths.length === 0) return "";
	let d = dir(paths[0]!);
	for (const p of paths.slice(1))
		while (d && !(p === d || p.startsWith(`${d}/`))) d = dir(d);
	return d;
}

/**
 * A commit message drafted from the chosen files (no AI): a subject from
 * what changed and where, then one line per file.
 */
export function draftMessage(files: ChangedFile[]): string {
	if (files.length === 0) return "";
	const verbs = new Set(files.map((f) => VERB[f.status] ?? "Update"));
	const verb = verbs.size === 1 ? [...verbs][0]! : "Update";
	let subject: string;
	if (files.length === 1) {
		const f = files[0]!;
		subject =
			f.status === "renamed" && f.oldPath
				? `Rename ${base(f.oldPath)} to ${base(f.path)}`
				: `${verb} ${f.path}`;
	} else {
		const where = commonDir(files.map((f) => f.path));
		const names = files.slice(0, 2).map((f) => base(f.path));
		const rest = files.length - names.length;
		subject = `${verb} ${where ? `${where}: ` : ""}${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`;
	}
	if (subject.length > 72) subject = `${subject.slice(0, 71)}…`;
	if (files.length === 1) return subject;
	const lines = files
		.slice(0, 30)
		.map(
			(f) => `- ${f.path}${f.status === "modified" ? "" : ` (${f.status})`}`,
		);
	if (files.length > 30) lines.push(`- and ${files.length - 30} more`);
	return `${subject}\n\n${lines.join("\n")}`;
}

/** A branch name from the commit message's subject: `pulsar/fix-the-thing`. */
export function branchFrom(message: string, fallback: string): string {
	const slug = (message.split("\n")[0] ?? "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/, "");
	return `pulsar/${slug || fallback.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** The text sent by "Ask {agent} to fix": failing checks and review comments. */
export function fixRequest(d: {
	pr: { number: number; url: string } | null;
	checks: { name: string; state: string; url: string | null }[];
	comments: {
		author: string;
		body: string;
		path: string | null;
		line: number | null;
	}[];
}): string {
	if (!d.pr) return "";
	const out = [`Please fix PR #${d.pr.number} (${d.pr.url}).`];
	const failing = d.checks.filter((c) => c.state === "fail");
	if (failing.length) {
		out.push("", "Failing checks:");
		for (const c of failing.slice(0, 20))
			out.push(`- ${c.name}${c.url ? ` (${c.url})` : ""}`);
	}
	if (d.comments.length) {
		out.push("", "Review comments:");
		for (const c of d.comments.slice(-20)) {
			const where = c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ""}` : "";
			const body = c.body.trim().replace(/\s+/g, " ").slice(0, 600);
			out.push(`- ${c.author}${where}: ${body}`);
		}
	}
	return out.join("\n").slice(0, 8000);
}
