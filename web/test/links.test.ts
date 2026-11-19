import { describe, expect, test } from "bun:test";
import { branchLink, linkPrs, prLink, repoLink } from "../src/lib/links.ts";

describe("repo, branch and PR links", () => {
	const gh = "https://github.com/acme/app";
	const gl = "https://gitlab.com/acme/platform/billing";

	test("GitHub and other hosts use /pull and /tree", () => {
		expect(repoLink(gh)).toBe(gh);
		expect(prLink(gh, "1402")).toBe(`${gh}/pull/1402`);
		expect(prLink(gh, 7)).toBe(`${gh}/pull/7`);
		expect(branchLink(gh, "feat/billing")).toBe(`${gh}/tree/feat%2Fbilling`);
		expect(prLink("https://git.acme.dev/a/b", "3")).toBe(
			"https://git.acme.dev/a/b/pull/3",
		);
	});

	test("GitLab uses /-/merge_requests and /-/tree", () => {
		expect(prLink(gl, "12")).toBe(`${gl}/-/merge_requests/12`);
		expect(branchLink(gl, "main")).toBe(`${gl}/-/tree/main`);
		expect(prLink("https://gitlab.corp.example/g/r", "1")).toBe(
			"https://gitlab.corp.example/g/r/-/merge_requests/1",
		);
		expect(branchLink("https://gitlab-ee.corp.example/g/r", "x")).toBe(
			"https://gitlab-ee.corp.example/g/r/-/tree/x",
		);
	});

	test("branch names are encoded, never markup or path tricks", () => {
		expect(branchLink(gh, "fix/<script>x</script>")).toBe(
			`${gh}/tree/fix%2F%3Cscript%3Ex%3C%2Fscript%3E`,
		);
		expect(branchLink(gh, "../../evil")).toBe(`${gh}/tree/..%2F..%2Fevil`);
		expect(branchLink(gh, "a#b?c")).toBe(`${gh}/tree/a%23b%3Fc`);
	});

	test("a trailing slash on the repo page is dropped", () => {
		expect(prLink(`${gh}/`, "1")).toBe(`${gh}/pull/1`);
	});

	test("no repo, an odd repo or an odd PR value gives null", () => {
		for (const bad of [
			null,
			undefined,
			"",
			"javascript:alert(1)",
			"data:text/html,x",
			"ftp://h.example/a/b",
			"https://user:tok@github.com/a/b",
			"not a url",
		]) {
			expect(repoLink(bad)).toBeNull();
			expect(prLink(bad, "1")).toBeNull();
			expect(branchLink(bad, "main")).toBeNull();
		}
		expect(prLink(gh, null)).toBeNull();
		expect(prLink(gh, "")).toBeNull();
		expect(prLink(gh, "12abc")).toBeNull();
		expect(prLink(gh, "../1")).toBeNull();
		expect(branchLink(gh, "")).toBeNull();
		expect(branchLink(gh, null)).toBeNull();
	});
});

describe("PR numbers in transcript prose", () => {
	const repo = "https://github.com/acme/apparish";
	test("links #1234 in prose to the agent's repo", () => {
		expect(linkPrs("Opened PR #1402, then (#12).", repo)).toBe(
			`Opened PR [#1402](${repo}/pull/1402), then ([#12](${repo}/pull/12)).`,
		);
		expect(linkPrs("#7 is first", repo)).toBe(`[#7](${repo}/pull/7) is first`);
	});

	test("leaves code, links, URLs, words and other repos alone", () => {
		const keep = [
			"run `gh pr view #1402`",
			"```\nfix #1402\n```",
			"see [PR #12](https://example.com/x)",
			"https://github.com/acme/apparish/pull/9#issuecomment-1",
			"color #fff and issue#12",
			"C# 12",
		];
		for (const s of keep) expect(linkPrs(s, repo)).toBe(s);
	});

	test("no repo page, no links", () => {
		expect(linkPrs("PR #1402", null)).toBe("PR #1402");
		expect(linkPrs("PR #1402", "file:///repo")).toBe("PR #1402");
	});

	test("GitLab: merge requests", () => {
		expect(linkPrs("MR #3", "https://gitlab.com/g/p")).toBe(
			"MR [#3](https://gitlab.com/g/p/-/merge_requests/3)",
		);
	});
});
