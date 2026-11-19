/**
 * What a tool call is, in words people use: one registry for every harness's
 * tool names (Claude, Codex, pi/omp, OpenCode, MCP), shared by the daemon's
 * one-line summaries and the web app's tool cards. Pure: no I/O, no DOM.
 */
import { execCalls, isShell, shellCommand } from "./command.ts";
import type { ToolDetail } from "./types.ts";

export { shellCommand };

export type ToolKind =
	| "shell"
	| "code"
	| "read"
	| "image"
	| "edit"
	| "patch"
	| "write"
	| "notebook"
	| "search"
	| "list"
	| "websearch"
	| "fetch"
	| "todo"
	| "plan"
	| "question"
	| "task"
	| "message"
	| "wait"
	| "skill"
	| "tools"
	| "mcp"
	| "advisor"
	| "other";

/** How the target reads: a path, a command, a search query, a URL, a name, words. */
export type TargetAs = "path" | "cmd" | "query" | "url" | "name" | "text";

export interface ToolLine {
	kind: ToolKind;
	/** "Ran", "Searched the web for", "Called"... (past tense once done). */
	verb: string;
	target?: { text: string; as: TargetAs };
	/** Short facts from the call alone: "3 of 7 done", "lines 10–40", "Python". */
	facts: string[];
}

const KINDS: Record<string, ToolKind> = {};
const add = (kind: ToolKind, ...names: string[]) => {
	for (const n of names) KINDS[n] = kind;
};
add(
	"shell",
	"bash",
	"shell",
	"exec_command",
	"local_shell",
	"local_shell_call",
	"run_terminal_cmd",
	"monitor",
	"bashoutput",
	"bash_output",
	"killshell",
	"kill_shell",
	"taskstop",
	"write_stdin",
);
add("code", "exec", "eval");
add("read", "read", "view", "read_file", "notebookread", "cat");
add("image", "view_image");
add("edit", "edit", "multiedit", "str_replace", "str_replace_editor");
add("patch", "apply_patch", "patch");
add("write", "write", "create", "write_file");
add("notebook", "notebookedit", "notebook_edit");
add("search", "grep", "search", "rg", "codebase_search");
add("list", "glob", "ls", "find", "list", "list_dir");
add("websearch", "websearch", "web_search", "web_search_call");
add("fetch", "webfetch", "web_fetch", "fetch");
add("todo", "todowrite", "todoread", "update_plan", "todo");
add("plan", "exitplanmode", "enterplanmode");
add("question", "askuserquestion", "ask", "question", "request_user_input");
add("task", "task", "agent", "spawn_agent");
add("message", "sendmessage", "send_message", "send_input");
add("wait", "wait", "wait_agent");
add("skill", "skill");
add("tools", "toolsearch");
add("advisor", "advisor");

/**
 * `mcp__linear__create_issue` → linear / create_issue; null for other tools.
 * omp's minted `mcp__<server>_<tool>` can't say where the server ends
 * (`apple-mail` mints `apple_mail`), so it keeps the whole name as the tool
 * with no server.
 */
function mcpName(name: string): { server: string; tool: string } | null {
	const m =
		/^mcp__(.+?)__(.+)$/i.exec(name) ??
		// pi/omp: `mcp_<server>_<tool>` (the server name has no underscore).
		/^mcp_([a-z0-9-]+)_(.+)$/i.exec(name);
	if (m) return { server: m[1]!, tool: m[2]! };
	const minted = /^mcp__([a-z0-9][a-z0-9_]*)$/i.exec(name);
	return minted ? { server: "", tool: minted[1]! } : null;
}

/** "linear.create_issue", or just the tool when the server isn't known. */
const mcpLabel = (m: { server: string; tool: string }) =>
	m.server ? `${m.server}.${m.tool}` : m.tool;

export function toolKind(name: string): ToolKind {
	if (mcpName(name)) return "mcp";
	return KINDS[name.toLowerCase()] ?? "other";
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};

/** First line, whitespace collapsed, cut at `max` with an ellipsis. */
export function oneLine(text: string, max = 80): string {
	const first = text.trim().split("\n")[0] ?? "";
	const flat = first.replace(/\s+/g, " ").trim();
	const more = text.trim().includes("\n") ? " …" : "";
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat + more;
}

/** "NotebookEdit" → "Notebook edit"; "schedule_wakeup" → "Schedule wakeup". */
export function toolLabel(name: string): string {
	const mcp = mcpName(name);
	if (mcp) return mcpLabel(mcp);
	const words = name
		.replace(/[_-]+/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The file a call works on, from any harness's argument name. */
export function toolPath(input: unknown): string {
	const a = rec(input);
	return (
		str(a.file_path) ||
		str(a.path) ||
		str(a.notebook_path) ||
		str(a.filePath) ||
		str(a.target_file)
	);
}

export interface Todo {
	text: string;
	status: "done" | "active" | "todo" | "cancelled";
}

function todoStatus(v: unknown): Todo["status"] {
	const s = str(v).toLowerCase();
	if (s === "completed" || s === "done" || s === "complete") return "done";
	if (s === "in_progress" || s === "active" || s === "in-progress")
		return "active";
	if (s === "cancelled" || s === "canceled") return "cancelled";
	return "todo";
}

/**
 * A plan/checklist from TodoWrite (`todos`), Codex update_plan (`plan`),
 * OpenCode todowrite, or omp todo (`list: [{phase, items}]`); null when the
 * call carries none (a read, an omp "done" op).
 */
export function todos(input: unknown): Todo[] | null {
	const a = rec(input);
	let list: unknown[] | null = null;
	if (Array.isArray(a.todos)) list = a.todos;
	else if (Array.isArray(a.plan)) list = a.plan;
	if (list)
		return list.map((t) => {
			const o = rec(t);
			return {
				text: str(o.content) || str(o.step) || str(o.text) || str(t),
				status: todoStatus(o.status),
			};
		});
	if (Array.isArray(a.list)) {
		const out: Todo[] = [];
		for (const phase of a.list)
			for (const item of Array.isArray(rec(phase).items)
				? (rec(phase).items as unknown[])
				: [])
				out.push({
					text: str(item) || str(rec(item).text),
					status: todoStatus(rec(item).status),
				});
		return out;
	}
	return null;
}

export interface Question {
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string }>;
	multi?: boolean;
}

/** AskUserQuestion / OpenCode question `questions`; a single `question` too. */
export function questions(input: unknown): Question[] {
	const a = rec(input);
	const list = Array.isArray(a.questions)
		? a.questions
		: str(a.question)
			? [a]
			: [];
	return list.map((q) => {
		const o = rec(q);
		const options = Array.isArray(o.options) ? o.options : [];
		return {
			question: str(o.question) || str(o.text),
			...(str(o.header) ? { header: str(o.header) } : {}),
			options: options.map((x) => {
				const opt = rec(x);
				return {
					label: str(opt.label) || str(x),
					...(str(opt.description)
						? { description: str(opt.description) }
						: {}),
				};
			}),
			...(o.multiSelect === true || o.multiple === true ? { multi: true } : {}),
		};
	});
}

export interface PatchFile {
	path: string;
	op: "add" | "update" | "delete";
	moveTo?: string;
	/** The file's hunk lines with their +/-/space prefix. */
	lines: string[];
	added: number;
	removed: number;
}

/** The files in an `apply_patch` envelope (`*** Begin Patch` … `*** End Patch`). */
export function patchFiles(patch: string): PatchFile[] {
	const files: PatchFile[] = [];
	let cur: PatchFile | null = null;
	for (const line of patch.split("\n")) {
		const head = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(line);
		if (head) {
			cur = {
				path: head[2]!.trim(),
				op: head[1]!.toLowerCase() as PatchFile["op"],
				lines: [],
				added: 0,
				removed: 0,
			};
			files.push(cur);
			continue;
		}
		if (!cur || line.startsWith("*** End")) continue;
		const move = /^\*\*\* Move to: (.+)$/.exec(line);
		if (move) {
			cur.moveTo = move[1]!.trim();
			continue;
		}
		if (line.startsWith("@@")) {
			cur.lines.push(line);
			continue;
		}
		if (line.startsWith("+")) cur.added++;
		else if (line.startsWith("-")) cur.removed++;
		cur.lines.push(line);
	}
	return files;
}

function patchText(input: unknown): string {
	return typeof input === "string"
		? input
		: str(rec(input).input) || str(rec(input).patch);
}

function lineCount(text: string): number {
	return text ? text.replace(/\n$/, "").split("\n").length : 0;
}

/** Added/removed line counts of an Edit/MultiEdit call. */
export function editStats(input: unknown): { added: number; removed: number } {
	const a = rec(input);
	const edits = Array.isArray(a.edits) ? a.edits : [a];
	let added = 0;
	let removed = 0;
	for (const e of edits) {
		const o = rec(e);
		added += lineCount(
			str(o.new_string) || str(o.newText) || str(o.new_str) || str(o.newString),
		);
		removed += lineCount(
			str(o.old_string) || str(o.oldText) || str(o.old_str) || str(o.oldString),
		);
	}
	return { added, removed };
}

/** A path relative to the agent's folder when it is inside it. */
export function shortPath(path: string, cwd: string | null): string {
	if (cwd && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	return path;
}

/**
 * omp's read selector at the end of a path: `a.ts:10-40` (lines), `a.ts:5+20`
 * (5 and the next 20), `a.ts:-30` (the last 30), `a.ts:raw`, or several,
 * comma-separated. A URL's port is not a selector.
 */
export function pathSelector(path: string): {
	path: string;
	ranges: Array<{ start: number; end?: number; last?: number }>;
	raw: boolean;
} | null {
	const m =
		/^(.+?):((?:raw|\d+(?:[-+]\d+)?|-\d+)(?:[,:](?:raw|\d+(?:[-+]\d+)?|-\d+))*)$/i.exec(
			path,
		);
	if (!m || /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(m[1]!)) return null;
	const ranges: Array<{ start: number; end?: number; last?: number }> = [];
	let raw = false;
	for (const chunk of m[2]!.split(/[,:]/)) {
		if (/^raw$/i.test(chunk)) raw = true;
		else if (chunk.startsWith("-"))
			ranges.push({ start: 0, last: Number(chunk.slice(1)) });
		else {
			const [a, op, b] = /^(\d+)(?:([-+])(\d+))?$/.exec(chunk)!.slice(1);
			const start = Number(a);
			ranges.push(
				op === "+"
					? { start, end: start + Number(b) }
					: { start, ...(b ? { end: Number(b) } : {}) },
			);
		}
	}
	return { path: m[1]!, ranges, raw };
}

/** Facts for a read selector: "lines 10–40", "last 30 lines", "raw". */
function selectorFacts(
	sel: NonNullable<ReturnType<typeof pathSelector>>,
): string[] {
	const out = sel.ranges.map((r) =>
		r.last
			? `last ${r.last} lines`
			: r.end
				? `lines ${r.start}–${r.end}`
				: `from line ${r.start}`,
	);
	if (sel.raw) out.push("raw");
	return out;
}

/** The first short string argument worth showing for an unknown tool. */
function firstString(a: Record<string, unknown>): string {
	for (const key of [
		"description",
		"i",
		"title",
		"query",
		"url",
		"name",
		"to",
		"prompt",
		"message",
		"id",
	]) {
		const v = str(a[key]);
		if (v.trim()) return v;
	}
	for (const v of Object.values(a))
		if (typeof v === "string" && v.trim() && v.length < 200) return v;
	return "";
}

const LANG: Record<string, string> = {
	py: "Python",
	python: "Python",
	js: "JavaScript",
	javascript: "JavaScript",
	ts: "TypeScript",
	typescript: "TypeScript",
	sh: "shell",
	bash: "shell",
	rb: "Ruby",
	ruby: "Ruby",
};

/** Describes a call from its name and arguments (`done`: past tense). */
export function describeCall(
	name: string,
	input: unknown,
	opts: { cwd?: string | null; done?: boolean } = {},
): ToolLine {
	const done = opts.done ?? true;
	const cwd = opts.cwd ?? null;
	const v = (past: string, now: string) => (done ? past : now);
	const lower = name.toLowerCase();
	const kind = toolKind(name);
	const a = rec(input);
	const rawPath = toolPath(input);
	const path = rawPath ? shortPath(rawPath, cwd) : "";
	const facts: string[] = [];
	const t = (text: string, as: TargetAs) =>
		text.trim() ? { text: text.trim(), as } : undefined;
	switch (kind) {
		case "shell": {
			if (lower === "monitor")
				return {
					kind,
					verb: v("Watched", "Watching"),
					target:
						t(str(a.description), "text") ?? t(shellCommand(input), "cmd"),
					facts,
				};
			if (lower === "bashoutput" || lower === "bash_output")
				return {
					kind,
					verb: v("Checked output of", "Checking output of"),
					target: t(str(a.bash_id) || str(a.shell_id), "name"),
					facts,
				};
			if (
				lower === "killshell" ||
				lower === "kill_shell" ||
				lower === "taskstop"
			)
				return {
					kind,
					verb: v("Stopped", "Stopping"),
					target: t(
						str(a.task_id) || str(a.shell_id) || str(a.bash_id),
						"name",
					),
					facts,
				};
			if (lower === "write_stdin")
				return {
					kind,
					verb: v("Sent input to", "Sending input to"),
					target: t(String(a.session_id ?? ""), "name"),
					facts,
				};
			// omp: `async: true` runs the command as a background job.
			if (a.async === true) facts.push("in background");
			return {
				kind,
				verb: v("Ran", "Running"),
				target: t(shellCommand(input), "cmd"),
				facts,
			};
		}
		case "code": {
			if (typeof input === "string") {
				// Codex code mode: a script calling tools.exec_command(…).
				const steps = name === "exec" ? execCalls(input) : [];
				const cmds = steps.filter(isShell);
				if (cmds.length) {
					if (steps.length > 1) facts.push(`+${steps.length - 1} more`);
					return {
						kind,
						verb: v("Ran", "Running"),
						target: t(cmds[0]!.cmd, "cmd"),
						facts,
					};
				}
				return {
					kind,
					verb: v("Ran script", "Running script"),
					target: t(oneLine(input, 60), "text"),
					facts,
				};
			}
			const lang = LANG[str(a.language).toLowerCase()] ?? str(a.language);
			return {
				kind,
				verb: v(
					lang ? `Ran ${lang}` : "Ran code",
					lang ? `Running ${lang}` : "Running code",
				),
				target: t(str(a.title) || str(a.i) || oneLine(str(a.code), 60), "text"),
				facts,
			};
		}
		case "read": {
			// omp: `read xd://<device>` returns the device's docs.
			if (/^xd:\/\//i.test(path))
				return {
					kind,
					verb: v("Read docs for", "Reading docs for"),
					target: t(
						path
							.slice(5)
							.replace(/^mcp__/i, "")
							.replace(/:raw$/i, "") || "all tools",
						"name",
					),
					facts,
				};
			const off = Number(a.offset);
			const lim = Number(a.limit);
			if (Number.isFinite(off) && off > 0 && Number.isFinite(lim) && lim > 0)
				facts.push(`lines ${off}–${off + lim - 1}`);
			// omp: one `path` may name several files and end in a selector.
			const files = rawPath.split(/,\s+/).map((one) => {
				const sel = pathSelector(one);
				if (sel) facts.push(...selectorFacts(sel));
				return shortPath(sel?.path ?? one, cwd);
			});
			if (files.length === 1 && /^proc:\/\//i.test(files[0]!))
				return {
					kind,
					verb: v("Read output of", "Reading output of"),
					target: t(files[0]!.slice(7), "name"),
					facts,
				};
			if (files.length === 1 && /^https?:\/\//i.test(files[0]!))
				return {
					kind,
					verb: v("Fetched", "Fetching"),
					target: t(files[0]!, "url"),
					facts,
				};
			return {
				kind,
				verb: v("Read", "Reading"),
				target: t(files.join(", "), "path"),
				facts,
			};
		}
		case "image":
			return {
				kind,
				verb: v("Viewed", "Viewing"),
				target: t(path, "path"),
				facts,
			};
		case "edit": {
			const { added, removed } = editStats(input);
			if (added || removed) facts.push(`+${added} −${removed}`);
			const n = Array.isArray(a.edits) ? a.edits.length : 0;
			if (n > 1) facts.unshift(`${n} edits`);
			return {
				kind,
				verb: v("Edited", "Editing"),
				target: t(path, "path"),
				facts,
			};
		}
		case "patch": {
			const files = patchFiles(patchText(input));
			const added = files.reduce((n, f) => n + f.added, 0);
			const removed = files.reduce((n, f) => n + f.removed, 0);
			if (files.length === 1) {
				const f = files[0]!;
				let verb = v("Edited", "Editing");
				if (f.op === "add") verb = v("Created", "Creating");
				else if (f.op === "delete") verb = v("Deleted", "Deleting");
				return {
					kind,
					verb,
					target: t(shortPath(f.path, cwd), "path"),
					facts: [`+${added} −${removed}`],
				};
			}
			return {
				kind,
				verb: v("Patched", "Patching"),
				target: t(files.length ? `${files.length} files` : "files", "text"),
				facts: files.length ? [`+${added} −${removed}`] : [],
			};
		}
		case "write": {
			// omp: writing to a background job's `proc://` sends it input.
			if (/^proc:\/\//i.test(path))
				return {
					// Not a file: no diff stat, its input and reply as they are.
					kind: "other",
					verb: v("Sent input to", "Sending input to"),
					target: t(path.slice(7), "name"),
					facts,
				};
			const n = lineCount(str(a.content));
			if (n) facts.push(`${n} ${n === 1 ? "line" : "lines"}`);
			return {
				kind,
				verb: v("Wrote", "Writing"),
				target: t(path, "path"),
				facts,
			};
		}
		case "notebook": {
			const mode = str(a.edit_mode);
			let verb = v("Edited a cell in", "Editing a cell in");
			if (mode === "insert") verb = v("Added a cell to", "Adding a cell to");
			else if (mode === "delete")
				verb = v("Deleted a cell in", "Deleting a cell in");
			return {
				kind,
				verb,
				target: t(path, "path"),
				facts,
			};
		}
		case "search": {
			const q = str(a.pattern) || str(a.query) || str(a.regex);
			const where = str(a.path) || str(a.glob) || str(a.include);
			if (where) facts.push(`in ${shortPath(where, cwd)}`);
			return {
				kind,
				verb: v("Searched for", "Searching for"),
				target: t(q, "query"),
				facts,
			};
		}
		case "list": {
			const q = str(a.pattern) || str(a.glob);
			if (q && path) facts.push(`in ${path}`);
			return {
				kind,
				verb: v(q ? "Found files" : "Listed", q ? "Finding files" : "Listing"),
				target: q ? t(q, "query") : t(path, "path"),
				facts,
			};
		}
		case "websearch": {
			const action = rec(a.action);
			const q =
				str(a.query) ||
				str(action.query) ||
				(Array.isArray(action.queries) ? str(action.queries[0]) : "");
			return {
				kind,
				verb: v("Searched the web for", "Searching the web for"),
				target: t(q, "query"),
				facts,
			};
		}
		case "fetch":
			return {
				kind,
				verb: v("Fetched", "Fetching"),
				target: t(str(a.url), "url"),
				facts,
			};
		case "todo": {
			const list = todos(input);
			if (list?.length) {
				const doneN = list.filter((x) => x.status === "done").length;
				facts.push(`${doneN} of ${list.length} done`);
			}
			const op = str(a.op);
			// omp: one task changes state ("done", "start", "drop").
			const task = str(a.task);
			const TODO_OPS: Record<string, [string, string]> = {
				done: ["Checked off", "Checking off"],
				start: ["Started", "Starting"],
				drop: ["Dropped", "Dropping"],
				rm: ["Removed", "Removing"],
			};
			if (task && TODO_OPS[op])
				return {
					kind,
					verb: v(...TODO_OPS[op]!),
					target: t(task, "text"),
					facts,
				};
			return {
				kind,
				verb:
					lower === "todoread" || op === "list" || op === "get"
						? v("Checked the plan", "Checking the plan")
						: v("Updated the plan", "Updating the plan"),
				target: op && !list ? t(op, "name") : undefined,
				facts,
			};
		}
		case "plan":
			return {
				kind,
				verb:
					lower === "enterplanmode"
						? v("Started planning", "Starting to plan")
						: v("Proposed a plan", "Proposing a plan"),
				facts,
			};
		case "question": {
			const qs = questions(input);
			if (qs.length > 1) facts.push(`${qs.length} questions`);
			return {
				kind,
				verb: v("Asked you", "Asking you"),
				target: t(qs[0]?.question || str(a.i), "text"),
				facts,
			};
		}
		case "task": {
			const tasks = Array.isArray(a.tasks) ? a.tasks : null;
			if (tasks && tasks.length > 1) facts.push(`${tasks.length} tasks`);
			const first = tasks ? rec(tasks[0]) : {};
			return {
				kind,
				verb: v("Ran subagent", "Running subagent"),
				target: t(
					str(a.description) ||
						str(a.name) ||
						str(a.i) ||
						str(first.name) ||
						str(a.message) ||
						str(a.task),
					"text",
				),
				facts: [
					...(str(a.subagent_type) || str(a.agent_type)
						? [str(a.subagent_type) || str(a.agent_type)]
						: []),
					...facts,
				],
			};
		}
		case "message":
			return {
				kind,
				verb: v("Messaged", "Messaging"),
				target: t(
					str(a.to) || str(a.recipient) || str(a.target) || str(a.id),
					"name",
				),
				facts,
			};
		case "wait": {
			const ids = Array.isArray(a.ids) ? a.ids.map(String) : [];
			if (ids.length)
				return {
					kind,
					verb: v("Waited for", "Waiting for"),
					target: t(ids.join(", "), "name"),
					facts,
				};
			return {
				kind,
				verb: v("Waited", "Waiting"),
				target: t(str(a.i), "text"),
				facts,
			};
		}
		case "skill":
			return {
				kind,
				verb: v("Loaded skill", "Loading skill"),
				target: t(str(a.skill) || str(a.name), "name"),
				facts,
			};
		case "tools":
			return {
				kind,
				verb: v("Loaded tools", "Loading tools"),
				target: t(str(a.query).replace(/^select:/, ""), "query"),
				facts,
			};
		case "mcp": {
			const m = mcpName(name)!;
			const arg = firstString(a);
			return {
				kind,
				verb: v("Called", "Calling"),
				target: { text: mcpLabel(m), as: "name" },
				facts: arg ? [oneLine(arg, 60)] : [],
			};
		}
		case "advisor":
			return {
				kind,
				verb: v("Asked the advisor", "Asking the advisor"),
				facts,
			};
		default: {
			const label = toolLabel(name);
			return {
				kind,
				verb: label,
				target: t(path || oneLine(firstString(a), 80), path ? "path" : "text"),
				facts,
			};
		}
	}
}

/** The call as one line of plain text: "Searched the web for "X" · 3 of 7 done". */
export function callLine(line: ToolLine): string {
	let target = "";
	if (line.target?.as === "cmd") target = `\`${oneLine(line.target.text)}\``;
	else if (line.target?.as === "query")
		target = `"${oneLine(line.target.text, 60)}"`;
	else if (line.target) target = oneLine(line.target.text);
	// "Asked you: Which approach?" reads as a quote, not an object.
	const sep = line.kind === "question" || line.kind === "wait" ? ": " : " ";
	return [[line.verb, target].filter(Boolean).join(sep), ...line.facts].join(
		" · ",
	);
}

/** "2 min", "45 s": a timeout as people say it. */
function span(ms: number): string {
	if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
	return `${Math.round(ms / 1000)} s`;
}

const noun = (n: number, one: string, many = `${one}s`) =>
	`${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/**
 * Short facts about a result, worst first: "denied", "interrupted",
 * "timed out after 2 min", "exit 1", "8 results", "120 lines".
 */
export function resultFacts(
	kind: ToolKind,
	detail: ToolDetail | undefined,
	isError: boolean | undefined,
): string[] {
	const d = detail ?? {};
	if (d.denied) return ["denied"];
	if (d.interrupted) return ["interrupted"];
	if (d.timedOutMs) return [`timed out after ${span(d.timedOutMs)}`];
	if (d.background) return ["in background"];
	const out: string[] = [];
	if (kind === "shell" && d.exitCode !== undefined && d.exitCode !== 0)
		out.push(`exit ${d.exitCode}`);
	else if (isError) out.push("failed");
	if (isError) return out;
	if (d.links) out.push(noun(d.links.length, "result"));
	if (d.answers?.length) out.push(`“${oneLine(d.answers[0]!.answer, 40)}”`);
	if (d.count !== undefined)
		out.push(
			kind === "list"
				? noun(d.count, "file")
				: d.count === 0
					? "no matches"
					: noun(d.count, "match", "matches"),
		);
	if (d.lines !== undefined && (kind === "read" || kind === "tools"))
		out.push(kind === "tools" ? noun(d.lines, "tool") : noun(d.lines, "line"));
	return out;
}
