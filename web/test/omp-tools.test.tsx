/**
 * omp's tool cards: the card line for each omp tool kind, and the omp
 * result formats (read selectors, grouped grep and glob output) shown in the
 * shared bodies. Built from the synthetic omp log in web/mock/blocks.ts.
 */
import { describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { galleryEvents } from "../mock/blocks.ts";
import { buildItems, type Item } from "../src/session/items.ts";

mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { ToolCard } = await import("../src/session/ToolCard.tsx");
const { OmpGlobBody, OmpGrepBody, OmpReadBody, ompGrepRows, ompRead } =
	await import("../src/session/tools/omp.tsx");

const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/\s+/g, " ");

type ToolItem = Extract<Item, { t: "tool" }>;
// Only the omp section of the gallery (ids `omp:` prefixed).
const omp = buildItems(galleryEvents((id) => `/img/${id}`)).filter(
	(i): i is ToolItem =>
		i.t === "tool" && /^omp/.test((i.call ?? i.result)?.id ?? ""),
);
const named = (name: string, nth = 0) =>
	omp.filter((t) => (t.call ?? t.result)?.tool?.name === name)[nth]!;
const head = (it: ToolItem) =>
	text(html(<ToolCard item={it} harness="omp" agentCwd="/work/demo" />));
const props = (it: ToolItem) => ({
	name: it.call!.tool!.name,
	input: it.call!.tool!.input,
	output: it.result?.text ?? "",
	detail: it.result?.tool?.detail,
	isError: !!it.result?.tool?.isError,
	layout: "unified" as const,
	done: true,
});

describe("omp: the card line per tool", () => {
	const CASES: Array<[string, number, RegExp]> = [
		["bash", 0, /Ran hyperfine 'bun parse\.ts'/],
		["bash", 1, /Ran bun bench --watch in background/i],
		["read", 0, /Read \S*src\/ parse\.ts lines 12–14/],
		["read", 1, /Read docs for issue_desk_label_issue/],
		["read", 3, /Read output of bg_2/],
		["read", 4, /Fetched docs\.example\.org \/json/],
		["edit", 0, /Edited \S*src\/ parse\.ts \+1 −1/],
		["write", 0, /Wrote \S*src\/ fast\.ts \+1/],
		["write", 1, /Sent input to bg_2/],
		["eval", 0, /Ran Python Plot latency/],
		["grep", 0, /Searched for JSON\.parse in \S*src 2 matches/],
		["glob", 0, /Listed \S*src\/\*\*\/ \*\.ts 3 files/],
		["todo", 0, /Checked off Benchmark parse/],
		["web_fetch", 0, /Fetch.*bench\.example\.org.*Failed/i],
		["goal", 0, /Goal complete/],
		["mcp__issue-desk__label_issue", 0, /Called issue-desk\.label_issue/],
	];
	for (const [name, nth, re] of CASES)
		test(`${name}${nth ? ` #${nth + 1}` : ""}`, () => {
			const it = named(name, nth);
			expect(it).toBeDefined();
			expect(head(it)).toMatch(re);
		});

	test("no omp card claims a file write to a device or a job", () => {
		const all = omp.map(head).join("\n");
		expect(all).not.toMatch(/Wrote\s+(xd|proc):\/\//);
		expect(all).not.toMatch(/\[object Object\]|\bundefined\b/);
	});

	test("a failed omp call reads red", () => {
		expect(
			html(<ToolCard item={named("web_fetch")} harness="omp" />),
		).toContain("is-error");
	});
});

describe("omp: result formats in the shared bodies", () => {
	test("a read selector numbers the excerpt from its first line", () => {
		const p = ompRead(props(named("read")));
		expect((p.input as { path: string }).path).toBe("/work/demo/src/parse.ts");
		expect(p.output.split("\n")[0]).toMatch(/^12\t/);
		const h = html(<OmpReadBody {...props(named("read"))} />);
		expect(h).toMatch(/ds-ln[^>]*>12</);
		expect(h).toContain("parse.ts");
		expect(h).not.toContain("parse.ts:12-14");
	});

	test("grep's grouped matches become files with their match lines", () => {
		expect(
			ompGrepRows(
				"# /r/\n## a.ts\n 1|ctx\n*2|hit\n...\n## sub/\n### b.ts (1 match)\n*9|x",
				"r",
			),
		).toBe("a.ts:2:hit\nsub/b.ts:9:x");
		// A single file searched: rows without headers.
		expect(ompGrepRows("*4|hit\n...\n*7|again", "c.ts")).toBe(
			"c.ts:4:hit\nc.ts:7:again",
		);
		expect(ompGrepRows("No matches", "c.ts")).toBeNull();
		const h = html(<OmpGrepBody {...props(named("grep"))} />);
		expect(h).toMatch(/ds-match-file[\s\S]*parse\.ts[\s\S]*13/);
		expect(text(h)).toContain("config/load.ts");
		expect(text(h)).not.toContain("*13|");
	});

	test("glob's grouped listing becomes paths", () => {
		const t = text(html(<OmpGlobBody {...props(named("glob"))} />));
		expect(t).toContain("parse.ts");
		expect(t).toContain("config/load.ts");
		expect(t).not.toContain("# /work");
		expect(t).not.toContain("## config");
	});
});
