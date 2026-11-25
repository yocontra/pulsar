import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { harnessKey, harnessName } from "../src/components/ui/agent-avatar.tsx";
import {
	ago,
	badgeCount,
	duration,
	needYou,
	noun,
	plural,
	STATUS_LABEL,
} from "../src/lib/format.ts";
import { createHighlighter } from "../src/lib/shiki.ts";
import { wakeSummary } from "../src/lib/wake.ts";
import { diffRows } from "../src/session/Diff.tsx";
import { langForPath, langLabel } from "../src/session/highlight.tsx";
import { editTexts } from "../src/session/items.ts";
import { peerFrom, userAuthor } from "../src/session/messages.ts";
import { toolKind, toolLabel } from "../src/session/ToolCard.tsx";

describe("format: counts read like English", () => {
	test("plural and noun", () => {
		expect(plural(0, "machine")).toBe("0 machines");
		expect(plural(1, "machine")).toBe("1 machine");
		expect(plural(2, "machine")).toBe("2 machines");
		expect(plural(2841, "agent")).toBe("2,841 agents");
		expect(plural(1, "match", "matches")).toBe("1 match");
		expect(plural(3, "match", "matches")).toBe("3 matches");
		expect(noun(1, "step")).toBe("step");
		expect(noun(4, "step")).toBe("steps");
	});
	test("needs you and badges", () => {
		expect(needYou(1)).toBe("1 needs you");
		expect(needYou(3)).toBe("3 need you");
		expect(badgeCount(7)).toBe("7");
		expect(badgeCount(140)).toBe("99+");
	});
	test("status labels are human words, not enum values", () => {
		expect(Object.values(STATUS_LABEL)).toEqual([
			"Needs you",
			"Status unknown",
			"Working",
			"Idle",
			"Offline",
		]);
	});
	test("relative time and durations", () => {
		const now = new Date(2026, 10, 17, 15, 0, 0).getTime();
		expect(ago(now - 2_000, now)).toBe("now");
		expect(ago(now - 12_000, now)).toBe("12s ago");
		expect(ago(now - 4 * 60_000, now)).toBe("4 min ago");
		expect(ago(now - 3 * 3_600_000, now)).toBe("3 h ago");
		expect(ago(now - 24 * 3_600_000, now)).toBe("yesterday");
		expect(duration(3100)).toBe("3.1 s");
		expect(duration(48_000)).toBe("48 s");
		expect(duration(4 * 60_000)).toBe("4 min");
		expect(duration(80 * 60_000)).toBe("1 h 20 min");
	});
	test("wake summary leaves out zeros and agrees in number", () => {
		expect(wakeSummary({ wakes: 1, held: 0 })).toBe("1 wakes now");
		expect(wakeSummary({ wakes: 40, "inbox-only": 2 })).toBe(
			"40 wake now · 2 inbox only",
		);
	});
});

describe("harness marks", () => {
	test("known harnesses map to their mark and name", () => {
		expect(harnessKey("claude-code")).toBe("claude");
		expect(harnessKey("Claude")).toBe("claude");
		expect(harnessKey("codex")).toBe("codex");
		expect(harnessKey("opencode")).toBe("opencode");
		expect(harnessKey("pi")).toBe("pi");
		expect(harnessKey("omp")).toBe("omp");
		expect(harnessKey("cursor-agent")).toBe("cursor");
		expect(harnessKey("gemini-cli")).toBe("gemini");
		expect(harnessName("claude")).toBe("Claude Code");
	});
	test("unknown harnesses fall back without crashing", () => {
		expect(harnessKey("aider")).toBe("other");
		expect(harnessKey(null)).toBe("other");
		expect(harnessName("aider")).toBe("aider");
		expect(harnessName(undefined)).toBe("Agent");
	});
});

describe("conversation helpers", () => {
	test("authorship labels", () => {
		expect(userAuthor("you via pulsar (studio)")).toEqual({
			name: "You",
			via: "via Pulsar · studio",
		});
		expect(userAuthor(undefined)).toEqual({ name: "You" });
		expect(userAuthor("ci-bot")).toEqual({ name: "ci-bot" });
		expect(peerFrom("codex@apparish · m_7a1")).toBe("codex@apparish");
	});
	test("tool kinds and labels", () => {
		expect(toolKind("Bash")).toBe("shell");
		expect(toolKind("exec_command")).toBe("shell");
		expect(toolKind("Edit")).toBe("edit");
		expect(toolKind("Write")).toBe("write");
		expect(toolKind("Grep")).toBe("search");
		expect(toolKind("TodoWrite")).toBe("todo");
		expect(toolKind("mcp__pulsar__send")).toBe("mcp");
		expect(toolKind("apply_patch")).toBe("patch");
		expect(toolKind("FrobnicateWidget")).toBe("other");
		expect(toolLabel("mcp__pulsar__send")).toBe("pulsar.send");
		expect(toolLabel("NotebookEdit")).toBe("Notebook edit");
	});
	test("edit texts and diff rows", () => {
		const t = editTexts("Edit", {
			old_string: "a\nb\nc",
			new_string: "a\nB\nc\nd",
		})!;
		const d = diffRows(t.before, t.after);
		expect(d.added).toBe(2);
		expect(d.removed).toBe(1);
		expect(d.rows.filter((r) => r.sign === "+").map((r) => r.text)).toEqual([
			"B",
			"d",
		]);
		expect(editTexts("Write", { content: "x" })).toEqual({
			before: "",
			after: "x",
			created: true,
		});
		expect(editTexts("Read", { file_path: "a" })).toBeNull();
	});
	test("languages from paths, labels for people", () => {
		expect(langForPath("src/auth/session.ts")).toBe("typescript");
		expect(langForPath("Dockerfile")).toBe("dockerfile");
		expect(langForPath("notes.txt")).toBeNull();
		expect(langLabel("ts")).toBe("TypeScript");
		expect(langLabel(null)).toBe("Text");
	});
});

describe("pulsar code theme", () => {
	test("bash highlights with the app's CSS variables", async () => {
		const h = await createHighlighter({ langs: ["bash"], themes: ["pulsar"] });
		const { tokens } = h.codeToTokens(
			'git diff --stat && BUN_ENV=test bun test "auth" | tee /tmp/run.log',
			{ lang: "bash", theme: "pulsar" },
		);
		const colors = new Set(tokens[0]!.map((t) => t.color));
		expect(colors.size).toBeGreaterThan(2);
		for (const c of colors) expect(c).toMatch(/^var\(--ds-/);
	});
});

describe("tokens", () => {
	const css = readFileSync(
		new URL("../src/styles/tokens.css", import.meta.url),
		"utf8",
	);
	const block = (start: string) => {
		const i = css.indexOf(start);
		const body = css.slice(css.indexOf("{", i + start.length - 1) + 1);
		const decls = new Map<string, string>();
		let depth = 0;
		let buf = "";
		for (const ch of body) {
			if (ch === "{") depth++;
			if (ch === "}") {
				if (depth === 0) break;
				depth--;
			}
			buf += ch;
		}
		for (const m of buf.matchAll(/(--ds-[\w-]+):\s*([^;]+);/g))
			decls.set(m[1]!, m[2]!.replace(/\s+/g, " ").trim());
		return decls;
	};
	test("forced dark matches system dark", () => {
		const media = block(':root:not([data-theme="light"]) {');
		const forced = block(':root[data-theme="dark"] {');
		expect(media.size).toBeGreaterThan(50);
		expect(Object.fromEntries(forced)).toEqual(Object.fromEntries(media));
	});
	test("every dark token has a light value", () => {
		const light = block(":root {");
		for (const k of block(':root[data-theme="dark"] {').keys())
			expect(light.has(k)).toBe(true);
	});
});

describe("tokens: WCAG AA contrast", () => {
	const css = readFileSync(
		new URL("../src/styles/tokens.css", import.meta.url),
		"utf8",
	);
	const decls = (start: string) => {
		const i = css.indexOf(start);
		let j = css.indexOf("{", i) + 1;
		let depth = 0;
		let body = "";
		for (; j < css.length; j++) {
			const ch = css[j]!;
			if (ch === "{") depth++;
			if (ch === "}") {
				if (depth === 0) break;
				depth--;
			}
			body += ch;
		}
		const m = new Map<string, string>();
		for (const d of body.matchAll(/(--ds-[\w-]+):\s*([^;]+);/g))
			m.set(d[1]!, d[2]!.replace(/\s+/g, " ").trim());
		return m;
	};
	const light = decls(":root {");
	const dark = new Map([...light, ...decls(':root[data-theme="dark"] {')]);
	type RGB = [number, number, number];
	const color = (v: string, t: Map<string, string>, under: RGB): RGB => {
		const ref = /^var\((--ds-[\w-]+)\)$/.exec(v);
		if (ref) return color(t.get(ref[1]!)!, t, under);
		if (v.startsWith("#"))
			return [1, 3, 5].map((i) =>
				Number.parseInt(v.slice(i, i + 2), 16),
			) as RGB;
		const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(
			v,
		);
		if (!m) throw new Error(`can't parse ${v}`);
		const a = Number(m[4] ?? 1);
		return [1, 2, 3].map(
			(i, k) => a * Number(m[i]) + (1 - a) * under[k]!,
		) as RGB;
	};
	const lum = (c: RGB) => {
		const [r, g, b] = c.map((x) => {
			const s = x / 255;
			return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
		}) as RGB;
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	const ratio = (a: RGB, b: RGB) => {
		const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
		return (x + 0.05) / (y + 0.05);
	};
	const PAIRS: [string, string][] = [
		["--ds-text", "--ds-bg"],
		["--ds-text-2", "--ds-surface-3"],
		["--ds-text-3", "--ds-bg"],
		["--ds-text-3", "--ds-surface"],
		["--ds-text-3", "--ds-surface-2"],
		["--ds-text-3", "--ds-code-head"],
		["--ds-busy-text", "--ds-busy-soft"],
		["--ds-needs-text", "--ds-needs-soft"],
		["--ds-danger-text", "--ds-danger-soft"],
		["--ds-success-text", "--ds-success-soft"],
		["--ds-peer-text", "--ds-peer-soft"],
		["--ds-accent-text", "--ds-surface"],
		["--ds-link", "--ds-bg"],
		["--ds-on-primary", "--ds-primary"],
		["--ds-on-needs", "--ds-needs-badge"],
		["--ds-code-inline-text", "--ds-surface"],
		["--ds-syn-fg", "--ds-code-bg"],
		["--ds-syn-comment", "--ds-code-bg"],
		["--ds-syn-keyword", "--ds-code-bg"],
		["--ds-syn-string", "--ds-code-bg"],
		["--ds-syn-function", "--ds-code-bg"],
		["--ds-syn-type", "--ds-code-bg"],
		["--ds-syn-number", "--ds-code-bg"],
		["--ds-syn-variable", "--ds-code-bg"],
		["--ds-diff-add-text", "--ds-diff-add-bg"],
		["--ds-diff-del-text", "--ds-diff-del-bg"],
	];
	for (const [name, t] of [
		["light", light],
		["dark", dark],
	] as const)
		test(`${name}: text pairs reach 4.5:1`, () => {
			const page = color(t.get("--ds-bg")!, t, [255, 255, 255]);
			const low: string[] = [];
			for (const [fg, bg] of PAIRS) {
				const b = color(t.get(bg)!, t, page);
				const f = color(t.get(fg)!, t, b);
				const r = ratio(f, b);
				if (r < 4.5) low.push(`${fg} on ${bg}: ${r.toFixed(2)}`);
			}
			expect(low).toEqual([]);
		});
});
