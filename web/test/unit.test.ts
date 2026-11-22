import { describe, expect, test } from "bun:test";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";
import {
	installedApp,
	mobilePlatform,
	normalizeSend,
} from "../src/api/client.ts";
import type { TranscriptEvent } from "../src/api/types.ts";
import { visible } from "../src/approval/visible.ts";
import { parseHash } from "../src/lib/hash.ts";
import { parse, serialize, toggle } from "../src/lib/selector.ts";
import { bundledLanguages, createHighlighter } from "../src/lib/shiki.ts";
import { dollarGuard } from "../src/session/dollars.ts";
import {
	buildItems,
	chronological,
	mergeHistory,
	mergeLive,
} from "../src/session/items.ts";
import { isTranscriptMedia } from "../src/session/streamdown.tsx";

const ev = (
	id: string,
	ts: number,
	extra: Partial<TranscriptEvent> = {},
): TranscriptEvent => ({
	id,
	ts,
	role: "assistant",
	kind: "text",
	text: id,
	...extra,
});

describe("selector model", () => {
	test("round-trips facets, alternatives, text and raw terms", () => {
		for (const s of [
			"*",
			"project=apparish machine=studio|desk",
			"role=reviewer ~1378",
			"codex@apparish",
			"pr=1402 role=author ~auth",
		]) {
			const { query, error } = parse(s);
			expect(error).toBeNull();
			expect(serialize(query)).toBe(s);
		}
	});
	test("toggle adds and removes alternatives within a key", () => {
		let q = parse("project=apparish").query;
		q = toggle(q, "machine", "studio");
		q = toggle(q, "machine", "desk");
		expect(serialize(q)).toBe("project=apparish machine=studio|desk");
		q = toggle(q, "machine", "studio");
		q = toggle(q, "machine", "desk");
		expect(serialize(q)).toBe("project=apparish");
		expect(serialize(q, "project")).toBe("*");
	});
	test("flags terms without a key or value", () => {
		expect(parse("=x").error).not.toBeNull();
		expect(parse("project=").error).not.toBeNull();
	});
});

describe("visible()", () => {
	test("marks spaces, newlines, tabs, control, zero-width and bidi characters", () => {
		const out = visible("rm -rf\tx\necho ‮txt​\u0007")
			.map((p) => p.text)
			.join("");
		expect(out).toBe("rm·-rf→x\\necho·<U+202E>txt<U+200B><U+0007>");
	});
	test("leaves no invisible character in the output", () => {
		const out = visible("a⁦b⁩c﻿d\u{E0041}")
			.map((p) => p.text)
			.join("");
		expect(out).toBe("a<U+2066>b<U+2069>c<U+FEFF>d<U+E0041>");
	});
});

describe("transcript merge rules", () => {
	const call = ev("c1", 2, {
		kind: "tool_call",
		tool: { name: "Bash", callId: "x" },
	});
	const folded = {
		...call,
		tool: { name: "Bash", callId: "x", summary: "4 passed" },
	};

	test("live events replace by id and append new ones", () => {
		const { events, added } = mergeLive(
			[ev("a", 1), call],
			[folded, ev("b", 3)],
		);
		expect(events.map((e) => e.id)).toEqual(["a", "c1", "b"]);
		expect(events[1]!.tool?.summary).toBe("4 passed");
		expect(added).toBe(1);
	});
	test("a history page never overwrites what we hold", () => {
		const held = [folded, ev("b", 3)];
		const merged = mergeHistory(held, [ev("a", 1), call]);
		expect(merged.map((e) => e.id)).toEqual(["a", "c1", "b"]);
		expect(merged[1]!.tool?.summary).toBe("4 passed");
	});
	test("a refetched newest page keeps older held events in front", () => {
		// Held: 1..5 (5 is live, folded). A gap refetch returns the newest page 4..7.
		const held = [
			ev("1", 1),
			ev("2", 2),
			ev("3", 3),
			ev("4", 4),
			{ ...ev("5", 5), text: "live" },
		];
		const page = [ev("4", 4), ev("5", 5), ev("6", 6), ev("7", 7)];
		const merged = mergeHistory(held, page);
		expect(merged.map((e) => e.id)).toEqual([
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
		]);
		expect(merged[4]!.text).toBe("live");
	});
	test("a page with no overlap goes before newer held events", () => {
		const merged = mergeHistory(
			[ev("9", 9), ev("10", 10)],
			[ev("1", 1), ev("2", 2)],
		);
		expect(merged.map((e) => e.id)).toEqual(["1", "2", "9", "10"]);
	});
	test("newest-first pages render oldest-first", () => {
		expect(chronological([ev("b", 2), ev("a", 1)]).map((e) => e.id)).toEqual([
			"a",
			"b",
		]);
	});
	test("tool calls pair with results; sidechains fold under their Task", () => {
		const items = buildItems([
			ev("t", 1, { kind: "tool_call", tool: { name: "Task", callId: "T" } }),
			ev("g", 2, {
				kind: "tool_call",
				tool: { name: "Grep", callId: "G" },
				sidechain: "T",
			}),
			ev("gr", 3, {
				kind: "tool_result",
				role: "tool",
				tool: { name: "Grep", callId: "G", summary: "2" },
				sidechain: "T",
			}),
			ev("tr", 4, {
				kind: "tool_result",
				role: "tool",
				tool: { name: "Task", callId: "T" },
			}),
		]);
		expect(items).toHaveLength(1);
		const task = items[0]!;
		expect(task.t).toBe("task");
		if (task.t === "task") {
			expect(task.steps).toBe(1);
			expect(task.result?.id).toBe("tr");
			expect(task.children[0]?.t).toBe("tool");
		}
	});
});

describe("send results", () => {
	test("a dry run keeps counts, breakdown and token", () => {
		const r = normalizeSend({
			dryRun: true,
			count: 37,
			machines: 2,
			breakdown: [
				{ machineId: "m1", machine: "studio", count: 30 },
				{ machineId: "m2", machine: "desk", count: 7 },
			],
			totals: { wakes: 33, "inbox-only": 2, held: 1, refuses: 0, queued: 1 },
			resolveToken: "rt_1",
			expiresAt: 0,
			preview: [],
		});
		expect(r.total).toBe(37);
		expect(r.machines).toBe(2);
		expect(r.counts.wakes).toBe(33);
		expect(r.resolveToken).toBe("rt_1");
		expect(r.breakdown.map((b) => b.machine)).toEqual(["studio", "desk"]);
		expect(r.messageId).toBeUndefined();
	});
	test("a send gives the message id and receipt counts", () => {
		const r = normalizeSend({
			dryRun: false,
			message: {
				id: "m_1",
				threadId: "m_1",
				fromId: "user:me",
				fromName: "user",
				to: "project=x",
				body: "hi",
				priority: "normal",
				replyTo: null,
				expectReply: false,
				createdAt: 0,
			},
			count: 2,
			totals: { sent: 2 },
			receipts: [
				{
					messageId: "m_1",
					agentId: "a",
					agentName: "a",
					state: "sent",
					via: null,
					detail: null,
					updatedAt: 0,
					machineId: "m1",
					machine: "studio",
				},
			],
		});
		expect(r.messageId).toBe("m_1");
		expect(r.total).toBe(2);
		expect(r.counts.sent).toBe(2);
		expect(r.machines).toBe(1);
	});
});

describe("bundled shiki", () => {
	test("common languages and aliases, nothing else", () => {
		for (const lang of [
			"ts",
			"tsx",
			"js",
			"jsx",
			"json",
			"bash",
			"sh",
			"python",
			"go",
			"rust",
			"swift",
			"kotlin",
			"java",
			"c",
			"cpp",
			"css",
			"html",
			"md",
			"yaml",
			"toml",
			"sql",
			"diff",
			"dockerfile",
		])
			expect(lang in bundledLanguages).toBe(true);
		expect("cobol" in bundledLanguages).toBe(false);
		expect("haskell" in bundledLanguages).toBe(false);
	});

	test("an unknown fence language renders as plain text", async () => {
		const h = await createHighlighter({
			langs: ["typescript"],
			themes: ["github-light", "github-dark"],
		});
		await expect(
			createHighlighter({ langs: ["cobol"], themes: ["github-light"] }),
		).rejects.toThrow();
		const plain = h.codeToTokens("IDENTIFICATION DIVISION.", {
			lang: "text",
			themes: { light: "github-light", dark: "github-dark" },
		});
		expect(plain.tokens[0]!.map((t) => t.content).join("")).toBe(
			"IDENTIFICATION DIVISION.",
		);
		const ts = h.codeToTokens("const x: number = 1", {
			lang: "ts",
			themes: { light: "github-light", dark: "github-dark" },
		});
		// Highlighted means more than one color, not a token count (shiki's
		// tokenization of this line varies between 3 and more tokens).
		const colors = new Set(
			ts.tokens[0]!.map((t) => JSON.stringify(t.htmlStyle ?? t.color)),
		);
		expect(colors.size).toBeGreaterThan(1);
	});
});

describe("single-dollar math", () => {
	const math = (text: string) => {
		const p = unified()
			.use(remarkParse)
			.use(remarkMath, { singleDollarTextMath: true })
			.use(dollarGuard);
		const tree = p.runSync(p.parse(text), text) as {
			children?: unknown[];
		};
		const found: string[] = [];
		const walk = (n: {
			type?: string;
			value?: string;
			children?: unknown[];
		}) => {
			if (n.type === "inlineMath" || n.type === "math")
				found.push(n.value ?? "");
			for (const c of n.children ?? []) walk(c as typeof n);
		};
		walk(tree);
		return found;
	};

	test("$x$ is math", () => {
		expect(math("$x$")).toEqual(["x"]);
		expect(math("so $x^2$ and $y$ hold")).toEqual(["x^2", "y"]);
		expect(math("$$e = mc^2$$")).toEqual(["e = mc^2"]);
	});

	test("prices and shell variables stay text", () => {
		for (const t of [
			"$5 and $6",
			"costs $5",
			"was $5.00, now $6.00",
			"between $5 and $10 per seat",
			"price $5, tax $1 total",
			"use $HOME and $PATH",
			"$x$5",
		])
			expect(math(t)).toEqual([]);
	});
});

describe("hardening", () => {
	test("approval text marks look-alike spaces", () => {
		expect(visible("rm\u00a0-rf").map((p) => p.text)).toEqual([
			"rm",
			"<U+00A0>",
			"-rf",
		]);
		expect(
			visible("a\u2009b\u3000c").filter((p) => p.mark === "ctl"),
		).toHaveLength(2);
	});
	test("markdown images fetch only the transcript media route", () => {
		expect(
			isTranscriptMedia("/api/v1/agents/claude%3Ax/transcript/images/img_1"),
		).toBe(true);
		// An agent's `![x](/api/v1/events)` must not open the event stream.
		for (const p of [
			"/api/v1/events",
			"/api/v1/agents",
			"/api/v1/agents/a/transcript",
			"/api/v1/agents/a/transcript/images/x/extra",
			"/api/v1/agents/a/b/transcript/images/x",
		])
			expect(isTranscriptMedia(p)).toBe(false);
	});
	test("a malformed hash shows home instead of crashing", () => {
		expect(parseHash("#/a/%E0")).toEqual({ view: "home" });
		expect(parseHash("#/a/claude%3Ax")).toEqual({
			view: "agent",
			id: "claude:x",
		});
	});
	test("an old #/ask link (Ask was removed) shows home", () => {
		expect(parseHash("#/ask")).toEqual({ view: "home" });
		expect(parseHash("#/ask/x")).toEqual({ view: "home" });
	});
});

describe("session token persistence (L4)", () => {
	test("only phones and tablets may keep the token across reloads", () => {
		const ua = (userAgent: string, maxTouchPoints = 0) =>
			mobilePlatform({ userAgent, maxTouchPoints });
		expect(
			ua("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari"),
		).toBe(true);
		expect(ua("Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/130")).toBe(
			true,
		);
		// iPadOS says "Macintosh", but has touch.
		expect(
			ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari", 5),
		).toBe(true);
		// Desktops: never.
		expect(
			ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130"),
		).toBe(false);
		expect(ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/131")).toBe(
			false,
		);
		expect(ua("Mozilla/5.0 (X11; Linux x86_64) Chrome/130")).toBe(false);
		expect(mobilePlatform(undefined)).toBe(false);
	});

	test("and only in the installed app, not a browser tab", () => {
		const mm = (matches: boolean) => () => ({ matches });
		expect(installedApp({ matchMedia: mm(true) })).toBe(true);
		expect(
			installedApp({ matchMedia: mm(false), navigator: { standalone: true } }),
		).toBe(true);
		expect(installedApp({ matchMedia: mm(false), navigator: {} })).toBe(false);
		expect(installedApp({})).toBe(false);
	});
});
