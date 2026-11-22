import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpFolder } from "./git-repo.ts";

/**
 * A fake `gh` on PATH for the git actions' tests: `pr view`, `pr create`,
 * `issue view` and `api` answer from a JSON state file (no network, no real GitHub account).
 * Every call is logged. Put `dir` first on PATH (process.env.PATH).
 */
export interface FakeGhState {
	/** "logged_out": every call fails the way an unauthenticated gh does. */
	mode?: "ok" | "logged_out";
	/** PRs by head ref, in `gh pr view --json`'s shape. */
	prs: Record<string, Record<string, unknown>>;
	/** Inline review comments (`gh api .../pulls/N/comments`). */
	comments?: Record<string, unknown>[];
	/** `pr create` fails with this on stderr. */
	createError?: string;
	/** The next PR's number. */
	next?: number;
	/** Issues by number, in `gh issue view --json`'s shape (missing: not found). */
	issues?: Record<string, Record<string, unknown>>;
}

const SCRIPT = `#!/usr/bin/env bun
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const file = dir + "/state.json";
const st = JSON.parse(readFileSync(file, "utf8"));
const a = process.argv.slice(2);
appendFileSync(dir + "/calls.log", JSON.stringify(a) + "\\n");
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (st.mode === "logged_out") {
	console.error("To get started with GitHub CLI, please run:  gh auth login");
	process.exit(4);
}
if (a[0] === "pr" && a[1] === "view") {
	const pr = st.prs[a[2]];
	if (!pr) { console.error('no pull requests found for branch "' + a[2] + '"'); process.exit(1); }
	const out = {};
	for (const f of opt("--json").split(",")) out[f] = pr[f];
	console.log(JSON.stringify(out));
	process.exit(0);
}
if (a[0] === "pr" && a[1] === "create") {
	if (st.createError) { console.error(st.createError); process.exit(1); }
	const head = opt("--head");
	const n = st.next ?? 7;
	st.next = n + 1;
	st.prs[head] = {
		number: n,
		url: "https://github.com/" + opt("--repo") + "/pull/" + n,
		title: opt("--title") ?? "From the commits",
		state: "OPEN",
		isDraft: a.includes("--draft"),
		baseRefName: opt("--base"),
		headRefName: head,
		reviewDecision: "",
		statusCheckRollup: [],
		reviews: [],
	};
	writeFileSync(file, JSON.stringify(st));
	console.log("Creating pull request...");
	console.log(st.prs[head].url);
	process.exit(0);
}
if (a[0] === "issue" && a[1] === "view") {
	const issue = (st.issues ?? {})[a[2]];
	if (!issue) { console.error("GraphQL: Could not resolve to an issue or pull request with the number of " + a[2] + ". (repository.issue)"); process.exit(1); }
	const out = {};
	for (const f of opt("--json").split(",")) out[f] = issue[f];
	console.log(JSON.stringify(out));
	process.exit(0);
}
if (a[0] === "api") { console.log(JSON.stringify(st.comments ?? [])); process.exit(0); }
console.error("fake gh: unknown command " + a.join(" "));
process.exit(2);
`;

export function fakeGh(initial: FakeGhState = { prs: {} }) {
	const dir = tmpFolder();
	const bin = join(dir, "gh");
	writeFileSync(bin, SCRIPT);
	chmodSync(bin, 0o755);
	const file = join(dir, "state.json");
	const set = (s: FakeGhState) => writeFileSync(file, JSON.stringify(s));
	set(initial);
	return {
		dir,
		set,
		state: () => JSON.parse(readFileSync(file, "utf8")) as FakeGhState,
		/** Every call's argv so far. */
		calls: (): string[][] => {
			const log = join(dir, "calls.log");
			return existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l) as string[])
				: [];
		},
	};
}
