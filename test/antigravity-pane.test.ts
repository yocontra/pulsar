import { describe, expect, test } from "bun:test";
import {
	hasAntigravityPane,
	matchesAntigravityDraft,
	withAntigravityPane,
} from "../src/harnesses/antigravity-pane.ts";
import { readScreen } from "../src/harnesses/screens.ts";
import type { Agent } from "../src/types.ts";

const rule = "─".repeat(80);
const idle = "? for shortcuts                        Gemini 3.1 Pro · low";
const read = (body: string, footer = idle, prefix = "") =>
	readScreen("antigravity", `${prefix}${rule}\n${body}\n${rule}\n${footer}\n`);

describe("native Antigravity terminal", () => {
	test("reads only the composer, including a multiline paste", () => {
		expect(read(">")).toMatchObject({ input: "empty", mode: "default" });
		expect(read("> text   \n  second    \n  third")).toMatchObject({
			input: "draft",
			draft: "text\nsecond\nthird",
		});
		const hint = "Plan mode: research & plan only (shift+tab to cycle)";
		const plan =
			"? for shortcuts                           plan · Gemini 3.1 Pro · low";
		expect(read(`> ${hint}`, plan)).toMatchObject({
			input: "draft",
			mode: "plan",
		});
		expect(read(`> \x1b[90m${hint}\x1b[39m   `, plan)).toMatchObject({
			input: "empty",
			mode: "plan",
		});
		expect(read("Approve this command?")).toMatchObject({ recognized: false });
	});
	test("matches a word-wrapped paste without dropping characters or real line breaks", () => {
		expect(
			matchesAntigravityDraft(
				"one word\nwrap\nsecond\nline",
				"one word wrap\nsecond line",
			),
		).toBe(true);
		expect(matchesAntigravityDraft("word\nwrap", "wordwrap")).toBe(true);
		expect(matchesAntigravityDraft("one extra word", "one word")).toBe(false);
		expect(matchesAntigravityDraft("one two", "one\ntwo")).toBe(false);
		expect(matchesAntigravityDraft("one\ntwo\nextra", "one two")).toBe(false);
	});
	test("Escape cancels only at a confirmed active turn", () => {
		const cancel = "esc to cancel                        Gemini 3.1 Pro · low";
		expect(read(">", cancel, "⡿  Generating...\n")).toMatchObject({
			busy: true,
			input: "empty",
		});
		expect(read(">", cancel)).toMatchObject({ recognized: false });
		expect(read("> draft", cancel, "⡿  Generating...\n")).toMatchObject({
			busy: true,
			input: "draft",
		});
		expect(
			readScreen(
				"antigravity",
				`${rule}\n> /agents\n${rule}\n> /agents   List agents\n  ↑/↓ Navigate · enter Select · tab Complete\n${cancel}`,
			),
		).toMatchObject({ draft: "/agents" });
	});
	test("limits targets to a parent's exact ID and pane and serializes that session", async () => {
		const agent = {
			pid: 12,
			sessionId: "abcdef12-3456-7890-abcd-ef1234567890",
			meta: { tmux: "%1" },
		} as unknown as Agent;
		expect(hasAntigravityPane(agent)).toBe(true);
		expect(
			hasAntigravityPane({
				...agent,
				meta: { ...agent.meta, subagentOf: "parent" },
			}),
		).toBe(false);
		expect(hasAntigravityPane({ ...agent, sessionId: "pid:12" })).toBe(false);
		expect(hasAntigravityPane({ ...agent, meta: {} })).toBe(false);
		const order: string[] = [];
		const gate = Promise.withResolvers<void>();
		const first = withAntigravityPane("test", async () => {
			await gate.promise;
			order.push("a");
		});
		const second = withAntigravityPane("test", async () => {
			order.push("b");
		});
		gate.resolve();
		await Promise.all([first, second]);
		expect(order).toEqual(["a", "b"]);
	});
});
