import { execText } from "./exec.ts";
import { remoteWebUrl } from "./repo-url.ts";

/** One git call for the daemon's PR refresh: async, bounded, null on failure. */
function git(cwd: string, args: string[]): Promise<string | null> {
	return execText("git", ["-C", cwd, ...args], { timeoutMs: 4000 });
}

/** `owner/repo` from a GitHub remote URL (https, ssh or scp form); null for other hosts. */
export function githubSlug(url: string | null): string | null {
	if (!url) return null;
	const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(
		url.trim(),
	);
	return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

/** The URL of the remote a folder pushes to: the branch's push remote, else `origin`. */
async function pushRemoteUrl(cwd: string): Promise<string | null> {
	const branch = await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
	const remote =
		(branch && (await git(cwd, ["config", `branch.${branch}.pushRemote`]))) ||
		(branch && (await git(cwd, ["config", `branch.${branch}.remote`]))) ||
		"origin";
	return git(cwd, ["remote", "get-url", "--push", remote]);
}

/** The repo a folder pushes to: its GitHub slug (for PR lookup) and its web page (any host). */
export async function repoOf(
	cwd: string,
): Promise<{ slug: string | null; url: string | null }> {
	const remote = await pushRemoteUrl(cwd);
	return { slug: githubSlug(remote), url: remoteWebUrl(remote) };
}

/** The GitHub repo a folder pushes to: the branch's push remote, else `origin`. */
export async function repoSlug(cwd: string): Promise<string | null> {
	return githubSlug(await pushRemoteUrl(cwd));
}

/**
 * The PR whose head is the folder's branch, from PR refs already in the local
 * repo (`refs/pull/<n>/head`, or `refs/remotes/<remote>/pr/<n>` when fetched).
 * Matches by commit, so it works whatever the local branch is called.
 */
export async function prFromRefs(cwd: string): Promise<number | null> {
	const tip = await git(cwd, ["rev-parse", "-q", "--verify", "HEAD"]);
	if (!tip) return null;
	const refs =
		(await git(cwd, [
			"for-each-ref",
			"--format=%(objectname) %(refname)",
			"refs/pull",
			"refs/remotes",
		])) ?? "";
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
