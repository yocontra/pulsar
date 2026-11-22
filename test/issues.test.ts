import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaude } from "../src/harnesses/claude-transcript.ts";
import {
	BODY_MAX,
	excerpt,
	forgetIssues,
	issueFromBranch,
	issueFromPr,
	issueFromPrBody,
	issueFromText,
	issueRepo,
	readIssue,
	toIssue,
} from "../src/issues.ts";
import { matches, parseSelector } from "../src/selector.ts";
import { PulsarService } from "../src/service/index.ts";
import { firstOperatorText } from "../src/service/issues.ts";
import { Store } from "../src/store.ts";
import { newParseState } from "../src/transcripts/types.ts";
import { fakeGh } from "./fake-gh.ts";
import { cleanupRepos, g, gitRepo } from "./git-repo.ts";

/**
 * GitHub issue awareness: detection from each source (branch, PR body,
 * the operator's first message, the agent's own tag), the `issue=` selector,
 * and the card read with a fake gh on PATH (no network).
 */

process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";
const gh = fakeGh();
process.env.FAKE_GH_DIR = gh.dir;
process.env.PATH = `${gh.dir}:${process.env.PATH ?? ""}`;

const ISSUE = {
	number: 1378,
	title: "Crash on start",
	state: "OPEN",
	stateReason: "",
	url: "https://github.com/acme/demo/issues/1378",
	labels: [
		{ name: "bug", color: "D73A4A" },
		{ name: "bad", color: "red;x" },
	],
	assignees: [{ login: "octo" }],
	author: { login: "reporter" },
	body: "It **crashes**.\n\n```\nstack\n```",
	updatedAt: "2026-11-20T10:00:00Z",
};

const temps: string[] = [];
afterAll(() => {
	cleanupRepos();
	for (const d of temps) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => forgetIssues());

describe("issue from a branch name", () => {
	test.each([
		["fix-1378", 1378],
		["issue-1378", 1378],
		["issues/1378", 1378],
		["issue/1378-crash", 1378],
		["gh-12", 12],
		["bug/7-crash", 7],
		["fix_42", 42],
		["fix1378", 1378],
		["1378-foo", 1378],
		["contra/1378-foo", 1378],
		["feat/closes-99", 99],
	])("%s → %d", (branch, n) => {
		expect(issueFromBranch(branch)).toBe(n);
	});
	test.each([
		"main",
		"feat-issues",
		"pool-polish4",
		"int2",
		"finish/out-west-integration-20261114",
		"2026-11-14-notes",
		"release-1.2",
		"v2-1",
		"fix-typo-12",
		"fix-12345678",
		"dependabot/npm_and_yarn/foo-1.2.3",
		"",
	])("%s → none", (branch) => {
		expect(issueFromBranch(branch)).toBeNull();
	});
});

describe("issue from a PR body", () => {
	const slug = "acme/demo";
	test.each([
		["Fixes #12", 12],
		["This closes acme/demo#13.", 13],
		["Resolves https://github.com/acme/demo/issues/14", 14],
		["fixed: #15", 15],
		["Refs #1\n\nCloses other/repo#2 and fixes #16", 16],
	])("%s", (body, n) => {
		expect(issueFromPrBody(body, slug)).toBe(n);
	});
	test("no closing keyword, code, other repos: none", () => {
		expect(issueFromPrBody("See #12", slug)).toBeNull();
		expect(issueFromPrBody("`Fixes #12`", slug)).toBeNull();
		expect(issueFromPrBody("```\nFixes #12\n```", slug)).toBeNull();
		expect(issueFromPrBody("Fixes other/repo#12", slug)).toBeNull();
		expect(issueFromPrBody("", slug)).toBeNull();
	});
});

describe("issue from the operator's first message", () => {
	test("an issue link of the agent's repo wins over a bare #N", () => {
		expect(
			issueFromText(
				"Look at #3 and https://github.com/acme/demo/issues/1378",
				"acme/demo",
			),
		).toBe(1378);
	});
	test("the first #N in prose; not the agent's PR, code, URLs or entities", () => {
		expect(issueFromText("Please fix #1378 today", "acme/demo")).toBe(1378);
		expect(issueFromText("(#7) first", null)).toBe(7);
		expect(issueFromText("Review PR #12, then #40", "acme/demo", 12)).toBe(40);
		expect(issueFromText("run `git log #5`", "acme/demo")).toBeNull();
		expect(issueFromText("see a.com/x#12 and &#39;", "acme/demo")).toBeNull();
		expect(issueFromText("color #fff", "acme/demo")).toBeNull();
		expect(issueFromText(null, "acme/demo")).toBeNull();
	});
	test("the first user text of a transcript, not commands or shell", () => {
		const lines = [
			{
				type: "user",
				message: {
					role: "user",
					content: "<command-name>/clear</command-name>",
				},
			},
			{ type: "user", message: { role: "user", content: "Fix #21 please" } },
			{ type: "user", message: { role: "user", content: "and #22" } },
		]
			.map((l, i) =>
				JSON.stringify({
					...l,
					uuid: `u${i}`,
					timestamp: "2026-11-20T10:00:00Z",
				}),
			)
			.join("\n");
		const events = parseClaude(`${lines}\n`, newParseState({ atStart: true }));
		expect(firstOperatorText(events)).toBe("Fix #21 please");
	});
});

describe("the issue card", () => {
	test("toIssue keeps the card's fields, checked and bounded", () => {
		const i = toIssue({ ...ISSUE, url: "javascript:alert(1)" });
		expect(i).toMatchObject({
			number: 1378,
			title: "Crash on start",
			state: "open",
			stateReason: null,
			url: null,
			labels: [
				{ name: "bug", color: "d73a4a" },
				{ name: "bad", color: null },
			],
			assignees: ["octo"],
			author: "reporter",
			truncated: false,
		});
		expect(
			toIssue({ ...ISSUE, state: "CLOSED", stateReason: "NOT_PLANNED" }),
		).toMatchObject({ state: "closed", stateReason: "not_planned" });
	});
	test("a long body is cut near a line break", () => {
		const long = `${"a".repeat(BODY_MAX - 100)}\n${"b".repeat(500)}`;
		const e = excerpt(long);
		expect(e.truncated).toBe(true);
		expect(e.body).toBe("a".repeat(BODY_MAX - 100));
		expect(excerpt("short")).toEqual({ body: "short", truncated: false });
	});

	test("read with gh against the repo: found, cached, not found, a PR, logged out", async () => {
		const repo = gitRepo();
		g(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
		expect(await issueRepo(repo)).toBe("acme/demo");
		gh.set({ prs: {}, issues: { "1378": ISSUE } });
		const r = await readIssue(repo, 1378);
		expect(r.issue).toMatchObject({ number: 1378, title: "Crash on start" });
		const call = gh.calls().findLast((c) => c[0] === "issue")!;
		expect(call.slice(0, 5)).toEqual([
			"issue",
			"view",
			"1378",
			"--repo",
			"acme/demo",
		]);
		// Cached: no second gh call.
		const before = gh.calls().length;
		await readIssue(repo, 1378);
		expect(gh.calls().length).toBe(before);

		expect(await readIssue(repo, 9)).toMatchObject({
			issue: null,
			reason: "not_found",
		});
		gh.set({
			prs: {},
			issues: {
				"10": {
					...ISSUE,
					number: 10,
					url: "https://github.com/acme/demo/pull/10",
				},
			},
		});
		expect(await readIssue(repo, 10)).toMatchObject({
			issue: null,
			reason: "not_found",
			message: "#10 is a pull request.",
		});
		gh.set({ prs: {}, mode: "logged_out" });
		expect(await readIssue(repo, 11)).toMatchObject({
			reason: "gh_logged_out",
		});
	});

	test("a fork's issues live in upstream; no GitHub remote: no_github", async () => {
		const repo = gitRepo();
		g(repo, "remote", "add", "origin", "https://github.com/me/demo.git");
		g(repo, "remote", "add", "upstream", "git@github.com:acme/demo.git");
		expect(await issueRepo(repo)).toBe("acme/demo");
		const plain = gitRepo();
		expect(await readIssue(plain, 1)).toEqual({
			issue: null,
			reason: "no_github",
		});
	});

	test("issueFromPr: GitHub's closing references, else the body", async () => {
		const repo = gitRepo();
		g(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
		gh.set({
			prs: {
				"5": {
					body: "Fixes #3",
					closingIssuesReferences: [
						{
							number: 99,
							repository: { owner: { login: "other" }, name: "x" },
						},
						{
							number: 4,
							repository: { owner: { login: "acme" }, name: "demo" },
						},
					],
				},
				"6": { body: "Closes #8", closingIssuesReferences: [] },
			},
		});
		expect(await issueFromPr(repo, 5)).toBe(4);
		expect(await issueFromPr(repo, 6)).toBe(8);
		expect(await issueFromPr(repo, 7)).toBeNull();
	});
});

describe("detection in the daemon", () => {
	function service(logs: Map<string, string>, prLookup = false) {
		const store = new Store(":memory:");
		const svc = new PulsarService({
			store,
			scan: false,
			machine: "t",
			issues: { prLookup },
			transcripts: {
				resolve: (agent) => {
					const path = agent.sessionId ? logs.get(agent.sessionId) : undefined;
					return path
						? {
								source: { kind: "file", path },
								parse: parseClaude,
								cwd: agent.cwd,
							}
						: null;
				},
			},
		});
		return {
			svc,
			close: () => {
				svc.stop();
				store.close();
			},
		};
	}
	const reg = (
		svc: PulsarService,
		sessionId: string,
		over: { branch?: string; cwd?: string; tags?: string[] } = {},
	) =>
		svc.registry.upsert({
			harness: "claude",
			sessionId,
			pid: null,
			cwd: over.cwd ?? "/tmp/none",
			project: null,
			branch: over.branch ?? null,
			tags: over.tags ?? [],
			meta: {},
			registered: true,
		});
	const issueTags = (svc: PulsarService, id: string) =>
		svc.registry.get(id)!.tags.filter((t) => t.startsWith("issue:"));

	test("branch, first message, own tag; selector issue=N; never saved as the agent's own", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pulsar-issues-"));
		temps.push(dir);
		const log = join(dir, "m.jsonl");
		writeFileSync(
			log,
			`${JSON.stringify({
				type: "user",
				message: { role: "user", content: "Work on #77 please" },
				uuid: "u1",
				timestamp: "2026-11-20T10:00:00Z",
			})}\n`,
		);
		const { svc, close } = service(new Map([["s-msg", log]]));
		try {
			const byBranch = reg(svc, "s-br", { branch: "fix-1378" });
			const byMsg = reg(svc, "s-msg", { branch: "main" });
			const none = reg(svc, "s-none", { branch: "main" });
			const updates: string[] = [];
			svc.events.on("agent", (e) => {
				if (e.action === "update") updates.push(e.agent.id);
			});
			await svc.issues.refresh();
			expect(issueTags(svc, byBranch.id)).toEqual(["issue:1378"]);
			expect(svc.registry.get(byBranch.id)!.meta.issueFrom).toBe("branch");
			expect(issueTags(svc, byMsg.id)).toEqual(["issue:77"]);
			expect(svc.registry.get(byMsg.id)!.meta.issueFrom).toBe("message");
			expect(issueTags(svc, none.id)).toEqual([]);
			expect(updates.sort()).toEqual([byBranch.id, byMsg.id].sort());
			// Nothing changed: no more updates.
			await svc.issues.refresh();
			expect(updates).toHaveLength(2);

			// The selector key finds it.
			const sel = parseSelector("issue=1378");
			expect(
				svc.registry
					.all()
					.map((a) => svc.registry.view(a))
					.filter((a) => matches(a, sel))
					.map((a) => a.id),
			).toEqual([byBranch.id]);

			// The branch moves on: the detected tag goes.
			svc.registry.get(byBranch.id)!.branch = "main";
			await svc.issues.refresh();
			expect(issueTags(svc, byBranch.id)).toEqual([]);

			// The agent's own tag wins; pulsar's is dropped and not saved.
			const a = svc.registry.get(byMsg.id)!;
			a.tags.push("issue:500");
			await svc.issues.refresh();
			expect(issueTags(svc, byMsg.id)).toEqual(["issue:500"]);
			expect(svc.issues.current(a)).toEqual({ n: 500, source: "tag" });
		} finally {
			close();
		}
	});

	test("the issue the agent's PR closes (gh), only when asked", async () => {
		const repo = gitRepo();
		g(repo, "remote", "add", "origin", "https://github.com/acme/demo.git");
		gh.set({
			prs: { "5": { body: "Fixes #31", closingIssuesReferences: [] } },
		});
		for (const prLookup of [false, true]) {
			forgetIssues();
			const { svc, close } = service(new Map(), prLookup);
			try {
				const a = reg(svc, `s-pr-${prLookup}`, { branch: "feat", cwd: repo });
				svc.registry.get(a.id)!.meta.autoPr = "5";
				const calls = gh.calls().length;
				await svc.issues.refresh();
				expect(issueTags(svc, a.id)).toEqual(prLookup ? ["issue:31"] : []);
				expect(gh.calls().length > calls).toBe(prLookup);
				if (prLookup) expect(svc.registry.get(a.id)!.meta.issueFrom).toBe("pr");
			} finally {
				close();
			}
		}
	});

	test("set_identity keeps the agent's own issue tag, not the detected one", async () => {
		const { svc, close } = service(new Map());
		try {
			const a = reg(svc, "s-save", { branch: "issue-9" });
			await svc.issues.refresh();
			expect(issueTags(svc, a.id)).toEqual(["issue:9"]);
			const saved: string[][] = [];
			const orig = svc.store.saveIdentity.bind(svc.store);
			svc.store.saveIdentity = (id, ident, at) => {
				saved.push(ident.tags);
				return orig(id, ident, at);
			};
			svc.registry.setIdentity(svc.registry.get(a.id)!, {
				tagsAdd: ["role:author"],
			});
			expect(saved.at(-1)).toContain("role:author");
			expect(saved.at(-1)).not.toContain("issue:9");
		} finally {
			close();
		}
	});
});
