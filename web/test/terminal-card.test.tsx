/**
 * A prompt only the agent's terminal can answer: a read-only card with the
 * machine to go to, why the app can't answer, and the prompt's details when
 * the app had it. Never an action that looks like an answer.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRow, Approval, AttentionItem } from "../src/api/types.ts";
import TerminalCard from "../src/approval/TerminalCard.tsx";

const agent = {
	id: "claude:s1",
	name: "pg-accel-2a",
	machine: "studio",
	harness: "claude",
	project: "pg",
	needsYou: {
		reason: "terminal",
		since: 0,
		detail: "Waiting in the terminal: permission prompt",
	},
} as unknown as AgentRow;

const expired: Approval = {
	requestId: "apr_1",
	kind: "permission",
	agentId: agent.id,
	machine: "studio",
	tool: "Bash",
	input: { command: "psql -c 'vacuum'​", description: "Vacuum the db" },
	inputHash: "sha256:abc",
	cwd: "/Users/me/pg",
	branch: "main",
	createdAt: 0,
	expiresAt: 540_000,
	state: "expired",
	sessionRules: ["Bash(psql *)"],
	outcome: "Expired: the agent's own prompt decides",
};

const item = (over: Partial<AttentionItem>): AttentionItem => ({
	id: "studio/claude:s1@0",
	kind: "terminal",
	agent,
	title: "Waiting in the terminal: permission prompt",
	createdAt: 0,
	...over,
});

const html = (i: AttentionItem, mobile = false) =>
	renderToStaticMarkup(<TerminalCard item={i} mobile={mobile} />);

function noAnswer(h: string) {
	for (const word of ["Allow", "Deny", "Expires", "first answer wins"])
		expect(h).not.toContain(word);
	expect(h).not.toContain('role="timer"');
}

describe("terminal card", () => {
	test("the app's time ran out: the expired prompt, highlighted, read-only, with Copy command", () => {
		const h = html(item({ terminal: { why: "expired", approval: expired } }));
		expect(h).toContain("Answer in the terminal on studio");
		expect(h).toContain("The app&#x27;s time to answer ran out.");
		expect(h).toContain("Vacuum the db");
		expect(h).toContain("psql");
		// Hidden characters stay marked in the read-only view too.
		expect(h).toContain('class="mk mk-ctl">&lt;U+200B&gt;');
		expect(h).toContain("asks to run");
		expect(h).toContain("Copy command");
		// The session rule is an answer the terminal offers, not this card.
		expect(h).not.toContain("Bash(psql *)");
		noAnswer(h);
		// One button only: Copy command.
		expect(h.match(/<button/g)?.length).toBe(1);
	});

	test("never sent to the app: Claude's own line, no command to copy", () => {
		for (const mobile of [false, true]) {
			const h = html(item({ terminal: { why: "not-sent" } }), mobile);
			expect(h).toContain("Answer in the terminal on studio");
			expect(h).toContain("This prompt wasn&#x27;t sent to the app.");
			expect(h).toContain(
				"pg-accel-2a is waiting in its terminal: permission prompt.",
			);
			expect(h).not.toContain("<button");
			noAnswer(h);
		}
	});

	test("an agent on another machine: no reason claimed", () => {
		const h = html(item({}));
		expect(h).toContain("Answer in the terminal on studio");
		expect(h).not.toContain("ran out");
		expect(h).not.toContain("wasn&#x27;t sent");
	});
});
