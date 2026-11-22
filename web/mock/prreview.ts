/**
 * Mock PR review (src/pr-review.ts): the agent's PR from web/mock/git.ts
 * with files, patches and review threads. apparish-auth's PR #1402 has
 * two files, an open thread on a line, a resolved one and an outdated one;
 * the gh account wrote the PR unless `/__mock/prreview` says otherwise.
 * Writes change this state like GitHub would.
 */
import type {
	GitPrReview,
	GitReviewFile,
	GitReviewPatch,
	GitReviewThread,
} from "../../src/http/wire.ts";
import type { MockAgent } from "./data.ts";
import { GitMockError, gitPrDetails } from "./git.ts";

interface MockReview {
	head: string;
	body: string;
	ownPr: boolean;
	/** Some threads were not read (the daemon's page limit). */
	threadsTruncated?: boolean;
	/** This file's patch fails to load. */
	failFile?: string;
	files: GitReviewFile[];
	patches: Record<string, string | null>;
	threads: GitReviewThread[];
	/** The next write of this op fails with this message. */
	fail?: { op: string; message: string };
	ids: number;
}

const state = new Map<string, MockReview>();
const HEAD = "4f2a9c1e0b7d6a5c3e2f1a0b9c8d7e6f5a4b3c2d";

const REFRESH = `@@ -36,11 +36,14 @@ export async function refresh(session: Session) {
   if (!session.refreshToken) {
     throw new AuthError("no refresh token");
   }
-  const res = await fetch(TOKEN_URL, {
-    method: "POST",
-    body: form(session.refreshToken),
-  });
+  return lock.run(async () => {
+    const res = await fetch(TOKEN_URL, {
+      method: "POST",
+      body: form(session.refreshToken),
+    });
+    if (!res.ok) throw new AuthError(\`refresh failed: \${res.status}\`);
+    return save(session, await res.json());
+  });
-  return save(session, await res.json());
 }

 export function form(token: string) {`;

const TEST = `@@ -0,0 +1,12 @@
+import { expect, test } from "bun:test";
+import { refresh } from "../src/auth/refresh.ts";
+
+test("two refreshes at once share one request", async () => {
+  let calls = 0;
+  globalThis.fetch = async () => {
+    calls++;
+    return new Response(JSON.stringify({ token: "t" }));
+  };
+  await Promise.all([refresh(s()), refresh(s())]);
+  expect(calls).toBe(1);
+});`;

function seed(a: MockAgent): MockReview {
	const r: MockReview = {
		head: HEAD,
		body: "",
		ownPr: true,
		files: [],
		patches: {},
		threads: [],
		ids: 1000,
	};
	if (a.name !== "apparish-auth") {
		r.body = "Work in progress.";
		r.files = [
			{
				path: "README.md",
				oldPath: null,
				status: "modified",
				added: 1,
				removed: 0,
				binary: false,
				tooLarge: false,
			},
		];
		r.patches["README.md"] = "@@ -1,2 +1,3 @@\n # App\n+More docs.\n Usage";
		return r;
	}
	const repo = a.repoUrl ?? "https://github.com/acme/app";
	r.body =
		"Two refreshes that start together raced and one lost its token.\n\nThis puts the refresh behind the session lock and adds a test.";
	r.files = [
		{
			path: "src/auth/refresh.ts",
			oldPath: null,
			status: "modified",
			added: 8,
			removed: 5,
			binary: false,
			tooLarge: false,
		},
		{
			path: "test/refresh.test.ts",
			oldPath: null,
			status: "added",
			added: 12,
			removed: 0,
			binary: false,
			tooLarge: false,
		},
		{
			path: "docs/flow.png",
			oldPath: null,
			status: "added",
			added: 0,
			removed: 0,
			binary: false,
			tooLarge: false,
		},
		{
			path: "src/auth/lock.ts",
			oldPath: "src/auth/mutex.ts",
			status: "renamed",
			added: 0,
			removed: 0,
			binary: false,
			tooLarge: false,
		},
	];
	r.patches = {
		"src/auth/refresh.ts": REFRESH,
		"test/refresh.test.ts": TEST,
		"docs/flow.png": null,
		"src/auth/lock.ts": null,
	};
	r.threads = [
		{
			id: "PRRT_mock_open",
			path: "src/auth/refresh.ts",
			line: 39,
			startLine: null,
			originalLine: 39,
			side: "RIGHT",
			outdated: false,
			resolved: false,
			canResolve: true,
			canReply: true,
			comments: [
				{
					id: 1,
					author: "reviewer",
					body: "Use the mutex here too.",
					at: "2026-11-19T10:01:00Z",
					url: `${repo}/pull/1402#discussion_r1`,
				},
			],
		},
		{
			id: "PRRT_mock_done",
			path: "test/refresh.test.ts",
			line: 11,
			startLine: null,
			originalLine: 11,
			side: "RIGHT",
			outdated: false,
			resolved: true,
			canResolve: true,
			canReply: true,
			comments: [
				{
					id: 2,
					author: "reviewer",
					body: "Assert the token too.",
					at: "2026-11-19T10:02:00Z",
					url: null,
				},
				{
					id: 3,
					author: "apparish",
					body: "Done in the next commit.",
					at: "2026-11-19T11:00:00Z",
					url: null,
				},
			],
		},
		{
			// A line outside the hunks: shown above the diff.
			id: "PRRT_mock_far",
			path: "src/auth/refresh.ts",
			line: 80,
			startLine: null,
			originalLine: 80,
			side: "RIGHT",
			outdated: false,
			resolved: true,
			canResolve: true,
			canReply: true,
			comments: [
				{
					id: 5,
					author: "reviewer",
					body: "Same pattern in logout().",
					at: "2026-11-18T09:30:00Z",
					url: null,
				},
			],
		},
		{
			id: "PRRT_mock_old",
			path: "src/auth/refresh.ts",
			line: null,
			startLine: null,
			originalLine: 30,
			side: "RIGHT",
			outdated: true,
			resolved: false,
			canResolve: true,
			canReply: true,
			comments: [
				{
					id: 4,
					author: "reviewer",
					body: "Typo in the error text.",
					at: "2026-11-18T09:00:00Z",
					url: null,
				},
			],
		},
	];
	return r;
}

function reviewOf(a: MockAgent): MockReview {
	let r = state.get(a.id);
	if (!r) {
		r = seed(a);
		state.set(a.id, r);
	}
	return r;
}

export function resetPrReview() {
	state.clear();
}

export function prReview(a: MockAgent): GitPrReview {
	const d = gitPrDetails(a);
	const base = {
		agent: a.id,
		pr: d.pr,
		...(d.reason ? { reason: d.reason } : {}),
		checks: d.checks,
		review: d.review,
		reviews: d.comments.filter((c) => c.path === null),
		truncated: false,
		threadsTruncated: false,
	};
	if (!d.pr)
		return {
			...base,
			head: null,
			body: "",
			author: null,
			ownPr: false,
			files: [],
			threads: [],
		};
	const r = reviewOf(a);
	return {
		...base,
		head: r.head,
		body: r.body,
		author: r.ownPr ? "operator" : "apparish",
		ownPr: r.ownPr,
		files: r.files,
		threads: r.threads,
		threadsTruncated: !!r.threadsTruncated,
	};
}

export function prReviewFile(a: MockAgent, path: string): GitReviewPatch {
	const r = reviewOf(a);
	const f = r.files.find((x) => x.path === path);
	if (!gitPrDetails(a).pr || !f)
		throw new GitMockError(404, "not_found", "the PR has no such file");
	if (r.failFile === path)
		throw new GitMockError(503, "unreachable", "GitHub didn't answer");
	return {
		agent: a.id,
		path,
		patch: r.patches[path] ?? null,
		binary: f.binary,
		tooLarge: f.tooLarge,
	};
}

const refuse = (m: string) => new GitMockError(409, "git_refused", m);
const bad = (m: string) => new GitMockError(400, "bad_request", m);

function guard(a: MockAgent, op: string, p: Record<string, unknown>) {
	const pr = gitPrDetails(a).pr;
	if (!pr) throw refuse("This branch has no PR any more.");
	if (p.number !== pr.number)
		throw refuse("The branch's PR changed. Reload and try again.");
	const r = reviewOf(a);
	if (r.fail?.op === op) {
		const m = r.fail.message;
		delete r.fail;
		throw new GitMockError(409, "git_failed", m);
	}
	return r;
}

const text = (v: unknown, required = true) => {
	if (typeof v !== "string" || (required && !v.trim()))
		throw bad("body: write something");
	return v;
};

function thread(r: MockReview, id: unknown) {
	const t = r.threads.find((x) => x.id === id);
	if (!t) throw refuse("That thread is not on this PR.");
	return t;
}

const now = () => new Date().toISOString();

/** `POST /agents/:id/git/{comment,reply,resolve,review}`. */
export function prReviewAct(
	a: MockAgent,
	op: string,
	p: Record<string, unknown>,
): unknown {
	const r = guard(a, op, p);
	switch (op) {
		case "comment": {
			const body = text(p.body);
			if (p.head !== r.head)
				throw refuse(
					"The PR has new commits. Reload to comment on the latest code.",
				);
			if (!r.files.some((f) => f.path === p.path))
				throw bad("path: not in this PR");
			if (!Number.isInteger(p.line) || (p.line as number) < 1)
				throw bad("line: expected a positive whole number");
			if (p.side !== "LEFT" && p.side !== "RIGHT") throw bad("side");
			r.threads.push({
				id: `PRRT_mock_${r.ids++}`,
				path: String(p.path),
				line: p.line as number,
				startLine: null,
				originalLine: p.line as number,
				side: p.side,
				outdated: false,
				resolved: false,
				canResolve: true,
				canReply: true,
				comments: [
					{ id: r.ids++, author: "operator", body, at: now(), url: null },
				],
			});
			return { ok: true };
		}
		case "reply": {
			const t = thread(r, p.thread);
			t.comments.push({
				id: r.ids++,
				author: "operator",
				body: text(p.body),
				at: now(),
				url: null,
			});
			return { ok: true };
		}
		case "resolve": {
			const t = thread(r, p.thread);
			if (typeof p.resolved !== "boolean") throw bad("resolved");
			t.resolved = p.resolved;
			return { ok: true, resolved: p.resolved };
		}
		case "review": {
			const event = p.event;
			if (
				event !== "comment" &&
				event !== "approve" &&
				event !== "request_changes"
			)
				throw bad("event");
			const body = text(p.body, event !== "approve");
			if (r.ownPr && event !== "comment")
				throw new GitMockError(
					409,
					"git_failed",
					`GraphQL: Can not ${event === "approve" ? "approve" : "request changes on"} your own pull request (addPullRequestReview)`,
				);
			const d = gitPrDetails(a);
			// Shown with the PR card's reviews (web/mock/git.ts keeps them).
			d.comments.push({
				author: "operator",
				body,
				path: null,
				line: null,
				verdict:
					event === "approve"
						? "approved"
						: event === "request_changes"
							? "changes_requested"
							: "commented",
				url: null,
				at: now(),
			});
			return { ok: true };
		}
	}
	throw bad(`unknown op ${op}`);
}

/** `/__mock/prreview`: `{ agent, set?: { ownPr?, head? }, fail?: { op, message } }`. */
export function prReviewControl(
	a: MockAgent,
	body: {
		set?: Partial<
			Pick<MockReview, "ownPr" | "head" | "threadsTruncated" | "failFile">
		>;
		fail?: MockReview["fail"];
	},
) {
	const r = reviewOf(a);
	if (body.set) Object.assign(r, body.set);
	if (body.fail) r.fail = body.fail;
	return { ok: true };
}
