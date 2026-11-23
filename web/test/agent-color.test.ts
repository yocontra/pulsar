/**
 * Subagent colors (lib/agent-color.ts): stable, the harness's color wins,
 * the same name resolves the same way from a list row, a card's call and a
 * teammate message, and every palette token is readable on every surface.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTICE_COLORS } from "../../src/transcripts/types.ts";
import {
	AGENT_COLORS,
	agentColor,
	hashedColor,
	resolveColor,
} from "../src/lib/agent-color.ts";

describe("agentColor", () => {
	test("the palette is Claude Code's teammate colors", () => {
		expect([...AGENT_COLORS].sort()).toEqual([...NOTICE_COLORS].sort());
	});

	test("the harness's color wins over the hash", () => {
		for (const c of AGENT_COLORS)
			expect(agentColor({ color: c, name: "parser" })).toBe(c);
	});

	test("an unknown color is ignored, the name decides", () => {
		expect(agentColor({ color: "chartreuse", name: "parser" })).toBe(
			hashedColor("parser"),
		);
		expect(agentColor({ color: null, name: "parser" })).toBe(
			hashedColor("parser"),
		);
	});

	test("stable: pinned values, and case and spacing do not change it", () => {
		// Pinned so a change to the hash (every subagent's color moving) is
		// a decision, not an accident.
		expect(hashedColor("Reviewer ")).toBe(hashedColor("reviewer"));
		expect(hashedColor("Find  other refresh callers")).toBe(
			hashedColor("find other refresh callers"),
		);
		expect(hashedColor("reviewer")).toBe("green");
		expect(hashedColor("Find other refresh callers")).toBe("yellow");
		expect(hashedColor("tester")).toBe("pink");
		expect(hashedColor("a")).toBe("purple");
	});

	test("names spread over the whole palette", () => {
		const seen = new Set(
			Array.from({ length: 200 }, (_, i) => hashedColor(`agent-${i}`)),
		);
		expect(seen.size).toBe(AGENT_COLORS.length);
	});

	test("no name and no color: nothing to mark", () => {
		expect(agentColor({ name: "  " })).toBeNull();
		expect(agentColor({})).toBeNull();
	});
});

describe("resolveColor", () => {
	const rows = [
		{ name: "parser", color: "blue", callId: "toolu_1" },
		{ name: "Find other refresh callers", color: null, callId: "toolu_2" },
		{ name: "old-mate", color: null, callId: null },
	];

	test("a card finds its row by the call that started it", () => {
		// A teammate's Agent card is titled by its description, not its name.
		expect(
			resolveColor({ rows }, { name: "Parse tags", callId: "toolu_1" }),
		).toBe("blue");
	});

	test("a message names its row", () => {
		expect(resolveColor({ rows }, { name: "Parser" })).toBe("blue");
		expect(resolveColor({ rows }, { name: "Find other refresh callers" })).toBe(
			hashedColor("Find other refresh callers"),
		);
	});

	test("a name spawned again means the live spawn, else the newest", () => {
		const again = [
			{ name: "mate", color: "red", state: "done", startedAt: 1 },
			{ name: "mate", color: "cyan", state: "idle", startedAt: 2 },
			{ name: "mate", color: "pink", state: "done", startedAt: 3 },
		];
		expect(resolveColor({ rows: again }, { name: "mate" })).toBe("cyan");
		expect(
			resolveColor(
				{ rows: again.filter((r) => r.state === "done") },
				{ name: "mate" },
			),
		).toBe("pink");
	});

	test("a teammate message's color fills in for a row with none", () => {
		const senders = new Map([["old-mate", "pink" as const]]);
		expect(resolveColor({ rows, senders }, { name: "old-mate" })).toBe("pink");
	});

	test("the same subagent resolves the same from every source", () => {
		const list = agentColor(rows[0]!);
		const card = resolveColor({ rows }, { callId: "toolu_1", name: "x" });
		const msg = resolveColor({ rows }, { name: "parser" });
		const notice = agentColor({ color: "blue", name: "parser" });
		expect(new Set([list, card, msg, notice])).toEqual(new Set(["blue"]));
	});

	test("without a list, the name alone gives the list's hashed color", () => {
		expect(resolveColor({}, { name: "reviewer" })).toBe(
			agentColor({ name: "reviewer", color: null }),
		);
	});
});

describe("palette contrast", () => {
	const css = readFileSync(
		join(import.meta.dir, "../src/styles/tokens.css"),
		"utf8",
	);
	/** The first `--name: #hex` in a block of tokens.css. */
	const block = (start: string) => {
		const i = css.indexOf(start);
		expect(i).toBeGreaterThanOrEqual(0);
		return css.slice(i, css.indexOf("\n}", i));
	};
	const hex = (src: string, name: string) => {
		const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(src);
		if (!m) throw new Error(`no ${name}`);
		return m[1]!;
	};
	const lum = (h: string) => {
		const [r, g, b] = [1, 3, 5].map((i) => {
			const c = Number.parseInt(h.slice(i, i + 2), 16) / 255;
			return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
		}) as [number, number, number];
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a: string, b: string) => {
		const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
		return (hi + 0.05) / (lo + 0.05);
	};
	const SURFACES = [
		"ds-bg",
		"ds-surface",
		"ds-surface-2",
		"ds-surface-3",
		"ds-surface-selected",
	];
	const themes = {
		light: block(":root {"),
		"dark (system)": block("@media (prefers-color-scheme: dark)"),
		"dark (forced)": block(':root[data-theme="dark"] {'),
	};

	for (const [theme, src] of Object.entries(themes))
		test(`every color is at least 3:1 on every surface, ${theme}`, () => {
			const low: string[] = [];
			for (const c of AGENT_COLORS)
				for (const s of SURFACES) {
					const r = ratio(hex(src, `ds-agent-${c}`), hex(src, s));
					if (r < 3) low.push(`${c} on ${s}: ${r.toFixed(2)}`);
				}
			expect(low).toEqual([]);
		});
});
