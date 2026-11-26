import { readFileSync } from "node:fs";
import { HARNESSES } from "../../src/harnesses/catalog.ts";
/**
 * One test per chat-block renderer: each tool body, the card line, system
 * rows, reasoning and the lazy views (ANSI, JSON tree, notebook), rendered
 * to static HTML from the synthetic harness logs in web/mock/blocks.ts.
 */
import "./window-shim.ts";
import { describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describeCall } from "../../src/transcripts/describe.ts";
import { galleryEvents } from "../mock/blocks.ts";
import { buildItems, type Item } from "../src/session/items.ts";

// Streamdown renders only in a browser; Markdown is the chat's own (tested
// elsewhere), so here it is its source text in a marked box.
mock.module("../src/components/ai-elements/message.tsx", () => ({
	MessageResponse: ({ children }: { children?: ReactNode }) => (
		<div className="md">{children}</div>
	),
}));
const { ToolCard } = await import("../src/session/ToolCard.tsx");
const { ReasoningRow, SystemRow } = await import(
	"../src/session/Transcript.tsx"
);
const { default: AnsiText } = await import("../src/session/tools/Ansi.tsx");
const { parseAnsi, stripAnsi } = await import("../src/session/tools/ansi.ts");
const {
	default: ToolBody,
	editPairs,
	fileText,
	grepGroups,
} = await import("../src/session/tools/bodies.tsx");
const { default: JsonView } = await import("../src/session/tools/JsonView.tsx");
const { default: NotebookCells } = await import(
	"../src/session/tools/Notebook.tsx"
);
const { readCells } = await import("../src/session/tools/notebook.ts");

const html = (el: ReactElement) => renderToStaticMarkup(el);
/** Visible text of rendered HTML. */
const text = (h: string) =>
	h
		.replace(/<[^>]+>/g, " ")
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/\s+/g, " ");

const events = galleryEvents((id) => `/img/${id}`);
const items = buildItems(events);
type ToolItem = Extract<Item, { t: "tool" }>;
const tools = items.filter((i): i is ToolItem => i.t === "tool");
const byName = (name: string, nth = 0) =>
	tools.filter((t) => (t.call ?? t.result)?.tool?.name === name)[nth]!;

/** The expanded body of a tool item, as the card renders it. */
function body(it: ToolItem) {
	const name = it.call?.tool?.name ?? it.result?.tool?.name ?? "tool";
	const res = it.result;
	return html(
		<ToolBody
			name={name}
			input={it.call?.tool?.input}
			output={(res?.text ?? "").replace(/\[image\]/g, "").trim()}
			detail={res?.tool?.detail ?? it.call?.tool?.detail}
			isError={!!(res?.tool?.isError ?? it.call?.tool?.isError)}
			layout="unified"
			done={!!res}
			kind={describeCall(name, it.call?.tool?.input).kind}
			hasCall={!!it.call}
			truncated={res?.tool?.truncated}
		/>,
	);
}

const head = (it: ToolItem) => text(html(<ToolCard item={it} />));

/** Per tool: something its body must show (a class or text). */
const EXPECT: Array<[string, number, RegExp]> = [
	["Read", 0, /ds-ln[^>]*>1<[\s\S]*getSession/],
	["Edit", 0, /class="[^"]*diff/],
	["MultiEdit", 0, /Edit 1 of 2[\s\S]*Edit 2 of 2/],
	["Write", 0, /export class Lock/],
	["NotebookEdit", 0, /Loading|ds-nb/],
	["Bash", 0, /ds-term[\s\S]*bun test auth/],
	["Bash", 1, /Exit 1/],
	["Bash", 2, /Timed out after 2 min/],
	["Bash", 3, /In background/],
	["Bash", 4, /permission was denied/],
	["Bash", 5, /Stopped before it finished/],
	["BashOutput", 0, /localhost:3000/],
	["KillShell", 0, /killed/],
	["Grep", 0, /ds-match-file[\s\S]*src\/middleware\.ts/],
	["Glob", 0, /ds-files[\s\S]*session\.test\.ts/],
	["LS", 0, /ds-files[\s\S]*lock\.ts/],
	["WebFetch", 0, /Looked for: How should a mutex/],
	[
		"WebSearch",
		0,
		/ds-results[\s\S]*docs\.example\.org[\s\S]*Async mutex patterns/,
	],
	["TodoWrite", 0, /t-done[\s\S]*t-active[\s\S]*t-todo/],
	["AskUserQuestion", 0, /is-chosen[\s\S]*Single flight/],
	["ExitPlanMode", 0, /You approved the plan/],
	["Skill", 0, /instructions went to the agent/],
	["SendMessage", 0, /ds-sent[\s\S]*Delivered/],
	["ToolSearch", 0, /ds-chips[\s\S]*WebSearch[\s\S]*WebFetch/],
	["mcp__tracker__create_issue", 0, /ds-args|Arguments/],
	["FrobnicateWidget", 0, /Arguments[\s\S]*Result/],
	["advisor", 0, /went to the agent only/],
	["Edit", 1, /tone-error[\s\S]*File does not exist/],
	["update_plan", 0, /Port first, then callers[\s\S]*t-done/],
	["exec_command", 0, /rg -n retry src/],
	["apply_patch", 0, /Changed[\s\S]*Added[\s\S]*Deleted/],
	["local_shell", 0, /bun test net/],
	["exec", 0, /git diff --stat[\s\S]*Show script[\s\S]*1 file changed/],
	["spawn_agent", 0, /Review the retry port/],
	["eval", 0, /statistics/],
	["todo", 0, /Benchmark parse/],
	["ask", 0, /Ship the fast parser now\?[\s\S]*ship_now/],
	["web_search", 1, /tone-error|search provider unavailable/],
	["wait", 0, /BenchConfig/],
	["mcp__issue-desk__label_issue", 0, /ds-args[\s\S]*PARSE-7[\s\S]*Result/],
];

describe("chat blocks: every tool body", () => {
	for (const [name, nth, re] of EXPECT)
		test(`${name}${nth ? ` #${nth + 1}` : ""}`, () => {
			const it = byName(name, nth);
			expect(it).toBeDefined();
			const h = body(it);
			expect(h).toMatch(re);
			const t = text(h);
			expect(t).not.toMatch(/\[object Object\]|\bundefined\b/);
			expect(t).not.toContain("\u001b");
		});

	test("omp's HTML question renders as text, never markup", () => {
		const h = body(byName("ask"));
		expect(h).not.toContain("<img");
		expect(h).not.toContain("onerror");
	});

	test("a result whose call is on an older page still shows its output", () => {
		const orphan = tools.find((t) => !t.call)!;
		expect(text(body(orphan))).toContain("42 files checked");
		expect(head(orphan)).toContain("Tool result");
	});
});

describe("chat blocks: the card line", () => {
	const line = (name: string, nth = 0) => head(byName(name, nth));
	test("verb, target and key result", () => {
		expect(line("WebSearch")).toMatch(
			/Searched the web for promise mutex refresh token race 3 results/,
		);
		expect(line("TodoWrite")).toMatch(/Updated the plan 2 of 4 done/);
		expect(line("TodoWrite").match(/2 of 4 done/g)).toHaveLength(1);
		expect(line("AskUserQuestion")).toMatch(
			/Asked you Which approach should the fix use\? “Single flight”/,
		);
		expect(line("apply_patch")).toMatch(/Patched 3 files \+2 −1/);
		expect(line("mcp__tracker__create_issue")).toMatch(
			/Called tracker\.create_issue/,
		);
		// omp: an MCP call through `write xd://…` is a call, not a file write.
		expect(line("mcp__issue-desk__label_issue")).toMatch(
			/Called issue-desk\.label_issue/,
		);
		expect(tools.map(head).join("\n")).not.toMatch(/Wrote\s+xd:\/\//);
		expect(line("read", 1)).toMatch(/Read docs for issue_desk_label_issue/);
		expect(line("Grep")).toMatch(/Searched for refresh\\\( in src 3 matches/);
		expect(line("Bash", 1)).toMatch(/exit 1/);
	});
	test("refused, stopped and failed calls don't claim success", () => {
		expect(line("Bash", 4)).toMatch(/Running git push --force Denied/);
		expect(line("Bash", 5)).toMatch(/Interrupted/);
		expect(line("Edit", 1)).toMatch(/Editing .*missing\.ts Failed/);
		expect(html(<ToolCard item={byName("Bash", 4)} />)).toContain("is-denied");
	});
});

describe("chat blocks: rows", () => {
	const sys = (subtype: string) =>
		events.find((e) => e.kind === "system" && e.subtype === subtype)!;
	test("interrupted, compacted, task and command output", () => {
		expect(html(<SystemRow ev={sys("interrupted")} />)).toMatch(
			/is-interrupted[\s\S]*Interrupted/,
		);
		expect(html(<SystemRow ev={sys("compacted")} />)).toMatch(
			/Earlier messages were summarized/,
		);
		expect(html(<SystemRow ev={sys("task")} />)).toMatch(
			/ds-notice[\s\S]*completed/,
		);
		expect(html(<SystemRow ev={sys("command")} />)).toMatch(
			/Command output[\s\S]*Review started/,
		);
		expect(html(<SystemRow ev={sys("shell")} />)).toMatch(/Shell output/);
	});
	test("hidden reasoning is a quiet row with nothing to open", () => {
		const h = html(<ReasoningRow text="" hidden ms={2000} />);
		expect(h).toContain("is-hidden");
		expect(h).toContain("Thought for 2");
		expect(h).not.toContain("ds-reason-chev");
	});
	test("Claude thinking that wasn't saved says why, and how to turn it on", () => {
		const h = html(<ReasoningRow text="" harness="claude" ms={14000} />);
		expect(h).not.toContain("ds-reason-chev");
		expect(h).toContain("ds-reason-info");
		expect(h).toContain("showThinkingSummaries");
		// Thinking with text stays expandable.
		expect(html(<ReasoningRow text="a plan" harness="claude" />)).toContain(
			"ds-reason-chev",
		);
	});
});

describe("chat blocks: lazy views and helpers", () => {
	test("ANSI: colors as classes, every other escape dropped", () => {
		const spans = parseAnsi(
			"\u001b[32m✓\u001b[0m ok \u001b[1;31mFAIL\u001b[0m\u001b]0;t\u0007",
		);
		expect(spans).toEqual([
			{ text: "✓", fg: 2 },
			{ text: " ok " },
			{ text: "FAIL", bold: true, fg: 1 },
		]);
		expect(stripAnsi("10%\r100%\nnext")).toBe("100%\nnext");
		const h = html(<AnsiText text={"\u001b[31m<b>x</b>\u001b[0m"} />);
		expect(h).toContain("ansi-fg-1");
		expect(h).toContain("&lt;b&gt;");
	});
	test("JSON tree: keys, typed values, folded depth", () => {
		const h = html(
			<JsonView
				value={{ id: "A-1", n: 2, ok: true, none: null, list: [1, 2] }}
			/>,
		);
		expect(h).toMatch(/ds-json-key[^>]*>id: </);
		expect(h).toContain("ds-json-num");
		expect(h).toContain("ds-json-bool");
		expect(h).toContain("2 items");
	});
	test("notebook cells: code and Markdown", () => {
		const cells = readCells(
			'<cell id="a">print(1)</cell id="a"><cell id="b"><cell_type>markdown</cell_type># Title</cell id="b">',
		);
		expect(cells.map((c) => c.type)).toEqual(["code", "markdown"]);
		const h = html(<NotebookCells cells={cells} />);
		expect(h).toMatch(/Code[\s\S]*Markdown/);
	});
	test("Read output, grep groups and edit pairs", () => {
		expect(
			fileText("<system-reminder>x</system-reminder>\n    10\ta\n    11\tb\n"),
		).toEqual({ text: "a\nb", start: 10 });
		expect(
			grepGroups("a.ts:1:x\na.ts:4:y\nb.ts:2:z")?.map((g) => g.matches.length),
		).toEqual([2, 1]);
		expect(grepGroups("not grep output")).toBeNull();
		expect(editPairs({ path: "x", old_string: "a", new_string: "b" })).toEqual([
			{ before: "a", after: "b" },
		]);
	});
});

describe("chat blocks: media", async () => {
	const { DocumentCard, docFacts, size } = await import(
		"../src/session/media.tsx"
	);
	test("PDF facts read like a file card", () => {
		expect(size(868)).toBe("868 bytes");
		expect(size(1)).toBe("1 byte");
		expect(size(1_284_501)).toBe("1.2 MB");
		expect(
			docFacts({
				id: "d",
				mediaType: "application/pdf",
				url: "",
				pages: 1,
				bytes: 40_000,
			}),
		).toBe("PDF · 1 page · 39 KB");
		expect(docFacts({ id: "d", mediaType: "application/pdf", url: "" })).toBe(
			"PDF",
		);
	});
	test("a PDF card names the file and its facts", () => {
		const h = html(
			<DocumentCard
				doc={{
					id: "d",
					mediaType: "application/pdf",
					url: "/x",
					name: "spec.pdf",
					pages: 2,
					bytes: 868,
				}}
			/>,
		);
		expect(h).toContain("spec.pdf");
		expect(h).toContain("PDF · 2 pages · 868 bytes");
		expect(h).toContain('aria-label="Open spec.pdf"');
	});
	test("the gallery has a PDF read, an omp blob image and Codex/pasted images", () => {
		expect(
			events.some((e) => e.documents?.[0]?.name === "refresh-flow.pdf"),
		).toBe(true);
		expect(
			events.filter((e) => e.images?.length).length,
		).toBeGreaterThanOrEqual(5);
	});
});

describe("harness adapters", async () => {
	const { HARNESS_UI, harnessUi } = await import("../src/harnesses/index.ts");
	const { HarnessGlyph, harnessKey } = await import(
		"../src/components/ui/agent-avatar.tsx"
	);
	test("every harness key has an adapter with a name and a mark", () => {
		const sprite = readFileSync(
			new URL("../public/harness-marks.svg", import.meta.url),
			"utf8",
		);
		for (const { id } of HARNESSES) {
			const ui = harnessUi(id);
			expect(ui.name).toBeTruthy();
			expect(harnessKey(id)).toBe(id);
			const rendered = html(<HarnessGlyph harness={id} />);
			expect(rendered).toContain(`data-mark="${id}"`);
			if (ui.icon && "symbol" in ui.icon) {
				expect(rendered).toContain(`href="/harness-marks.svg#${id}"`);
				expect(sprite).toContain(`<symbol id="${id}"`);
			} else expect(ui.icon?.paths.length).toBeGreaterThan(0);
		}
		expect(harnessKey("agy")).toBe("antigravity");
		expect(new Set(HARNESS_UI.map((h) => h.id)).size).toBe(HARNESS_UI.length);
		expect(harnessUi("aider")).toEqual({ id: "aider" });
	});
	test("marks render as inline SVG in currentColor; unknown ones as an initial", () => {
		const h = html(<HarnessGlyph harness="claude" size={20} />);
		expect(h).toMatch(/<svg[^>]*data-mark="claude"[^>]*>/);
		expect(h).toContain('fill="currentColor"');
		expect(html(<HarnessGlyph harness="codex" />)).toContain(
			'stroke="currentColor"',
		);
		expect(html(<HarnessGlyph harness="aider" />)).toContain(">A<");
	});
	test("tool cards a harness renders its own way", () => {
		expect(harnessUi("omp").toolCards?.eval?.Body).toBeDefined();
		expect(harnessUi("omp").toolCards?.task?.kind).toBe("task");
		expect(harnessUi("codex").toolCards?.exec?.kind).toBe("shell");
		expect(harnessUi("claude").toolCards?.AskUserQuestion?.Body).toBeDefined();
	});
});
