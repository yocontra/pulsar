import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	readClaude,
	readCodex,
	readOpencode,
} from "../src/harnesses/screens.ts";

/** Captures of the installed CLIs (`capture-pane -p -e -J`), recorded in a private tmux server. */
const pane = (name: string) =>
	readFileSync(join(import.meta.dir, "fixtures", "panes", name), "utf8");

describe("Claude Code 2.1.330 screen", () => {
	test.each([
		["claude-2.1.330-default.ansi", "default"],
		["claude-2.1.330-acceptEdits.ansi", "acceptEdits"],
		["claude-2.1.330-plan.ansi", "plan"],
		["claude-2.1.330-auto.ansi", "auto"],
		["claude-2.1.330-auto-startup.ansi", "auto"],
	])("%s shows %s with an empty input (placeholder)", (file, mode) => {
		expect(readClaude(pane(file))).toEqual({
			recognized: true,
			mode,
			input: "empty",
		});
	});

	test("a named session: the name sits in the top rule", () => {
		expect(readClaude(pane("claude-2.1.330-named.ansi"))).toEqual({
			recognized: true,
			mode: "auto",
			input: "empty",
		});
	});

	test("typed text is a draft", () => {
		expect(readClaude(pane("claude-2.1.330-draft.ansi"))).toMatchObject({
			recognized: true,
			mode: "plan",
			input: "draft",
		});
	});

	test("an open slash menu: the input holds the typed command", () => {
		// The menu's own `❯` row is indented; the input line is the one read.
		expect(readClaude(pane("claude-2.1.330-slash-menu.ansi"))).toMatchObject({
			recognized: true,
			input: "draft",
		});
	});

	test("the folder-trust dialog is not a prompt screen", () => {
		expect(readClaude(pane("claude-2.1.330-trust-dialog.txt")).recognized).toBe(
			false,
		);
	});

	test("bypass and don't-ask footers, and the older default (hint only)", () => {
		const box = (footer: string) =>
			`${"─".repeat(40)}\n❯ \n${"─".repeat(40)}\n  ${footer}\n`;
		expect(
			readClaude(box("⏵⏵ bypass permissions on (shift+tab to cycle)")).mode,
		).toBe("bypassPermissions");
		expect(readClaude(box("⏵⏵ don't ask on")).mode).toBe("dontAsk");
		expect(readClaude(box("? for shortcuts")).mode).toBe("default");
		expect(readClaude(box("something new")).mode).toBeNull();
	});

	test("nothing at all is unrecognized", () => {
		expect(readClaude("").recognized).toBe(false);
		expect(readClaude("$ ls\nfoo\n").recognized).toBe(false);
	});
});

describe("Codex 0.171.0 screen", () => {
	test("default and plan", () => {
		expect(readCodex(pane("codex-0.171.0-default.ansi"))).toEqual({
			recognized: true,
			mode: "default",
			input: "empty",
		});
		expect(readCodex(pane("codex-0.171.0-plan.ansi"))).toEqual({
			recognized: true,
			mode: "plan",
			input: "empty",
		});
	});

	test("a draft", () => {
		expect(readCodex(pane("codex-0.171.0-draft.ansi")).input).toBe("draft");
	});

	test("the trust prompt is not the composer", () => {
		const trust =
			"Trust this folder?\n› 1. Trust and continue\n  2. Back\n  enter continue · esc back\n";
		expect(readCodex(trust).recognized).toBe(false);
	});
});

describe("OpenCode 2.2.5 screen", () => {
	test("build and plan, placeholder input", () => {
		expect(readOpencode(pane("opencode-2.2.5-build.ansi"))).toEqual({
			recognized: true,
			mode: "build",
			input: "empty",
		});
		expect(readOpencode(pane("opencode-2.2.5-plan.ansi"))).toEqual({
			recognized: true,
			mode: "plan",
			input: "empty",
		});
	});

	test("typed text is a draft", () => {
		const raw = pane("opencode-2.2.5-build.ansi").replace(
			"\x1b[38;2;128;128;128mAsk anything…",
			"\x1b[38;2;238;238;238mfix the tests",
		);
		expect(readOpencode(raw).input).toBe("draft");
	});
});
