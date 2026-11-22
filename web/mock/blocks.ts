/**
 * Synthetic raw session logs with every block a harness writes, for the
 * chat-blocks gallery and the renderer tests. Nothing here is real content:
 * the logs are built in each harness's on-disk shape and run through the
 * daemon's own parsers, so the gallery shows what real logs would show.
 */
import { parseClaude } from "../../src/harnesses/claude-transcript.ts";
import { parseCodex } from "../../src/harnesses/codex-transcript.ts";
import { parsePi } from "../../src/harnesses/pi-transcript.ts";
import { newParseState } from "../../src/transcripts/types.ts";
import type { TranscriptEvent } from "../src/api/types.ts";
import { SAMPLE_PDF } from "./images.ts";
import { pulsarGallery } from "./pulsar-blocks.ts";

const CWD = "/work/demo";
const T0 = Date.UTC(2026, 10, 17, 9, 0, 0);
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
const ESC = "\u001b";

let clock = T0;
const at = () => {
	clock += 4000;
	return new Date(clock).toISOString();
};
const lines = (records: object[]) =>
	records.map((r) => JSON.stringify(r)).join("\n");

// ------------------------------------------------------------------ Claude

/** A Claude Code session (`~/.claude/projects/<slug>/<id>.jsonl`). */
export function claudeLog(): string {
	const out: object[] = [];
	let n = 0;
	const user = (content: unknown, extra: object = {}) =>
		out.push({
			type: "user",
			uuid: `cu${++n}`,
			timestamp: at(),
			message: { role: "user", content },
			...extra,
		});
	const assistant = (content: object[]) =>
		out.push({
			type: "assistant",
			uuid: `ca${++n}`,
			timestamp: at(),
			message: {
				id: `msg_${n}`,
				role: "assistant",
				model: "claude-demo-1",
				content,
			},
		});
	/** One call and its result. */
	const tool = (
		name: string,
		input: unknown,
		result: unknown,
		opts: { isError?: boolean; toolUseResult?: object } = {},
	) => {
		const id = `toolu_${++n}`;
		assistant([{ type: "tool_use", id, name, input }]);
		user(
			[
				{
					type: "tool_result",
					tool_use_id: id,
					content: result,
					...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
				},
			],
			opts.toolUseResult ? { toolUseResult: opts.toolUseResult } : {},
		);
	};

	user("Fix the flaky refresh test and tidy the auth module.", {
		origin: { kind: "human" },
	});
	user([
		{
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG },
		},
		{ type: "text", text: "Here is the failing run." },
	]);
	user(
		"<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args>auth module</command-args>",
	);
	user(
		"<local-command-stdout>Review started for 3 files.</local-command-stdout>",
	);
	user("<bash-input>git status --short</bash-input>");
	user(
		"<bash-stdout> M src/auth/session.ts\n?? notes.txt</bash-stdout><bash-stderr></bash-stderr>",
	);
	assistant([
		{
			type: "thinking",
			thinking: "The test uses a real clock; fake timers will make it stable.",
			signature: "sig",
		},
	]);
	assistant([{ type: "thinking", thinking: "", signature: "sig-hidden" }]);
	assistant([
		{
			type: "text",
			text: "I'll start with the session module.\n\n- read it\n- fix the race\n- run the tests",
		},
	]);
	tool(
		"Read",
		{ file_path: `${CWD}/src/auth/session.ts`, offset: 1, limit: 6 },
		"<system-reminder>Demo reminder.</system-reminder>\n     1\texport async function getSession() {\n     2\t  if (token.expired) refresh();\n     3\t  return token;\n     4\t}\n",
	);
	tool("Read", { file_path: `${CWD}/docs/refresh-flow.pdf` }, [
		{ type: "text", text: "PDF file read: docs/refresh-flow.pdf" },
		{
			type: "document",
			source: {
				type: "base64",
				media_type: "application/pdf",
				data: Buffer.from(SAMPLE_PDF).toString("base64"),
			},
		},
	]);
	tool(
		"Edit",
		{
			file_path: `${CWD}/src/auth/session.ts`,
			old_string: "  if (token.expired) refresh();",
			new_string:
				"  if (token.expired) {\n    await lock.run(() => refresh());\n  }",
		},
		"The file has been updated.",
	);
	tool(
		"MultiEdit",
		{
			file_path: `${CWD}/src/auth/token.ts`,
			edits: [
				{ old_string: "let retries = 3;", new_string: "const RETRIES = 3;" },
				{ old_string: "retries--;", new_string: "attempt++;" },
			],
		},
		"Applied 2 edits.",
	);
	tool(
		"Write",
		{
			file_path: `${CWD}/src/auth/lock.ts`,
			content:
				"export class Lock {\n  #tail = Promise.resolve();\n  run<T>(fn: () => Promise<T>) {\n    const next = this.#tail.then(fn);\n    this.#tail = next.then(() => {}, () => {});\n    return next;\n  }\n}\n",
		},
		"File created successfully.",
	);
	tool(
		"NotebookEdit",
		{
			notebook_path: `${CWD}/notebooks/latency.ipynb`,
			cell_id: "c2",
			cell_type: "code",
			edit_mode: "replace",
			new_source:
				"import pandas as pd\ndf = pd.read_csv('latency.csv')\ndf.describe()",
		},
		"Updated cell c2.",
	);
	tool(
		"Bash",
		{ command: "bun test auth --colors", description: "Run the auth tests" },
		`${ESC}[32m✓${ESC}[0m refresh runs once ${ESC}[2m(3 ms)${ESC}[0m\n${ESC}[32m✓${ESC}[0m second caller reuses the token\n\n${ESC}[1m 2 pass${ESC}[0m\n${ESC}[31m 0 fail${ESC}[0m`,
		{ isError: false },
	);
	tool(
		"Bash",
		{ command: "bun test --bail" },
		"✗ middleware > refreshes an expired token\n  expected 200, received 401\n\nExit code 1",
		{ isError: true },
	);
	tool(
		"Bash",
		{ command: "bun run e2e", timeout: 120000 },
		"Command timed out after 2m 0.0s",
		{
			isError: true,
			toolUseResult: {
				stdout: "",
				stderr: "",
				interrupted: false,
				timedOutAfterMs: 120000,
			},
		},
	);
	tool(
		"Bash",
		{ command: "bun run dev", run_in_background: true },
		"Command running in background with ID: bg_7",
		{ toolUseResult: { backgroundTaskId: "bg_7", stdout: "", stderr: "" } },
	);
	tool("BashOutput", { bash_id: "bg_7" }, "ready on http://localhost:3000");
	tool("KillShell", { shell_id: "bg_7" }, "Shell bg_7 killed.");
	tool(
		"Grep",
		{ pattern: "refresh\\(", path: "src", output_mode: "content", "-n": true },
		"src/middleware.ts:14:  if (expired) refresh()\nsrc/api.ts:88:  await refresh()\nsrc/auth/token.ts:40:export async function refresh() {",
	);
	tool(
		"Glob",
		{ pattern: "src/**/*.test.ts" },
		"src/auth/session.test.ts\nsrc/auth/token.test.ts\nsrc/api.test.ts",
	);
	tool(
		"LS",
		{ path: `${CWD}/src/auth` },
		"- src/auth/\n  - lock.ts\n  - session.ts\n  - token.ts",
	);
	tool(
		"WebFetch",
		{
			url: "https://example.com/docs/locks",
			prompt: "How should a mutex wrap async refresh?",
		},
		"## Async locks\n\nChain each call on the previous promise so only **one** refresh runs at a time.",
	);
	tool(
		"WebSearch",
		{ query: "promise mutex refresh token race" },
		'Web search results for query: "promise mutex refresh token race"\n\nLinks: [{"title":"Avoiding token refresh races","url":"https://example.com/blog/refresh-races"},{"title":"# Async mutex patterns","url":"https://docs.example.org/async/mutex"},{"title":"Single-flight requests","url":"https://example.net/single-flight"}]\n\nA mutex or single-flight promise avoids concurrent refreshes.',
	);
	tool(
		"TodoWrite",
		{
			todos: [
				{
					content: "Put refresh() behind a lock",
					status: "completed",
					activeForm: "Locking",
				},
				{
					content: "Regression test for concurrent refreshes",
					status: "completed",
					activeForm: "Testing",
				},
				{
					content: "Update the middleware caller",
					status: "in_progress",
					activeForm: "Updating",
				},
				{
					content: "Push and update the PR",
					status: "pending",
					activeForm: "Pushing",
				},
			],
		},
		"Todos have been modified successfully.",
	);
	tool(
		"AskUserQuestion",
		{
			questions: [
				{
					question: "Which approach should the fix use?",
					header: "Approach",
					multiSelect: false,
					options: [
						{
							label: "A lock",
							description: "Serialize refreshes with a mutex.",
						},
						{
							label: "Single flight",
							description: "Share one in-flight promise.",
						},
					],
				},
			],
		},
		'User has answered your questions: "Which approach should the fix use?"="Single flight". You can now continue.',
		{
			toolUseResult: {
				answers: { "Which approach should the fix use?": "Single flight" },
			},
		},
	);
	tool(
		"ExitPlanMode",
		{
			plan: "## Plan\n\n1. Add a single-flight helper\n2. Use it in `getSession()`\n3. Add a regression test",
			planFilePath: `${CWD}/.claude/plans/refresh.md`,
		},
		"User has approved your plan. You can now start coding.",
	);
	tool("Skill", { skill: "review" }, "Launching skill: review");
	tool(
		"Agent",
		{
			description: "Find other refresh callers",
			prompt: "List every caller of refresh().",
			subagent_type: "Explore",
		},
		"Found 3 callers:\n\n- `src/middleware.ts:14`\n- `src/api.ts:88`\n- `src/auth/token.ts:40`",
	);
	tool(
		"SendMessage",
		{
			to: "reviewer",
			message: "The refresh fix is ready for review on **fix/refresh**.",
			summary: "Fix ready",
		},
		'{"success":true,"message":"Message sent"}',
	);
	tool("ToolSearch", { query: "select:WebSearch,WebFetch", max_results: 2 }, [
		{ type: "tool_reference", tool_name: "WebSearch" },
		{ type: "tool_reference", tool_name: "WebFetch" },
	]);
	tool(
		"mcp__tracker__create_issue",
		{
			title: "Refresh race in session.ts",
			team: "AUTH",
			labels: ["bug", "auth"],
			priority: 2,
		},
		'{"id":"AUTH-142","url":"https://tracker.example.com/AUTH-142","state":{"name":"Todo","type":"unstarted"},"labels":["bug","auth"],"assignee":null}',
	);
	tool("mcp__browser__screenshot", { url: "http://localhost:3000/login" }, [
		{ type: "text", text: "Captured the login page." },
		{
			type: "image",
			source: { type: "base64", media_type: "image/png", data: PNG },
		},
	]);
	tool(
		"Bash",
		{ command: "git push --force" },
		"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file).",
		{ isError: true },
	);
	tool(
		"Bash",
		{ command: "bun run bench" },
		"[Request interrupted by user for tool use]",
		{
			isError: true,
			toolUseResult: { interrupted: true, stdout: "", stderr: "" },
		},
	);
	tool(
		"Edit",
		{ file_path: `${CWD}/src/missing.ts`, old_string: "a", new_string: "b" },
		"<tool_use_error>File does not exist.</tool_use_error>",
		{ isError: true },
	);
	tool(
		"Bash",
		{ command: "cat build.log" },
		Array.from(
			{ length: 160 },
			(_, i) =>
				`[${String(i + 1).padStart(3, "0")}] compiled module ${i + 1} of 160`,
		).join("\n"),
	);
	tool(
		"Bash",
		{ command: "cat dist/bundle.min.js | head -c 900" },
		`!function(){${"var a=1,b=2;".repeat(80)}}();`,
	);
	tool(
		"FrobnicateWidget",
		{
			widget: { id: 7, size: "large", tags: ["x", "y"] },
			dryRun: true,
			notes: null,
		},
		'{"ok":true,"changed":["size"],"previous":{"size":"small"}}',
	);
	// Server tools answer inside the assistant turn.
	assistant([
		{ type: "server_tool_use", id: "srvtoolu_1", name: "advisor", input: {} },
	]);
	assistant([
		{
			type: "advisor_tool_result",
			tool_use_id: "srvtoolu_1",
			content: { type: "advisor_redacted_result", encrypted_content: "x" },
		},
	]);
	// A call after `cd web`: the log records where the session was.
	{
		const id = `toolu_${++n}`;
		out.push({
			type: "assistant",
			uuid: `ca${++n}`,
			timestamp: at(),
			cwd: `${CWD}/web`,
			message: {
				id: `msg_${n}`,
				role: "assistant",
				model: "claude-demo-1",
				content: [
					{
						type: "tool_use",
						id,
						name: "Bash",
						input: {
							command: "bun run build && \\\n  ls dist | head -3",
							description: "Build the web app",
						},
					},
				],
			},
		});
		user([
			{
				type: "tool_result",
				tool_use_id: id,
				content: "built in 1.2 s\nassets\nindex.html\nsw.js",
			},
		]);
	}
	// A long one-line chain: shown one step per line, copied as written.
	tool(
		"Bash",
		{
			command:
				"cd packages/net && bun install --frozen-lockfile && bun run build; bun test --coverage",
			description: "Build and test the net package",
		},
		"4 pass\n0 fail",
	);
	user("[Request interrupted by user]");
	user(
		'<task-notification>\n<task-id>bg_7</task-id>\n<status>completed</status>\n<summary>Background command "bun run dev" completed (exit code 0)</summary>\n</task-notification>',
		{ origin: { kind: "task-notification" } },
	);
	user("", {
		origin: {
			kind: "peer",
			name: "codex@demo",
			body: "Heads up: I'm rebasing `main` in five minutes.",
		},
	});
	out.push({
		type: "system",
		subtype: "compact_boundary",
		uuid: `cs${++n}`,
		timestamp: at(),
		content: "Conversation compacted",
	});
	// Delivered while the agent was busy: only as attachments.
	const attach = (attachment: object) =>
		out.push({
			type: "attachment",
			uuid: `cq${++n}`,
			timestamp: at(),
			attachment,
		});
	attach({
		type: "queued_command",
		prompt:
			'Also check this trace:\n\n<pasted_content id="p1">\nTypeError: token is null\n    at refresh (token.ts:41)\n</pasted_content id="p1">',
		origin: { kind: "human" },
		commandMode: "prompt",
	});
	attach({
		type: "queued_command",
		prompt:
			'Another Claude session sent a message:\n<teammate-message from-name="lead">\nPlease keep the PR small.\n</teammate-message>',
		origin: { kind: "peer", name: "lead" },
		commandMode: "prompt",
	});
	attach({
		type: "queued_command",
		prompt:
			'<task-notification>\n<summary>Agent "Find other refresh callers" finished</summary>\n</task-notification>',
		origin: { kind: "task-notification" },
		commandMode: "task-notification",
	});
	// Agent-team messages (Claude Code teams): wrapped, several per record.
	const teammate = (attrs: string, body: string) =>
		`<teammate-message ${attrs}>\n${body}\n</teammate-message>`;
	const fromTeam = (...messages: string[]) =>
		`Another Claude session sent a message:\n${messages.join("\n\n")}\n\nThis came from another Claude session — not typed by your user.`;
	user(
		fromTeam(
			teammate(
				'teammate_id="parser" color="blue" summary="Four fixes ready for review"',
				JSON.stringify({
					type: "idle_notification",
					from: "parser",
					timestamp: "2026-11-17T09:20:00.000Z",
					idleReason: "available",
					result:
						"I opened the four fixes against `develop`.\n\n| Defect | PR |\n|---|---|\n| 1, token refresh | https://example.com/pr/101 |\n| 2, retry loop | https://example.com/pr/102 |\n| 3, cache key | https://example.com/pr/103 |\n| 4, log noise | https://example.com/pr/104 |\n\nAll four pass `bun test`. Two notes:\n\n- PR 102 changes the retry ceiling from 5 to 3.\n- PR 104 drops one debug line that nobody reads.\n\nNext I would look at the flaky timer test.",
				}),
			),
			teammate(
				'teammate_id="docs" color="green" summary="README section drafted"',
				"I drafted the **Setup** section. See `docs/setup.md`.",
			),
		),
	);
	user(
		fromTeam(
			teammate(
				'teammate_id="docs" color="green"',
				JSON.stringify({
					type: "idle_notification",
					from: "docs",
					timestamp: "2026-11-17T09:21:00.000Z",
					idleReason: "available",
				}),
			),
		),
	);
	user(
		fromTeam(
			teammate(
				'teammate_id="tester" color="red" summary="Could not start the browser"',
				JSON.stringify({
					type: "idle_notification",
					from: "tester",
					timestamp: "2026-11-17T09:22:00.000Z",
					idleReason: "failed",
					failureReason: "Chromium did not start: `ENOENT`.",
				}),
			),
		),
	);
	user(
		fromTeam(
			teammate(
				'teammate_id="planner" color="purple" summary="Plan: split the parser"',
				JSON.stringify({
					type: "plan_approval_request",
					from: "planner",
					request_id: "plan-1",
					plan: "1. Move tag parsing to `team.ts`.\n2. Add one event per message.",
				}),
			),
		),
	);
	// A teammate's own log: the lead's message, bare.
	user(
		teammate(
			'teammate_id="team-lead" color="orange" summary="Take the parser task"',
			"Please take the parser task. Keep the diff small.",
		),
	);
	// A background agent finished with a result.
	user(
		'<task-notification>\n<task-id>a1b2</task-id>\n<status>completed</status>\n<summary>Agent "Survey the callers" completed</summary>\n<result>Found **3** callers:\n\n- `auth.ts`\n- `session.ts`\n- `cli.ts`</result>\n</task-notification>',
		{ origin: { kind: "task-notification" } },
	);
	attach({
		type: "hook_system_message",
		content: "PreToolUse hook: formatted 2 files",
		hookName: "fmt",
	});
	attach({ type: "environment", content: "context only, never shown" });
	out.push({
		type: "system",
		subtype: "local_command",
		uuid: `cs${++n}`,
		timestamp: at(),
		content: "<local-command-stdout>Context: 41% used</local-command-stdout>",
	});
	out.push({
		type: "system",
		subtype: "informational",
		uuid: `cs${++n}`,
		timestamp: at(),
		content: "Model switched to claude-demo-2",
	});
	tool(
		"mcp__tracker__list_issues",
		{ team: "AUTH" },
		JSON.stringify(
			Array.from({ length: 120 }, (_, i) => ({
				id: `AUTH-${100 + i}`,
				title: `Synthetic issue ${i}`,
				state: "Todo",
			})),
		),
	);
	// A result whose call is on an older page.
	user([
		{
			type: "tool_result",
			tool_use_id: "toolu_older",
			content: "42 files checked, no problems.",
		},
	]);
	assistant([
		{
			type: "text",
			text:
				"Done. The refresh path now runs once:\n\n```ts\nexport async function getSession() {\n  if (token.expired) await refreshOnce();\n  return token;\n}\n```\n\n| case | before | after |\n| --- | --- | --- |\n| 2 requests | 2 refreshes | 1 refresh |\n\nSee [refresh.ts](src/auth/refresh.ts), the [QA report](" +
				CWD +
				"/out/qa/report.html), the [run log](/tmp/demo-run.log) and the [docs](https://example.com/docs).",
		},
	]);
	return lines(out);
}

// ------------------------------------------------------------------ Codex

/** A Codex rollout (`~/.codex/sessions/**\/rollout-*.jsonl`). */
export function codexLog(): string {
	const out: object[] = [];
	let n = 0;
	const item = (payload: object) =>
		out.push({ timestamp: at(), type: "response_item", payload });
	out.push({
		timestamp: at(),
		type: "turn_context",
		payload: { model: "gpt-demo" },
	});
	item({
		type: "message",
		role: "user",
		content: [
			{
				type: "input_text",
				text: "Port the retry helper and update the plan.",
			},
		],
	});
	item({
		type: "reasoning",
		id: `rs_${++n}`,
		summary: [
			{
				type: "summary_text",
				text: "**Plan the port**\n\nMove the helper, then update callers.",
			},
		],
	});
	item({
		type: "reasoning",
		id: `rs_${++n}`,
		summary: [],
		encrypted_content: "x",
	});
	const call = (
		type: string,
		name: string,
		input: unknown,
		output: unknown,
	) => {
		const callId = `call_${++n}`;
		item(
			type === "custom_tool_call"
				? { type, name, call_id: callId, input }
				: { type, name, call_id: callId, arguments: JSON.stringify(input) },
		);
		item({
			type:
				type === "custom_tool_call"
					? "custom_tool_call_output"
					: "function_call_output",
			call_id: callId,
			output,
		});
	};
	call(
		"function_call",
		"update_plan",
		{
			explanation: "Port first, then callers.",
			plan: [
				{ step: "Move retry helper to src/net", status: "completed" },
				{ step: "Update callers", status: "in_progress" },
				{ step: "Run the suite", status: "pending" },
			],
		},
		"Plan updated",
	);
	call(
		"function_call",
		"exec_command",
		{ cmd: "rg -n retry src", workdir: CWD },
		JSON.stringify({
			output:
				"src/net/retry.ts:3:export function retry()\nsrc/api.ts:9:  retry(fetch)",
			metadata: { exit_code: 0 },
		}),
	);
	call(
		"custom_tool_call",
		"apply_patch",
		'*** Begin Patch\n*** Update File: src/net/retry.ts\n@@\n-export function retry(fn) {\n+export function retry<T>(fn: () => Promise<T>, tries = 3) {\n   return fn();\n }\n*** Add File: src/net/index.ts\n+export * from "./retry";\n*** Delete File: src/util/retry.js\n*** End Patch',
		JSON.stringify({
			output:
				"Success. Updated the following files:\nM src/net/retry.ts\nA src/net/index.ts\nD src/util/retry.js",
			metadata: { exit_code: 0 },
		}),
	);
	call("function_call", "view_image", { path: `${CWD}/docs/flow.png` }, [
		{ type: "input_image", image_url: `data:image/png;base64,${PNG}` },
	]);
	item({
		type: "web_search_call",
		id: `ws_${++n}`,
		status: "completed",
		action: { type: "search", query: "typescript generic retry helper" },
	});
	const shellId = `call_${++n}`;
	item({
		type: "local_shell_call",
		call_id: shellId,
		status: "completed",
		action: { type: "exec", command: ["bash", "-lc", "bun test net"] },
	});
	item({
		type: "function_call_output",
		call_id: shellId,
		output: JSON.stringify({
			output: "3 pass\n0 fail",
			metadata: { exit_code: 0 },
		}),
	});
	call(
		"custom_tool_call",
		"exec",
		'const r = await tools.exec_command({cmd: "git diff --stat", yield_time_ms: 1000});\ntext(r.output);',
		[
			{
				type: "input_text",
				text: "Script completed\nWall time 0.4 seconds\nOutput:\n",
			},
			{
				type: "input_text",
				text: " src/net/retry.ts | 4 ++--\n 1 file changed",
			},
		],
	);
	// A script that runs several commands, one of them unreadable statically.
	call(
		"custom_tool_call",
		"exec",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: Codex's script source, shown as is
		'const repo = "/work/demo";\nconst a = await tools.exec_command({cmd: "bun test net --reporter=dots", workdir: `${repo}/packages/net`});\nconst b = await tools.exec_command({cmd: `git -C ${repo} status --short`});\nfor (const f of ["a.ts", "b.ts"]) await tools.exec_command({cmd: `wc -l ${f}`, workdir: repo});\ntext(JSON.stringify(a));\ntext(JSON.stringify(b));',
		[
			{
				type: "input_text",
				text: "Script completed\nWall time 2.1 seconds\nOutput:\n",
			},
			{
				type: "input_text",
				text: JSON.stringify({
					chunk_id: "c1",
					wall_time_seconds: 1.8,
					exit_code: 0,
					output: "....\n4 pass\n",
					original_token_count: 4,
				}),
			},
			{
				type: "input_text",
				text: JSON.stringify({
					chunk_id: "c2",
					wall_time_seconds: 0.1,
					exit_code: 0,
					output: " M src/net/retry.ts\n",
					original_token_count: 4,
				}),
			},
		],
	);
	call(
		"function_call",
		"spawn_agent",
		{
			message: "Review the retry port for edge cases.",
			agent_type: "reviewer",
		},
		'{"agent_id":"ag_1","status":"running"}',
	);
	item({
		type: "message",
		role: "assistant",
		content: [
			{
				type: "output_text",
				text: "Ported. Callers now import from `src/net`.",
			},
		],
	});
	out.push({
		timestamp: at(),
		type: "event_msg",
		payload: { type: "turn_aborted", reason: "interrupted" },
	});
	item({
		type: "message",
		role: "user",
		content: [
			{
				type: "input_text",
				text: "[pulsar] Message from claude@demo (claude, project:demo) · id m_1\n\nCan you also bump the version?",
			},
		],
	});
	out.push({ timestamp: at(), type: "compacted", payload: { message: "" } });
	return lines(out);
}

// ------------------------------------------------------------------ omp

/** An omp session (`~/.omp/agent/sessions/**\/*.jsonl`). */
export function ompLog(): string {
	const out: object[] = [];
	let n = 0;
	const msg = (message: object) =>
		out.push({ type: "message", id: `o${++n}`, timestamp: at(), message });
	const tool = (
		name: string,
		args: object,
		result: string,
		isError = false,
		images = false,
		details?: object,
	) => {
		const id = `tc_${++n}`;
		msg({
			role: "assistant",
			model: "omp-demo",
			content: [{ type: "toolCall", id, name, arguments: args }],
		});
		msg({
			role: "toolResult",
			toolCallId: id,
			toolName: name,
			isError,
			...(details ? { details } : {}),
			content: [
				{ type: "text", text: result },
				...(images
					? [{ type: "image", mimeType: "image/png", data: PNG }]
					: []),
			],
		});
	};
	msg({
		role: "user",
		content: [{ type: "text", text: "Profile the parser and plan the fix." }],
	});
	msg({
		role: "assistant",
		model: "omp-demo",
		content: [{ type: "thinking", thinking: "Measure first, then decide." }],
	});
	tool(
		"bash",
		{ command: "hyperfine 'bun parse.ts'", i: "Benchmark the parser" },
		"Time (mean ± σ): 412.3 ms ± 8.1 ms\nRange: 401.0 ms … 430.2 ms",
	);
	// `path:A-B` selects lines; omp returns just those lines.
	tool(
		"read",
		{ path: `${CWD}/src/parse.ts:12-14`, i: "Read the parser" },
		"export function parse(s: string) {\n  return JSON.parse(s);\n}",
	);
	tool(
		"edit",
		{
			path: `${CWD}/src/parse.ts`,
			old_string: "return JSON.parse(s);",
			new_string: "return fastParse(s);",
			i: "Use the fast parser",
		},
		"Edited src/parse.ts",
	);
	tool(
		"write",
		{
			path: `${CWD}/src/fast.ts`,
			content: "export const fastParse = (s: string) => JSON.parse(s);\n",
			i: "Add the fast parser",
		},
		"Wrote src/fast.ts",
	);
	// omp runs MCP tools through its `xd://` devices: a write of the args.
	tool(
		"read",
		{ path: "xd://mcp__issue_desk_label_issue", i: "Read the tool docs" },
		"# mcp__issue_desk_label_issue\nAdd a label to an issue.",
	);
	tool(
		"write",
		{
			path: "xd://mcp__issue_desk_label_issue",
			content: '{"issue":"PARSE-7","label":"perf","notify":false}',
			i: "Label the parser issue",
		},
		'{"issue":"PARSE-7","labels":["perf"]}',
		false,
		false,
		{
			xdev: {
				tool: "mcp__issue_desk_label_issue",
				mode: "execute",
				tier: "write",
				args: { issue: "PARSE-7", label: "perf", notify: false },
				inner: {
					serverName: "issue-desk",
					mcpToolName: "label_issue",
					provider: "mcp",
				},
			},
		},
	);
	tool(
		"eval",
		{
			language: "python",
			title: "Plot latency",
			code: "import statistics\nprint(statistics.mean([412, 405, 430]))",
		},
		"415.6666666666667",
		false,
		true,
	);
	// omp shows images in the terminal; its log keeps them as blob refs.
	{
		const id = `tc_${++n}`;
		msg({
			role: "assistant",
			model: "omp-demo",
			content: [
				{
					type: "toolCall",
					id,
					name: "read",
					arguments: {
						path: `${CWD}/shots/latency.webp`,
						i: "Look at the latency chart",
					},
				},
			],
		});
		msg({
			role: "toolResult",
			toolCallId: id,
			toolName: "read",
			isError: false,
			content: [
				{ type: "text", text: "Read image file [image/webp]" },
				{
					type: "image",
					mimeType: "image/webp",
					data: `blob:sha256:${"a1".repeat(32)}`,
				},
			],
		});
	}
	// omp groups grep matches under headers: `*N|` is a match, ` N|` context.
	tool(
		"grep",
		{ pattern: "JSON.parse", path: `${CWD}/src`, i: "Find other parse calls" },
		`# ${CWD}/src/\n## parse.ts\n 12|export function parse(s: string) {\n*13|  return JSON.parse(s);\n...\n## config/\n### load.ts\n*8|  return JSON.parse(raw);`,
		false,
		false,
		{ matchCount: 2, fileCount: 2 },
	);
	tool(
		"glob",
		{ path: `${CWD}/src/**/*.ts`, i: "List sources" },
		`# ${CWD}/src/\nparse.ts\nfast.ts\n## config/\nload.ts`,
		false,
		false,
		{ fileCount: 3 },
	);
	tool(
		"bash",
		{ command: "bun bench --watch", async: true, i: "Watch the benchmark" },
		"Started background job bg_2.",
	);
	tool(
		"write",
		{ path: "proc://bg_2", content: "q\n", i: "Stop the watcher" },
		"Sent 2 bytes to bg_2.",
	);
	tool(
		"read",
		{ path: "proc://bg_2", i: "Check the benchmark output" },
		"bench parse  412 ms\nbench fast   171 ms",
	);
	tool(
		"read",
		{ path: "https://docs.example.org/json", i: "Read the JSON docs" },
		"# JSON\nParse text into a value.",
	);
	tool(
		"web_fetch",
		{ url: "https://bench.example.org/parse", i: "Fetch published numbers" },
		"Fetch failed: 503",
		true,
	);
	tool(
		"todo",
		{ op: "done", task: "Benchmark parse", i: "Mark the benchmark done" },
		"Todo list (3):\n  - Benchmark parse [done]",
	);
	tool(
		"todo",
		{
			op: "set",
			list: [
				{ phase: "Measure", items: ["Benchmark parse", "Profile hot path"] },
				{ phase: "Fix", items: ["Swap in fastParse"] },
			],
			i: "Plan",
		},
		"Todo list (3):\n  - Benchmark parse [done]",
	);
	tool(
		"task",
		{
			context: "Parser speed work",
			tasks: [
				{
					name: "BenchConfig",
					task: "Benchmark config parsing",
					agent: "explore",
				},
				{ name: "BenchCli", task: "Benchmark CLI parsing" },
			],
			i: "Benchmark the other parsers",
		},
		"Started 2 background tasks.\n- `BenchConfig`\n- `BenchCli`",
	);
	tool(
		"ask",
		{
			html: "<p>Ship the <b>fast</b> parser now?</p><img src=x onerror=alert(1)>",
			i: "Ship the fast parser now?",
		},
		'User response:\n{\n  "choice": "ship_now"\n}',
	);
	tool(
		"web_search",
		{
			query: "fast json parse bun",
			max_results: 5,
			i: "Look for faster parsers",
		},
		"No results: search provider unavailable",
		true,
	);
	tool("goal", { op: "complete" }, "Goal complete: parser is 2.4× faster.");
	tool(
		"wait",
		{ i: "Wait for the benchmarks" },
		"## Completed (2)\n\n### BenchConfig — done\n### BenchCli — done",
	);
	out.push({
		type: "custom_message",
		id: `o${++n}`,
		timestamp: at(),
		customType: "async-result",
		content:
			"<system-notice>\nBackground job bg_2 (bun bench) completed.\n</system-notice>",
		details: { jobs: [] },
	});
	out.push({
		type: "custom_message",
		id: `o${++n}`,
		timestamp: at(),
		customType: "irc:incoming",
		content: "<irc>message</irc>",
		details: {
			from: "reviewer@demo",
			message: "Benchmarks look good, ship it.",
		},
	});
	out.push({
		type: "compaction",
		id: `o${++n}`,
		timestamp: at(),
		shortSummary: "Compacted 40 turns",
		summary: "…",
	});
	msg({
		role: "assistant",
		model: "omp-demo",
		content: [
			{
				type: "text",
				text: "The fast parser is **2.4× faster**. Shipping it.",
			},
		],
	});
	return lines(out);
}

/** A system row between harness sections of the gallery. */
function section(id: string, text: string): TranscriptEvent {
	return { id, ts: 0, role: "system", kind: "system", text };
}

/**
 * Every block, parsed by the daemon's parsers: Claude, then Codex, then omp.
 * Ids are prefixed per harness; `imageUrl` gives each image its URL.
 */
export function galleryEvents(
	imageUrl: (imageId: string) => string = () => "",
): TranscriptEvent[] {
	clock = T0;
	const parse = (
		prefix: string,
		text: string,
		fn: typeof parseClaude,
	): TranscriptEvent[] =>
		fn(text, newParseState({ atStart: false, cwd: CWD })).map((e) => {
			const id = `${prefix}:${e.id}`;
			return {
				...e,
				id,
				...(e.images
					? {
							images: e.images.map((im) => {
								const imageId = `${prefix}:${im.id}`;
								return { ...im, id: imageId, url: imageUrl(imageId) };
							}),
						}
					: {}),
				...(e.documents
					? {
							documents: e.documents.map((d) => {
								const docId = `${prefix}:${d.id}`;
								return { ...d, id: docId, url: imageUrl(docId) };
							}),
						}
					: {}),
			};
		});
	const merged = (events: TranscriptEvent[]) => {
		// The live tail re-sends a call with its result folded in: keep the last.
		const byId = new Map<string, TranscriptEvent>();
		for (const e of events) byId.set(e.id, e);
		return [...byId.values()];
	};
	return [
		section("g:claude", "Claude Code"),
		...merged(parse("claude", claudeLog(), parseClaude)),
		section("g:codex", "Codex"),
		...merged(parse("codex", codexLog(), parseCodex)),
		section("g:omp", "omp"),
		...merged(parse("omp", ompLog(), parsePi)),
		...pulsarGallery(parse, merged),
	];
}
