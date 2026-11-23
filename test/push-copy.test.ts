import { describe, expect, test } from "bun:test";
import type { Approval, LimitWarning } from "../src/http/wire.ts";
import {
	actionLine,
	approvalNotice,
	BODY_MAX,
	clean,
	clip,
	duration,
	firstSentence,
	generic,
	limitNotice,
	plainError,
	securityNotice,
	TITLE_MAX,
	turnNotice,
	type Who,
	whoOf,
} from "../src/service/push-copy.ts";
import { summarizeTurn } from "../src/service/turn-summary.ts";
import type { TranscriptEvent } from "../src/transcripts/types.ts";

/** Synthetic data only: names, paths and tokens here are made up. */

const who: Who = { name: "auth-fix", project: "webshop", machine: null };
const REF = "AbCdEfGhIjKlMnOpQrStUv";
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

function approval(over: Partial<Approval> = {}): Approval {
	return {
		requestId: "req-1",
		agentId: "claude:s1",
		machine: "studio",
		tool: "Bash",
		input: { command: "bun test auth" },
		inputHash: "0",
		cwd: "/home/dev/webshop",
		branch: "main",
		createdAt: 0,
		expiresAt: 0,
		state: "pending",
		sessionRules: null,
		...over,
	};
}

const fits = (n: { title: string; body: string }) => {
	expect(n.title.length).toBeLessThanOrEqual(TITLE_MAX);
	expect(n.body.length).toBeLessThanOrEqual(BODY_MAX);
	expect(`${n.title} ${n.body}`).not.toContain("!");
};

describe("text helpers", () => {
	test("clip cuts at a word boundary with an ellipsis", () => {
		expect(clip("short", 10)).toBe("short");
		expect(clip("the quick brown fox jumps", 15)).toBe("the quick…");
		expect(clip("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcdefghi…");
		expect(clip("ends with a comma, then more words", 19)).toBe(
			"ends with a comma…",
		);
	});

	test("clean redacts before stripping markdown, control and bidi characters", () => {
		expect(clean(`**Done**: pushed with \`GITHUB_TOKEN=${TOKEN}\``)).toBe(
			"Done: pushed with GITHUB_TOKEN=[redacted]",
		);
		expect(clean("# Title\n- [link](https://x.test)‮evil\u0007")).toBe(
			"Title link evil",
		);
		expect(clean("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
			"Authorization: Basic [redacted]",
		);
	});

	test("firstSentence keeps file names and drops exclamation marks", () => {
		expect(firstSentence("Fixed session.ts. Then ran tests.")).toBe(
			"Fixed session.ts.",
		);
		expect(firstSentence("All green!")).toBe("All green.");
	});
});

test("duration in plain units", () => {
	expect(duration(45_000)).toBe("45 s");
	expect(duration(4 * 60_000)).toBe("4 min");
	expect(duration(65 * 60_000)).toBe("1 h 5 min");
	expect(duration(74 * 3_600_000)).toBe("3 days 2 h");
});

describe("approvals", () => {
	test("a command: who and what in the title, the command and project in the body", () => {
		const n = approvalNotice(approval(), who, REF);
		expect(n).toEqual({
			title: "auth-fix needs approval",
			body: "Run `bun test auth`? · webshop",
			tag: `agent:${REF}`,
			url: "/#/approval/claude%3As1",
		});
		fits(n);
	});

	test("a file edit shows the path relative to the project", () => {
		const n = approvalNotice(
			approval({
				tool: "Edit",
				input: {
					file_path: "/home/dev/webshop/src/auth/session.ts",
					old_string: "a",
					new_string: "b",
				},
			}),
			who,
			REF,
		);
		expect(n.body).toBe("Edit src/auth/session.ts? · webshop");
	});

	test("a secret in the command is redacted, and a long command is cut inside its backticks", () => {
		const n = approvalNotice(
			approval({
				input: {
					command: `GITHUB_TOKEN=${TOKEN} gh api repos/acme/webshop/pulls --paginate --jq '.[].title' | sort | uniq -c | sort -rn | head -50`,
				},
			}),
			who,
			REF,
		);
		expect(n.body).not.toContain("ghp_");
		expect(n.body).toContain("[redacted]");
		expect(n.body).toMatch(/^Run `[^`]+…`\? · webshop$/);
		fits(n);
	});

	test("a command keeps its globs and underscores as typed", () => {
		expect(
			actionLine("Bash", { command: "rm *.tmp *.log __pycache__" }, null),
		).toBe("Run `rm *.tmp *.log __pycache__`?");
	});

	test("an unknown tool names the tool", () => {
		expect(actionLine("FrobnicateWidget", {}, null)).toBe(
			"Use Frobnicate widget?",
		);
	});

	test("a question shows the question text, cut cleanly", () => {
		const long =
			"Which login method should the new account page offer by default, given that most existing users signed up with email links last year?";
		const n = approvalNotice(
			approval({
				kind: "question",
				prompt: {
					kind: "question",
					questions: [
						{
							id: "q",
							question: long,
							multiSelect: false,
							options: [],
							allowOther: true,
						},
						{
							id: "r",
							question: "Second?",
							multiSelect: false,
							options: [],
							allowOther: true,
						},
					],
				},
			}),
			who,
			REF,
		);
		expect(n.title).toBe("auth-fix has questions");
		expect(n.body.endsWith("· +1 more · webshop")).toBe(true);
		expect(n.body).toContain("…");
		fits(n);
	});

	test("a plan shows its first sentence without markdown", () => {
		const n = approvalNotice(
			approval({
				kind: "plan",
				prompt: {
					kind: "plan",
					plan: "## Move sessions to Redis. Then drop the table.\n\n1. step",
					choices: [],
				},
			}),
			who,
			REF,
		);
		expect(n.title).toBe("auth-fix has a plan to review");
		expect(n.body).toBe("Move sessions to Redis. · webshop");
	});

	test("a long name is cut so the verb shows; the machine shows in a pool", () => {
		const n = approvalNotice(
			approval(),
			{
				name: "refactor-the-entire-billing-pipeline-now",
				project: null,
				machine: "studio",
			},
			REF,
		);
		expect(n.title.endsWith(" needs approval")).toBe(true);
		fits(n);
		const short = approvalNotice(
			approval(),
			{ name: "api", project: null, machine: "studio" },
			REF,
		);
		expect(short.title).toBe("api on studio needs approval");
		expect(short.body).toBe("Run `bun test auth`?");
	});

	test("a presence check names the action and who asked", () => {
		const n = approvalNotice(
			approval({
				requestId: "presence.123",
				kind: "confirm",
				tool: "Pulsar",
				input: { text: "Remove passkey 'Laptop'", requester: "auth-fix" },
				prompt: {
					kind: "confirm",
					title: "Confirm: Remove passkey 'Laptop'",
					message:
						"Asked by auth-fix on studio. Confirm only if you started this.",
				},
			}),
			who,
			REF,
		);
		expect(n.title).toBe("Confirm it's you");
		expect(n.body).toBe("Remove passkey 'Laptop'? · Asked by auth-fix");
	});

	test("a remote agent's prompt links to its pool address", () => {
		const n = approvalNotice(approval({ agentId: "m2/claude:s1" }), who, REF);
		expect(n.url).toBe("/#/approval/m2%2Fclaude%3As1");
	});

	test("the project is left out when the name already says it", () => {
		const n = approvalNotice(
			approval(),
			{ name: "webshop-auth", project: "webshop", machine: null },
			REF,
		);
		expect(n.body).toBe("Run `bun test auth`?");
	});
});

describe("turns", () => {
	const at = 1_000_000;
	test("finished: first sentence of the last message, project, time and files", () => {
		const n = turnNotice(
			"finished",
			"claude:s1",
			who,
			REF,
			{
				text: "Fixed the token refresh race in session.ts. Tests pass now.",
				startedAt: at - 4 * 60_000,
				files: 3,
			},
			at,
		);
		expect(n).toEqual({
			title: "auth-fix finished",
			body: "Fixed the token refresh race in session.ts. · webshop · 4 min · 3 files changed",
			tag: `agent:${REF}`,
			url: "/#/a/claude%3As1",
		});
		fits(n);
	});

	test("a filler opener is skipped; a plan's heading is skipped for its prose", () => {
		const n = turnNotice(
			"finished",
			"a",
			who,
			REF,
			{ text: "**Done.** Fixed the redirect loop in `login.ts`." },
			at,
		);
		expect(n.body).toBe("Fixed the redirect loop in login.ts. · webshop");
		const plan = approvalNotice(
			approval({
				kind: "plan",
				prompt: {
					kind: "plan",
					plan: "# Plan\n\nMove sessions to Redis. Then more.",
					choices: [],
				},
			}),
			who,
			REF,
		);
		expect(plan.body).toBe("Move sessions to Redis. · webshop");
	});

	test("finished without a message says how long it took", () => {
		const n = turnNotice(
			"finished",
			"a",
			who,
			REF,
			{ startedAt: at - 45_000 },
			at,
		);
		expect(n.body).toBe("Took 45 s · webshop");
	});

	test("failed: the error in plain words", () => {
		const n = turnNotice(
			"failed",
			"a",
			who,
			REF,
			{
				error:
					'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
			},
			at,
		);
		expect(n.title).toBe("auth-fix stopped with an error");
		expect(n.body).toBe(
			"The model service is overloaded. Try again soon. · webshop",
		);
		fits(n);
	});

	test("plainError maps common harness errors", () => {
		expect(
			plainError("You've hit your limit · resets 3pm (Europe/Paris)"),
		).toBe("Usage limit reached. Resets 3pm.");
		expect(plainError("API Error: 500 Internal server error")).toBe(
			"The model service returned an error (500).",
		);
		expect(plainError("Prompt is too long")).toBe(
			"The conversation is too long for the model.",
		);
		expect(plainError("Invalid API key · Please run /login")).toBe(
			"Sign-in to the model service failed.",
		);
	});
});

describe("limits, security, previews off", () => {
	const w: LimitWarning = {
		harness: "claude",
		label: "Weekly",
		level: 95,
		reached: false,
		usedPercent: 96,
		resetsAt: 10_000_000 + 2 * 3_600_000 + 10 * 60_000,
	};
	test("a limit names the plan and window, and when it resets", () => {
		const n = limitNotice(w, "Claude Code", null, 10_000_000);
		expect(n).toEqual({
			title: "Claude Code at 96% of weekly limit",
			body: "Resets in 2 h 10 min. Usage page has the details.",
			tag: "limit:claude:Weekly",
			url: "/#/usage",
		});
		const reached = limitNotice(
			{ ...w, reached: true, level: 100 },
			"Claude Code",
			null,
			10_000_000,
		);
		expect(reached.title).toBe("Claude Code hit its weekly limit");
		expect(reached.body).toBe(
			"Agents pause for 2 h 10 min, until the limit resets.",
		);
		fits(reached);
	});

	test("security notices say what changed", () => {
		const n = securityNotice({
			kind: "passkey-added",
			message: "New passkey 'Laptop' added on studio",
			node: "studio",
			at: 0,
		});
		expect(n.title).toBe("New passkey added");
		expect(n.body).toBe(
			"New passkey 'Laptop' added on studio. Not you? Check Settings.",
		);
		fits(n);
	});

	test("generic copy keeps the tag and link but drops names and text", () => {
		const n = generic("approval", approvalNotice(approval(), who, REF));
		expect(n.title).toBe("Approval needed");
		expect(n.body).not.toContain("auth-fix");
		expect(n.body).not.toContain("bun test");
		expect(n.tag).toBe(`agent:${REF}`);
		expect(n.url).toBe("/#/approval/claude%3As1");
	});

	test("whoOf: the machine only in a pool; a gone agent is 'An agent'", () => {
		const agent = {
			name: "api",
			project: "webshop",
			machine: "studio",
		} as never;
		expect(whoOf({ find: () => agent, pool: null }, "x")).toEqual({
			name: "api",
			project: "webshop",
			machine: null,
		});
		expect(whoOf({ find: () => agent, pool: {} }, "x").machine).toBe("studio");
		expect(whoOf({ find: () => undefined, pool: null }, "x").name).toBe(
			"An agent",
		);
	});
});

describe("summarizeTurn", () => {
	const ev = (over: Partial<TranscriptEvent>): TranscriptEvent => ({
		id: String(Math.random()),
		ts: 0,
		role: "assistant",
		kind: "text",
		text: "",
		...over,
	});

	test("the last turn's message, start, and changed files; secrets redacted", () => {
		const s = summarizeTurn(
			[
				ev({ role: "user", text: "old prompt", ts: 1 }),
				ev({ text: "old answer" }),
				ev({ role: "user", text: "fix it", ts: 100 }),
				ev({
					kind: "tool_call",
					text: "",
					tool: { name: "Edit", callId: "1", input: { file_path: "/r/a.ts" } },
				}),
				ev({
					kind: "tool_call",
					text: "",
					tool: { name: "Write", callId: "2", input: { file_path: "/r/b.ts" } },
				}),
				ev({
					kind: "tool_call",
					text: "",
					tool: { name: "Edit", callId: "3", input: { file_path: "/r/a.ts" } },
				}),
				ev({
					kind: "tool_call",
					text: "",
					tool: { name: "Read", callId: "4", input: { file_path: "/r/c.ts" } },
				}),
				ev({ text: "sub", sidechain: "t1" }),
				ev({ text: `Done. Set API_KEY=${TOKEN} in .env` }),
			],
			false,
		);
		expect(s).toEqual({
			startedAt: 100,
			files: 2,
			text: "Done. Set API_KEY=[redacted] in .env",
		});
	});

	test("a failed turn keeps the error, not a message", () => {
		const s = summarizeTurn(
			[
				ev({ role: "user", text: "go", ts: 5 }),
				ev({ text: "API Error: 529 overloaded" }),
			],
			true,
		);
		expect(s).toEqual({ startedAt: 5, error: "API Error: 529 overloaded" });
	});
});
