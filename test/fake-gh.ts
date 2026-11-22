import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpFolder } from "./git-repo.ts";

/**
 * A fake `gh` on PATH for the git actions' tests: `pr view`, `pr create`,
 * `issue view` and `api` answer from a JSON state file (no network, no real GitHub account).
 * Every call is logged. Put `dir` first on PATH (process.env.PATH).
 */
export interface FakeGhState {
	/**
	 * "logged_out": every call fails the way an unauthenticated gh does;
	 * "bad_token": the way a revoked token does (GitHub answers HTTP 401).
	 */
	mode?: "ok" | "logged_out" | "bad_token";
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
	/** PR review: `api .../pulls/N/files` (paged by `page`). */
	files?: Record<string, unknown>[];
	/** PR review: GraphQL review threads, and whether the viewer wrote the PR. */
	threads?: Record<string, unknown>[];
	viewerDidAuthor?: boolean;
	/** A thread id's PR (`node(id:)`): number and `owner/name`. */
	threadPrs?: Record<string, { number: number; repo: string }>;
	/** Line comments posted (`api -X POST .../comments`), and reviews submitted. */
	posted?: Record<string, string>[];
	submitted?: { number: string; flag: string; body: string }[];
	/** The next write (`pr review`, a POST, a mutation) fails with this on stderr. */
	writeError?: string;
}

const SCRIPT = `#!/usr/bin/env bun
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const dir = process.env.FAKE_GH_DIR;
const file = dir + "/state.json";
const st = JSON.parse(readFileSync(file, "utf8"));
const a = process.argv.slice(2);
appendFileSync(dir + "/calls.log", JSON.stringify(a) + "\\n");
const opt = (k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (st.mode === "bad_token") {
	console.error("HTTP 401: Bad credentials (https://api.github.com/graphql)");
	process.exit(1);
}
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
const save = () => writeFileSync(file, JSON.stringify(st));
const fields = () => { const o = {}; for (let i = 0; i < a.length; i++) if (a[i] === "-f" || a[i] === "-F") { const kv = a[i + 1]; const eq = kv.indexOf("="); o[kv.slice(0, eq)] = kv.slice(eq + 1); } return o; };
const writeFail = () => { if (st.writeError) { const m = st.writeError; delete st.writeError; save(); console.error(m); process.exit(1); } };
if (a[0] === "pr" && a[1] === "review") {
	writeFail();
	const flag = a.find((x) => x === "--approve" || x === "--comment" || x === "--request-changes");
	const body = (a.find((x) => x.startsWith("--body=")) ?? "--body=").slice(7);
	(st.submitted ??= []).push({ number: a[2], flag, body });
	save();
	process.exit(0);
}
if (a[0] === "api" && a[1] === "graphql") {
	const f = fields();
	const q = f.query ?? "";
	if (q.startsWith("mutation")) {
		writeFail();
		const t = (st.threads ?? []).find((x) => x.id === f.thread);
		if (!t) { console.error("GraphQL: Could not resolve to a node with the global id of '" + f.thread + "'"); process.exit(1); }
		if (q.includes("unresolveReviewThread")) t.isResolved = false;
		else if (q.includes("resolveReviewThread")) t.isResolved = true;
		else if (q.includes("addPullRequestReviewThreadReply")) t.comments.nodes.push({ databaseId: 900 + t.comments.nodes.length, author: { login: "me" }, body: f.body, createdAt: "2026-11-21T10:00:00Z", url: "https://github.com/x/y/pull/1#r9" });
		save();
		console.log(JSON.stringify({ data: {} }));
		process.exit(0);
	}
	if (q.includes("node(id:")) {
		const pr = (st.threadPrs ?? {})[f.id];
		console.log(JSON.stringify({ data: { node: pr ? { pullRequest: { number: pr.number, repository: { nameWithOwner: pr.repo } } } : null } }));
		process.exit(0);
	}
	console.log(JSON.stringify({ data: { repository: { pullRequest: { viewerDidAuthor: !!st.viewerDidAuthor, reviewThreads: { nodes: st.threads ?? [] } } } } }));
	process.exit(0);
}
if (a[0] === "api" && (a.find((x) => x.startsWith("repos/")) ?? "").endsWith("/files")) {
	const f = fields();
	const per = Number(f.per_page ?? 30), page = Number(f.page ?? 1);
	console.log(JSON.stringify((st.files ?? []).slice((page - 1) * per, page * per)));
	process.exit(0);
}
if (a[0] === "api" && a.includes("POST")) {
	writeFail();
	const f = fields();
	(st.posted ??= []).push(f);
	save();
	console.log(JSON.stringify({ id: 1 }));
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
