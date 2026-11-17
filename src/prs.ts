import { execFileSync } from "node:child_process";

const GIT_OPTS = {
	encoding: "utf8" as const,
	stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
	timeout: 3000,
};

function git(cwd: string, args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", cwd, ...args], GIT_OPTS).trim() || null;
	} catch {
		return null;
	}
}

/** `owner/repo` from a GitHub remote URL (https, ssh or scp form); null for other hosts. */
export function githubSlug(url: string | null): string | null {
	if (!url) return null;
	const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
		url.trim(),
	);
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The GitHub repo a folder pushes to: the branch's push remote, else `origin`. */
export function repoSlug(cwd: string): string | null {
	const branch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	const remote =
		(branch && git(cwd, ["config", `branch.${branch}.pushRemote`])) ||
		(branch && git(cwd, ["config", `branch.${branch}.remote`])) ||
		"origin";
	return githubSlug(git(cwd, ["remote", "get-url", "--push", remote]));
}

/**
 * The PR whose head is the folder's branch, from PR refs already in the local
 * repo (`refs/pull/<n>/head`, or `refs/remotes/<remote>/pr/<n>` when fetched).
 * Matches by commit, so it works whatever the local branch is called.
 */
export function prFromRefs(cwd: string): number | null {
	const tip = git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]);
	if (!tip) return null;
	const refs =
		git(cwd, [
			"for-each-ref",
			"--format=%(objectname) %(refname)",
			"refs/pull",
			"refs/remotes",
		]) ?? "";
	for (const line of refs.split("\n")) {
		const [sha, ref] = line.split(" ");
		if (sha !== tip || !ref) continue;
		const n =
			/refs\/pull\/(\d+)\/head$/.exec(ref)?.[1] ??
			/\/pr\/(\d+)$/.exec(ref)?.[1];
		if (n) return Number(n);
	}
	return null;
}

/**
 * The PR an agent's session log points at, in the agent's own repo: Claude
 * Code's `pr-link` records first (authoritative), then the last PR URL that
 * appears (`gh pr create` output, a push, a link the agent opened).
 */
export function prFromText(text: string, slug: string | null): number | null {
	if (!text || !slug) return null;
	const esc = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const link = new RegExp(
		`"prRepository"\\s*:\\s*"${esc}"[^}]*?"prNumber"\\s*:\\s*(\\d+)`,
		"gi",
	);
	let found: string | null = null;
	for (let m = link.exec(text); m; m = link.exec(text)) found = m[1] ?? found;
	if (found) return Number(found);
	const url = new RegExp(`github\\.com/${esc}/pull/(\\d+)`, "gi");
	for (let m = url.exec(text); m; m = url.exec(text)) found = m[1] ?? found;
	return found ? Number(found) : null;
}
