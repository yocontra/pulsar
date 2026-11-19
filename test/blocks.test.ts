import { describe, expect, test } from "bun:test";
import { parseClaude } from "../src/harnesses/claude-transcript.ts";
import { parseCodex } from "../src/harnesses/codex-transcript.ts";
import { parsePi } from "../src/harnesses/pi-transcript.ts";
import {
	callLine,
	describeCall,
	patchFiles,
	questions,
	todos,
} from "../src/transcripts/describe.ts";
import { toolDetail } from "../src/transcripts/summary.ts";
import { newParseState } from "../src/transcripts/types.ts";
import {
	claudeLog,
	codexLog,
	galleryEvents,
	ompLog,
} from "../web/mock/blocks.ts";

/** The synthetic per-harness logs behind the chat-blocks gallery. */
const events = galleryEvents();
const call = (name: string, nth = 0) =>
	events.filter((e) => e.kind === "tool_call" && e.tool?.name === name)[nth];
const summary = (name: string, nth = 0) => call(name, nth)?.tool?.summary;

describe("chat blocks: parsers", () => {
	test("Claude markup never reaches a user bubble", () => {
		const users = events.filter((e) => e.role === "user").map((e) => e.text);
		for (const t of users) {
			expect(t).not.toMatch(
				/<\/?(command-|bash-|local-command|system-reminder|task-notification|teammate-message)/,
			);
			expect(t).not.toMatch(/^\[Request interrupted/);
		}
		expect(
			events.find((e) => e.subtype === "command" && e.role === "user")?.text,
		).toBe("/review auth module");
		expect(
			events.find((e) => e.subtype === "shell" && e.role === "user")?.text,
		).toBe("git status --short");
	});

	test("system rows carry what they are", () => {
		const kinds: string[] = events
			.filter((e) => e.kind === "system")
			.map((e) => e.subtype ?? "");
		for (const s of ["interrupted", "compacted", "task", "command", "shell"])
			expect(kinds).toContain(s);
	});

	test("hidden reasoning is a thinking event with no text", () => {
		const hidden = events.filter((e) => e.subtype === "hidden");
		expect(hidden.length).toBeGreaterThanOrEqual(2);
		for (const e of hidden)
			expect(e).toMatchObject({ kind: "thinking", text: "" });
	});

	test("results carry bounded facts", () => {
		expect(call("Bash", 1)?.tool?.detail).toMatchObject({ exitCode: 1 });
		expect(call("Bash", 2)?.tool?.detail).toMatchObject({ timedOutMs: 120000 });
		expect(call("Bash", 3)?.tool?.detail).toMatchObject({ background: "bg_7" });
		expect(call("Bash", 4)?.tool?.detail).toMatchObject({ denied: true });
		expect(call("Bash", 5)?.tool?.detail).toMatchObject({ interrupted: true });
		expect(call("WebSearch")?.tool?.detail?.links).toHaveLength(3);
		expect(call("WebSearch")?.tool?.detail?.links?.[1]?.title).toBe(
			"Async mutex patterns",
		);
		expect(call("AskUserQuestion")?.tool?.detail?.answers?.[0]?.answer).toBe(
			"Single flight",
		);
		expect(call("Grep")?.tool?.detail?.count).toBe(3);
	});

	test("one-line summaries: verb, target, key result", () => {
		expect(summary("WebSearch")).toBe(
			'Searched the web for "promise mutex refresh token race" · 3 results',
		);
		expect(summary("TodoWrite")).toBe("Updated the plan · 2 of 4 done");
		expect(summary("update_plan")).toBe("Updated the plan · 1 of 3 done");
		expect(summary("AskUserQuestion")).toBe(
			"Asked you: Which approach should the fix use? · “Single flight”",
		);
		expect(summary("apply_patch")).toBe("Patched 3 files +2 −1");
		expect(summary("mcp__tracker__create_issue")).toBe(
			"Called tracker.create_issue · Refresh race in session.ts",
		);
		expect(summary("ToolSearch")).toBe(
			'Loaded tools "WebSearch,WebFetch" · 2 tools',
		);
		expect(summary("local_shell")).toBe("Ran `bun test net` · exit 0");
		expect(summary("exec")).toBe("Ran `git diff --stat`");
		expect(summary("web_search")).toBe(
			'Searched the web for "typescript generic retry helper"',
		);
		expect(summary("Bash", 4)).toBe("Ran `git push --force` · denied");
		expect(summary("write")).toBe("Wrote src/fast.ts (1 line)");
	});

	test("omp and Codex extras", () => {
		expect(
			events.find((e) => e.role === "peer" && e.from === "reviewer@demo")?.text,
		).toBe("Benchmarks look good, ship it.");
		expect(
			events.find(
				(e) => e.id.startsWith("omp:") && /^Background job/.test(e.text),
			),
		).toMatchObject({
			subtype: "task",
		});
		expect(call("view_image")).toBeDefined();
		expect(
			events.find(
				(e) => e.kind === "tool_result" && e.tool?.name === "view_image",
			)?.images,
		).toHaveLength(1);
	});
});

describe("chat blocks: describe", () => {
	test("tool names from every harness", () => {
		expect(describeCall("mcp__linear__create_issue", { title: "x" }).verb).toBe(
			"Called",
		);
		expect(
			callLine(
				describeCall("NotebookEdit", {
					notebook_path: "a.ipynb",
					edit_mode: "insert",
				}),
			),
		).toBe("Added a cell to a.ipynb");
		expect(callLine(describeCall("Glob", { pattern: "**/*.ts" }))).toBe(
			'Found files "**/*.ts"',
		);
		expect(
			callLine(describeCall("Bash", { command: "ls" }, { done: false })),
		).toBe("Running `ls`");
		expect(
			callLine(describeCall("eval", { language: "python", title: "Plot" })),
		).toBe("Ran Python Plot");
		expect(callLine(describeCall("SomethingNew", { widget: { id: 1 } }))).toBe(
			"Something new",
		);
	});

	test("plans, questions and patches parse from each shape", () => {
		expect(todos({ plan: [{ step: "a", status: "completed" }] })).toEqual([
			{ text: "a", status: "done" },
		]);
		expect(todos({ list: [{ phase: "P", items: ["x", "y"] }] })).toHaveLength(
			2,
		);
		expect(
			questions({
				questions: [{ question: "Q?", options: [{ label: "A" }] }],
			})[0]?.options[0]?.label,
		).toBe("A");
		const files = patchFiles(
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** Delete File: c.ts\n*** End Patch",
		);
		expect(files.map((f) => [f.path, f.op, f.added, f.removed])).toEqual([
			["a.ts", "update", 1, 1],
			["c.ts", "delete", 0, 0],
		]);
	});

	test("details stay bounded", () => {
		const many = JSON.stringify(
			Array.from({ length: 40 }, (_, i) => ({
				title: "t".repeat(500),
				url: `https://e.com/${i}`,
			})),
		);
		const d = toolDetail("WebSearch", `Links: ${many}\n`, false);
		expect(d?.links).toHaveLength(10);
		expect(d?.links?.[0]?.title.length).toBeLessThanOrEqual(120);
		expect(
			toolDetail(
				"WebSearch",
				'Links: [{"title":"x","url":"javascript:alert(1)"}]\n',
				false,
			)?.links,
		).toEqual([]);
	});
});

describe("chat blocks: no false states", () => {
	test("timeouts, background ids and exit codes only from a shell's edges", () => {
		const text =
			'const RE = "Command timed out after 2m"; // running in background with ID: x';
		expect(toolDetail("Read", text, false)?.timedOutMs).toBeUndefined();
		expect(
			toolDetail("Grep", `a.ts:1:${text}`, false)?.background,
		).toBeUndefined();
		expect(
			toolDetail("Bash", "start\nlog: exit code 3 from child\ndone", false)
				?.exitCode,
		).toBeUndefined();
		expect(toolDetail("Bash", "boom\nExit code 2", true)?.exitCode).toBe(2);
	});
});

describe("chat blocks: messages delivered mid-turn", () => {
	test("queued messages, hooks and command output become events", () => {
		const t = (re: RegExp) => events.find((e) => re.test(e.text));
		expect(t(/^Also check this trace/)).toMatchObject({
			role: "user",
			kind: "text",
		});
		expect(t(/^Also check this trace/)?.text).not.toContain("pasted_content");
		expect(t(/keep the PR small/)).toMatchObject({
			role: "peer",
			from: "lead",
		});
		expect(t(/finished$/)).toMatchObject({ kind: "system", subtype: "task" });
		expect(t(/formatted 2 files/)).toMatchObject({ kind: "system" });
		expect(t(/Context: 41% used/)).toMatchObject({ subtype: "command" });
		expect(t(/Model switched/)).toMatchObject({ kind: "system" });
		expect(t(/context only/)).toBeUndefined();
	});
	test("agent-team messages are notices with readable bodies", () => {
		const team = events.filter((e) => e.notice && e.role === "peer");
		expect(team.map((e) => e.notice?.type)).toEqual([
			"message",
			"idle_notification",
			"message",
			"idle_notification",
			"idle_notification",
			"plan_approval_request",
			"message",
		]);
		for (const e of events)
			expect(e.text).not.toContain('{"type":"idle_notification"');
		expect(
			events.find((e) => e.notice?.type === "task_notification"),
		).toMatchObject({ kind: "system", subtype: "task" });
	});
	test("pi/omp MCP names", () => {
		expect(describeCall("mcp_pulsar_reply", {}).kind).toBe("mcp");
	});
});

describe("chat blocks: ids stand alone", () => {
	for (const [name, log, parse] of [
		["claude", claudeLog, parseClaude],
		["codex", codexLog, parseCodex],
		["omp", ompLog, parsePi],
	] as const)
		test(`${name}: every event exists, with its id, when its line is parsed alone`, () => {
			const text = log();
			const whole = new Set(
				parse(text, newParseState({ atStart: false })).map((e) => e.id),
			);
			const alone = new Set<string>();
			for (const line of text.split("\n"))
				for (const e of parse(line, newParseState({ atStart: false })))
					alone.add(e.id);
			expect([...alone].sort()).toEqual([...whole].sort());
		});
});
