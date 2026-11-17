import { runJson, which } from "./util.ts";

/** Open PR numbers by `<cwd>\0<branch>`, refreshed at most every few minutes. */
const cache = new Map<string, { pr: number | null; at: number }>();
const TTL_MS = 3 * 60_000;
const DEFAULT_BRANCHES = new Set(["main", "master", "develop", "dev", "trunk"]);

async function ghPrForBranch(
	cwd: string,
	branch: string,
): Promise<number | null> {
	const list = (await runJson(
		"gh",
		[
			"pr",
			"list",
			"--head",
			branch,
			"--state",
			"open",
			"--json",
			"number",
			"--limit",
			"1",
		],
		{ cwd, timeout: 15_000 },
	)) as Array<{ number: number }> | null;
	return list?.[0]?.number ?? null;
}

/**
 * The open GitHub PR whose head is `branch`, via the `gh` CLI. Returns the
 * cached answer when fresh; null when gh is missing, logged out, or no PR.
 */
export async function openPr(
	cwd: string,
	branch: string | null,
): Promise<number | null> {
	if (!branch || DEFAULT_BRANCHES.has(branch) || !which("gh")) return null;
	const key = `${cwd}\0${branch}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL_MS) return hit.pr;
	const pr = await ghPrForBranch(cwd, branch);
	cache.set(key, { pr, at: Date.now() });
	return pr;
}
