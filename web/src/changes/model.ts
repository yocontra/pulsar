/** Labels and helpers shared by the desktop panel and the phone pages. */
import type { ChangeStatus, ChangesSummary } from "../api/types.ts";

export const STATUS_LETTER: Record<ChangeStatus, string> = {
	modified: "M",
	added: "A",
	deleted: "D",
	renamed: "R",
	copied: "C",
	typechange: "T",
	conflicted: "U",
	untracked: "?",
};

export const STATUS_LABEL: Record<ChangeStatus, string> = {
	modified: "Modified",
	added: "Added",
	deleted: "Deleted",
	renamed: "Renamed",
	copied: "Copied",
	typechange: "Type changed",
	conflicted: "Conflict",
	untracked: "New, untracked",
};

/** "src/a/b.ts" → { dir: "src/a/", name: "b.ts" }. */
export function splitPath(path: string): { dir: string; name: string } {
	const i = path.lastIndexOf("/");
	return i < 0
		? { dir: "", name: path }
		: { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

/** Why there is nothing to show, in a sentence. */
export function unavailableText(s: ChangesSummary): string {
	switch (s.reason) {
		case "no_cwd":
			return "This agent has no working folder pulsar knows of.";
		case "not_a_repo":
			return "This agent's folder isn't in a git repository.";
		case "git_failed":
			return "Couldn't run git in this agent's folder.";
		case "unsupported":
			return "This agent's machine runs an older pulsar. Update it to see changes.";
		case "no_base":
			return "No default branch (main or master) to compare with.";
		default:
			return "Changes aren't available.";
	}
}

export const MODE_LABEL = {
	worktree: "Working tree",
	base: "Branch vs base",
} as const;
