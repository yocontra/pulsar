import type { GitInfo } from "./git.ts";

/** Tags pulsar sets and refreshes itself; agents add any others. */
export function isAutoTag(tag: string): boolean {
	return /^(harness|project|branch|worktree|model):/.test(tag);
}

/** Auto-tags every agent gets. Self-tags are added on top. */
export function autoTags(harness: string, git: GitInfo): string[] {
	const tags = [`harness:${harness}`];
	if (git.project) tags.push(`project:${git.project}`);
	if (git.branch) tags.push(`branch:${git.branch}`);
	if (git.worktree) tags.push(`worktree:${git.worktree}`);
	return tags;
}

/** Tags from PULSAR_TAGS (comma or space separated), for launch-time tagging. */
export function envTags(): string[] {
	return (process.env.PULSAR_TAGS ?? "")
		.split(/[\s,]+/)
		.map((t) => t.trim())
		.filter(Boolean);
}
