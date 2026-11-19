/**
 * Web links for an agent's repo, branch and PR, from the repo page the
 * daemon read off its git remote. Pure. Anything that isn't a plain http(s)
 * URL gives null, and the caller shows plain text.
 */

/** The repo page, if it's a plain http(s) URL with no credentials. */
export function repoLink(repoUrl: string | null | undefined): string | null {
	if (!repoUrl || repoUrl.length > 500) return null;
	let u: URL;
	try {
		u = new URL(repoUrl);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	if (u.username || u.password) return null;
	return `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
}

/** GitLab (gitlab.com, or a self-hosted host with "gitlab" in its name) uses `/-/` routes. */
function isGitLab(url: string): boolean {
	return new URL(url).hostname.includes("gitlab");
}

/** The PR (merge request on GitLab) page; null unless `n` is a plain number. */
export function prLink(
	repoUrl: string | null | undefined,
	n: string | number | null | undefined,
): string | null {
	const repo = repoLink(repoUrl);
	const num = String(n ?? "");
	if (!repo || !/^\d{1,9}$/.test(num)) return null;
	return isGitLab(repo)
		? `${repo}/-/merge_requests/${num}`
		: `${repo}/pull/${num}`;
}

/** The branch's tree page. */
export function branchLink(
	repoUrl: string | null | undefined,
	branch: string | null | undefined,
): string | null {
	const repo = repoLink(repoUrl);
	if (!repo || !branch) return null;
	return `${repo}${isGitLab(repo) ? "/-/tree/" : "/tree/"}${encodeURIComponent(branch)}`;
}

/**
 * Markdown with each `#1234` in prose linked to that PR in the agent's own
 * repo. Fenced and inline code, existing Markdown links and bare URLs stay
 * as written; with no repo page the text comes back unchanged.
 */
export function linkPrs(
	md: string,
	repoUrl: string | null | undefined,
): string {
	const repo = repoLink(repoUrl);
	if (!repo || !md.includes("#")) return md;
	// Odd pieces are left alone: code fences, inline code, links, URLs.
	const parts = md.split(
		/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|!?\[[^\]\n]*\]\([^)\n]*\)|<?https?:\/\/[^\s)>]+>?)/,
	);
	return parts
		.map((p, i) =>
			i % 2
				? p
				: p.replace(
						/(^|[\s([,;:])#(\d{1,7})\b(?![\]\w])/g,
						(_m, pre: string, n: string) => `${pre}[#${n}](${prLink(repo, n)})`,
					),
		)
		.join("");
}
