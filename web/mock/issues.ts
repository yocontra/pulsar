/**
 * Mock issue cards (src/service/issues.ts): the issue an agent's `issue:`
 * tag names. apparish-auth works on #1378 (open, labels, assignees, a
 * Markdown body). `/__mock/issue` makes gh answer logged out or not found
 * (the e2e tests).
 */
import type { IssueDetails, IssueInfo } from "../../src/http/wire.ts";
import type { MockAgent } from "./data.ts";

type Mode = "ok" | "logged_out" | "not_found";
let mode: Mode = "ok";

const ISSUES: Record<number, Omit<IssueInfo, "number">> = {
	1378: {
		title: "Token refresh races with logout",
		state: "open",
		stateReason: null,
		url: "https://github.com/acme/apparish/issues/1378",
		labels: [
			{ name: "bug", color: "d73a4a" },
			{ name: "auth", color: "0e8a16" },
			{ name: "good first issue", color: "7057ff" },
		],
		assignees: ["octo", "mona"],
		author: "reporter",
		body: [
			"When a refresh is in flight and the user logs out, the old token is",
			"written back and the session **comes back to life**.",
			"",
			"### Steps",
			"1. Sign in",
			"2. Wait for the refresh",
			"3. Log out during the refresh",
			"",
			"```ts",
			"await refresh(); // writes the stale token",
			"```",
			"",
			"See the [auth notes](https://example.com/notes).",
		].join("\n"),
		truncated: true,
		updatedAt: "2026-11-20T10:00:00Z",
	},
};

/** The `issue:` tag's number on an agent, or null. */
function tagged(a: MockAgent): number | null {
	const t = a.tags.find((t) => t.startsWith("issue:"));
	const n = t ? Number(t.slice(6)) : Number.NaN;
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** `GET /agents/:id/issue`. */
export function issueDetails(a: MockAgent, id: string): IssueDetails {
	const n = tagged(a);
	if (!n) return { agent: id, number: null, issue: null, reason: "no_issue" };
	const source = a.tags.includes(`branch:fix-${n}`) ? "branch" : "tag";
	const base = { agent: id, number: n, source } as const;
	if (mode === "logged_out")
		return { ...base, issue: null, reason: "gh_logged_out" };
	const known = ISSUES[n];
	if (mode === "not_found" || !known)
		return { ...base, issue: null, reason: "not_found" };
	return { ...base, issue: { number: n, ...known } };
}

/** `POST /__mock/issue`: how gh answers next. */
export function issueControl(b: { mode?: unknown }) {
	mode = b.mode === "logged_out" || b.mode === "not_found" ? b.mode : "ok";
	return { mode };
}
