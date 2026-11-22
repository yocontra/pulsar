import "./window-shim.ts";
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { parseClaude } from "../../src/harnesses/claude-transcript.ts";
import { parseCodex } from "../../src/harnesses/codex-transcript.ts";
import { parsePi } from "../../src/harnesses/pi-transcript.ts";
import { newParseState } from "../../src/transcripts/types.ts";
import { galleryEvents } from "../mock/blocks.ts";
import type { TranscriptEvent } from "../src/api/types.ts";
import { registerPage } from "../src/lib/registry.tsx";
import { buildItems } from "../src/session/items.ts";
import { toMessages } from "../src/session/messages.ts";
import { TurnChanges } from "../src/session/TurnChanges.tsx";
import { TurnFileLink } from "../src/session/TurnFileLink.tsx";
import {
	type TurnChanges as Changes,
	turnChanges,
	turnSummaries,
} from "../src/session/turn-changes.ts";

const CWD = "/work/demo";

const summaries = (events: TranscriptEvent[], busy = false, cwd = CWD) =>
	turnSummaries(toMessages(buildItems(events)), cwd, busy);

/** "status path +a −r" per file, for compact assertions. */
const rows = (c: Changes | null | undefined) =>
	c?.files.map(
		(f) =>
			`${f.status} ${f.path} +${f.added} -${f.removed}${f.from ? ` from ${f.from}` : ""}`,
	);

/** The gallery section of one harness (web/mock/blocks.ts). */
function section(prefix: string): TranscriptEvent[] {
	return galleryEvents().filter((e) => e.id.startsWith(`${prefix}:`));
}

describe("turn changes: harness gallery", () => {
	test("Claude: Edit, MultiEdit, Write and NotebookEdit in one turn; a failed Edit is left out", () => {
		const turns = [...summaries(section("claude")).values()];
		expect(turns).toHaveLength(1);
		const t = turns[0]!;
		expect(rows(t)).toEqual([
			"modified src/auth/session.ts +3 -1",
			"modified src/auth/token.ts +2 -2",
			"added src/auth/lock.ts +8 -0",
			"modified notebooks/latency.ipynb +3 -0",
		]);
		expect([t.added, t.removed]).toEqual([16, 3]);
		expect(t.files.some((f) => f.path.includes("missing"))).toBe(false);
		// MultiEdit: one hunk per edit, labelled.
		const token = t.files[1]!;
		expect(
			token.items.filter((i) => "hunk" in i).map((i) => "hunk" in i && i.hunk),
		).toEqual(["Edit 1 of 2", "Edit 2 of 2"]);
	});

	test("Codex: apply_patch updates, adds and deletes", () => {
		const turns = [...summaries(section("codex")).values()];
		expect(turns.map(rows)).toEqual([
			[
				"modified src/net/retry.ts +1 -1",
				"added src/net/index.ts +1 -0",
				"deleted src/util/retry.js +0 -0",
			],
		]);
	});

	test("omp: edit and write count; an xd:// device write does not", () => {
		const turns = [...summaries(section("omp")).values()];
		expect(turns.map(rows)).toEqual([
			["modified src/parse.ts +1 -1", "written src/fast.ts +1 -0"],
		]);
	});

	test("the totals equal the rows the diff draws", () => {
		for (const t of summaries(galleryEvents()).values())
			for (const f of t.files) {
				const lines = f.items.filter((i) => "sign" in i);
				expect(lines.filter((i) => "sign" in i && i.sign === "+").length).toBe(
					f.added,
				);
				expect(lines.filter((i) => "sign" in i && i.sign === "-").length).toBe(
					f.removed,
				);
			}
	});
});

describe("turn changes: transcript fixtures", () => {
	const dir = join(import.meta.dir, "../../test/fixtures/transcripts");
	const parse = (
		harness: string,
		fn: typeof parseClaude,
	): Map<string, Changes>[] =>
		readdirSync(join(dir, harness)).map((f) => {
			const events = fn(
				readFileSync(join(dir, harness, f), "utf8"),
				newParseState({ atStart: true, cwd: CWD }),
			);
			// The live tail re-sends a call with its result folded in: keep the last.
			const byId = new Map(events.map((e) => [e.id, e]));
			return summaries([...byId.values()]);
		});
	const all = (maps: Map<string, Changes>[]) =>
		maps.flatMap((m) => [...m.values()].map(rows));

	test("Claude", () => {
		expect(all(parse("claude", parseClaude))).toEqual([
			["modified src/auth/session.ts +3 -1"],
		]);
	});
	test("Codex", () => {
		expect(all(parse("codex", parseCodex))).toEqual([
			["modified src/net.ts +2 -1"],
		]);
	});
	test("omp", () => {
		expect(all(parse("omp", parsePi))).toEqual([
			["modified src/auth/session.ts +1 -1"],
		]);
	});
	test("pi: a turn with only shell commands has no summary", () => {
		expect(all(parse("pi", parsePi))).toEqual([]);
	});
});

// ------------------------------------------------------------------ synthetic

let seq = 0;
const user = (text = "go"): TranscriptEvent => ({
	id: `u${++seq}`,
	ts: seq,
	role: "user",
	kind: "text",
	text,
});
const say = (text = "done"): TranscriptEvent => ({
	id: `a${++seq}`,
	ts: seq,
	role: "assistant",
	kind: "text",
	text,
});
const system = (): TranscriptEvent => ({
	id: `s${++seq}`,
	ts: seq,
	role: "system",
	kind: "system",
	text: "Conversation compacted",
	subtype: "compacted",
});
/** A call and its result. */
function call(
	name: string,
	input: unknown,
	result: (Partial<TranscriptEvent["tool"]> & { text?: string }) | null = {},
	extra: Partial<TranscriptEvent> = {},
): TranscriptEvent[] {
	const callId = `c${++seq}`;
	const c: TranscriptEvent = {
		id: `call${seq}`,
		ts: seq,
		role: "assistant",
		kind: "tool_call",
		text: "",
		tool: { name, callId, input },
		...extra,
	};
	if (!result) return [c];
	const { text = "ok", ...tool } = result;
	return [
		c,
		{
			id: `res${seq}`,
			ts: seq,
			role: "user",
			kind: "tool_result",
			text,
			tool: { name, callId, ...tool },
			...(extra.sidechain ? { sidechain: extra.sidechain } : {}),
		},
	];
}

describe("turn changes: OpenCode tool parts", () => {
	test("edit, multiedit, write and patch with OpenCode's argument names", () => {
		const t = turnChanges(
			buildItems([
				...call("edit", {
					filePath: `${CWD}/src/a.ts`,
					oldString: "let x = 1;",
					newString: "const x = 1;",
				}),
				...call("multiedit", {
					filePath: `${CWD}/src/b.ts`,
					edits: [
						{ filePath: `${CWD}/src/b.ts`, oldString: "a", newString: "b" },
						{ filePath: `${CWD}/src/b.ts`, oldString: "c", newString: "d\ne" },
					],
				}),
				...call("write", { filePath: `${CWD}/src/c.ts`, content: "x\ny\n" }),
				...call("patch", {
					patchText:
						"*** Begin Patch\n*** Update File: src/d.ts\n@@\n-old\n+new\n*** End Patch",
				}),
			]),
			CWD,
		);
		expect(rows(t)).toEqual([
			"modified src/a.ts +1 -1",
			"modified src/b.ts +3 -2",
			"written src/c.ts +2 -0",
			"modified src/d.ts +1 -1",
		]);
	});
});

describe("turn changes: rules", () => {
	test("a turn runs from one user message to the next; system rows stay inside", () => {
		const events = [
			user(),
			...call("Edit", {
				file_path: `${CWD}/a.ts`,
				old_string: "1",
				new_string: "2",
			}),
			system(),
			...call("Write", { file_path: `${CWD}/b.ts`, content: "b" }),
			say(),
			user(),
			say("no edits here"),
			user(),
			...call("Edit", {
				file_path: `${CWD}/a.ts`,
				old_string: "2",
				new_string: "3",
			}),
			say(),
		];
		const turns = summaries(events);
		expect([...turns.values()].map(rows)).toEqual([
			["modified a.ts +1 -1", "written b.ts +1 -0"],
			["modified a.ts +1 -1"],
		]);
		// The summary sits on the turn's last assistant message.
		const messages = toMessages(buildItems(events));
		const lastOfFirst = messages.filter((m) => m.kind === "assistant")[1]!;
		expect(turns.has(lastOfFirst.id)).toBe(true);
	});

	test("while the agent is busy the last turn has no summary yet", () => {
		const events = [
			user(),
			...call("Edit", {
				file_path: `${CWD}/a.ts`,
				old_string: "1",
				new_string: "2",
			}),
			user(),
			...call("Edit", {
				file_path: `${CWD}/b.ts`,
				old_string: "1",
				new_string: "2",
			}),
		];
		expect([...summaries(events, true).values()].map(rows)).toEqual([
			["modified a.ts +1 -1"],
		]);
		expect(summaries(events, false).size).toBe(2);
	});

	test("unfinished, failed, denied and stopped calls change nothing", () => {
		const e = (p: string) => ({
			file_path: `${CWD}/${p}`,
			old_string: "a",
			new_string: "b",
		});
		const t = turnChanges(
			buildItems([
				...call("Edit", e("pending.ts"), null),
				...call("Edit", e("failed.ts"), { isError: true }),
				...call("Edit", e("denied.ts"), { detail: { denied: true } }),
				...call("Edit", e("stopped.ts"), { detail: { interrupted: true } }),
				...call("Edit", e("ok.ts")),
			]),
			CWD,
		);
		expect(rows(t)).toEqual(["modified ok.ts +1 -1"]);
	});

	test("a call re-sent as done counts without a separate result", () => {
		const [c] = call(
			"edit",
			{ path: `${CWD}/a.ts`, oldText: "a", newText: "b" },
			null,
		);
		c!.tool!.done = true;
		expect(rows(turnChanges(buildItems([c!]), CWD))).toEqual([
			"modified a.ts +1 -1",
		]);
	});

	test("absolute and relative paths to one file merge; edits stay in order", () => {
		const t = turnChanges(
			buildItems([
				...call("Edit", {
					file_path: `${CWD}/src/a.ts`,
					old_string: "1",
					new_string: "2",
				}),
				...call(
					"apply_patch",
					"*** Begin Patch\n*** Update File: src/a.ts\n@@ fn\n-2\n+3\n*** End Patch",
				),
			]),
			CWD,
		);
		expect(rows(t)).toEqual(["modified src/a.ts +2 -2"]);
		const hunks = t!.files[0]!.items.filter((i) => "hunk" in i);
		expect(hunks.map((h) => "hunk" in h && h.hunk)).toEqual([
			"Change 1",
			"@@ fn",
		]);
	});

	test("a moved file shows under its new name", () => {
		const t = turnChanges(
			buildItems(
				call(
					"apply_patch",
					"*** Begin Patch\n*** Update File: src/old.ts\n*** Move to: src/new.ts\n@@\n-a\n+b\n*** End Patch",
				),
			),
			CWD,
		);
		expect(rows(t)).toEqual(["moved src/new.ts +1 -1 from src/old.ts"]);
	});

	test("a subagent's edits count in the parent's turn", () => {
		const events = [
			user(),
			...call("Task", { description: "fix", prompt: "fix it" }),
		];
		const taskId = events[1]!.tool!.callId;
		// Subagent events run between the Task call and its result.
		const result = events.pop()!;
		events.push(
			...call(
				"Edit",
				{ file_path: `${CWD}/sub.ts`, old_string: "a", new_string: "b" },
				{},
				{ sidechain: taskId },
			),
			result,
		);
		expect([...summaries(events).values()].map(rows)).toEqual([
			["modified sub.ts +1 -1"],
		]);
	});

	test("a write is added or modified only when its result says which", () => {
		const t = turnChanges(
			buildItems([
				...call(
					"Write",
					{ file_path: `${CWD}/a.ts`, content: "a" },
					{ text: "The file /work/demo/a.ts has been updated successfully." },
				),
				...call(
					"Write",
					{ file_path: `${CWD}/b.ts`, content: "b" },
					{ text: "File created successfully at: /work/demo/b.ts" },
				),
			]),
			CWD,
		);
		expect(rows(t)).toEqual(["modified a.ts +1 -0", "added b.ts +1 -0"]);
		// "Wrote b.ts" says neither.
		const w = turnChanges(
			buildItems(
				call(
					"write",
					{ path: `${CWD}/c.ts`, content: "c" },
					{ text: "Wrote c.ts" },
				),
			),
			CWD,
		);
		expect(rows(w)).toEqual(["written c.ts +1 -0"]);
	});
});

describe("turn changes: the summary row", () => {
	test("says how many files and lines changed", () => {
		const t = [...summaries(section("claude")).values()][0]!;
		const html = renderToStaticMarkup(
			<TurnChanges changes={t} layout="unified" />,
		);
		expect(html).toContain("Changed 4 files");
		expect(html).toContain("+16");
		expect(html).toContain("−3");
		expect(html).toContain('data-turn-changes="4"');
		expect(html).toContain('aria-expanded="false"');
	});
});

describe("turn changes: caching", () => {
	test("the same applied calls give the same object; a new call a new one", () => {
		const events = [
			...call("Edit", {
				file_path: `${CWD}/a.ts`,
				old_string: "1",
				new_string: "2",
			}),
		];
		const a = turnChanges(buildItems(events), CWD);
		expect(turnChanges(buildItems(events), CWD)).toBe(a);
		events.push(...call("Write", { file_path: `${CWD}/b.ts`, content: "b" }));
		const b = turnChanges(buildItems(events), CWD);
		expect(b).not.toBe(a);
		expect(rows(b)).toEqual(["modified a.ts +1 -1", "written b.ts +1 -0"]);
	});
});

describe("turn changes: the file viewer link", () => {
	test("shows only while a file viewer page is registered", () => {
		const link = () =>
			renderToStaticMarkup(<TurnFileLink agentId="m:1" path="src/a.ts" />);
		expect(link()).toBe("");
		const off = registerPage({ name: "file", desktop: () => null });
		try {
			expect(link()).toContain('aria-label="Open src/a.ts"');
			// Outside the agent's folder: the viewer can't open it.
			expect(
				renderToStaticMarkup(<TurnFileLink agentId="m:1" path="/etc/hosts" />),
			).toBe("");
		} finally {
			off();
		}
		expect(link()).toBe("");
	});
});
