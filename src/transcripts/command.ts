/**
 * Shell commands as people read them, for every harness: what ran, where,
 * and why. One normalized shape (`CommandRun`) for Claude's Bash, Codex's
 * exec_command / local_shell / code-mode scripts, OpenCode's and pi/omp's
 * bash. Pure: no I/O, no DOM, and nothing here runs code. A Codex script
 * is read with a small tokenizer, never evaluated.
 */

/** One command a call ran, with the folder it ran in when the call says. */
export interface ShellStep {
	cmd: string;
	/** The `workdir` / `cwd` the call gave, as written. */
	cwd?: string;
}

/** A script call the tokenizer could not read: shown as its source. */
export interface ScriptStep {
	call: string;
}

export type CommandStep = ShellStep | ScriptStep;

export interface CommandRun {
	/** In order; at least one. */
	steps: CommandStep[];
	/** The agent's words for the command (Claude's `description`, omp's `i`). */
	description?: string;
	/** Started in the background. */
	background?: boolean;
	/** The script the commands came from (Codex code mode). */
	script?: { code: string; lang: "typescript" };
}

const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** A shell call's command line: `command`/`cmd`, a string or an argv array. */
export function shellCommand(input: unknown): string {
	const a = rec(input);
	const action = rec(a.action);
	const cmd = a.command ?? a.cmd ?? action.command;
	if (Array.isArray(cmd)) {
		const argv = cmd.map(String);
		// Codex local_shell: ["bash", "-lc", "<script>"].
		if (argv.length === 3 && /sh$/.test(argv[0]!) && argv[1] === "-lc")
			return argv[2]!;
		return argv.join(" ");
	}
	return typeof cmd === "string" ? cmd : "";
}

/**
 * A shell or script call as a `CommandRun`; null when the call names no
 * command (BashOutput, a script with no `tools.exec_command`).
 */
export function commandRun(name: string, input: unknown): CommandRun | null {
	if (typeof input === "string") {
		// Codex code mode: a script that calls tools.exec_command(…).
		if (name !== "exec") return null;
		const steps = execCalls(input);
		if (!steps.some(isShell)) return null;
		return { steps, script: { code: input, lang: "typescript" } };
	}
	const a = rec(input);
	const cmd = shellCommand(input);
	if (!cmd.trim()) return null;
	const action = rec(a.action);
	const cwd =
		str(a.workdir) ??
		str(a.cwd) ??
		str(a.working_directory) ??
		str(action.working_directory);
	const run: CommandRun = { steps: [{ cmd, ...(cwd ? { cwd } : {}) }] };
	const description = str(a.description) ?? str(a.i) ?? str(a.justification);
	if (description) run.description = description;
	if (a.run_in_background === true || a.async === true) run.background = true;
	return run;
}

export const isShell = (s: CommandStep): s is ShellStep => "cmd" in s;

// ------------------------------------------------------------------ tokenizer

/** Longest script the tokenizer reads; longer input yields what it found so far. */
const SCRIPT_MAX = 200_000;
/** Most calls kept from one script. */
const CALLS_MAX = 50;

/**
 * Every `tools.exec_command(…)` call in a script, in source order: the
 * command (and `workdir`) when the argument is a string literal, a template
 * literal, or an object literal whose `cmd` is one; else the call's source
 * text. A `const NAME = "…"` earlier in the script resolves `NAME` (as a
 * value, a shorthand field or `${NAME}` in a template); nothing else is
 * resolved. Comments and strings are skipped, so a call inside either is
 * not a call. Unterminated input stops the scan.
 */
export function execCalls(script: string): CommandStep[] {
	const src = script.slice(0, SCRIPT_MAX);
	const out: CommandStep[] = [];
	const consts: Consts = new Map();
	let i = 0;
	while (i < src.length && out.length < CALLS_MAX) {
		const c = src[i]!;
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			i = nl < 0 ? src.length : nl + 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			i = end < 0 ? src.length : end + 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			const s = readString(src, i);
			if (!s) break;
			i = s.end;
			continue;
		}
		const word = !/[\w$.]/.test(src[i - 1] ?? "");
		const m = word
			? /^tools\s*\.\s*exec_command\s*\(/.exec(src.slice(i, i + 40))
			: null;
		if (m) {
			const start = i;
			const args = i + m[0].length;
			const end = closeParen(src, args);
			if (end < 0) break;
			out.push(
				callStep(src, args, end, consts) ?? { call: src.slice(start, end + 1) },
			);
			i = end + 1;
			continue;
		}
		const decl = word
			? /^const\s+([A-Za-z_$][\w$]*)\s*=\s*/.exec(src.slice(i, i + 80))
			: null;
		if (decl) {
			const at = i + decl[0].length;
			const q = src[at];
			if (q === '"' || q === "'" || q === "`") {
				const v = readString(src, at, consts);
				if (!v) break;
				const after = skipSpace(src, v.end);
				if (
					v.value !== null &&
					/^[;\n]|^$/.test(src[after] ?? "") &&
					!consts.has(decl[1]!)
				)
					consts.set(decl[1]!, v.value);
				i = v.end;
				continue;
			}
			i = at;
			continue;
		}
		i++;
	}
	return out;
}

/** String constants a script declared (`const NAME = "…"`), by name. */
type Consts = Map<string, string>;

/** The step for the argument source `src[from, to)`, or null when it can't be read. */
function callStep(
	src: string,
	from: number,
	to: number,
	consts: Consts,
): ShellStep | null {
	let i = skipSpace(src, from);
	const c = src[i];
	if (c === '"' || c === "'" || c === "`") {
		const s = readString(src, i, consts);
		if (!s || s.value === null) return null;
		i = skipSpace(src, s.end);
		return src[i] === ")" || src[i] === "," ? { cmd: s.value } : null;
	}
	if (c !== "{") {
		const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64))?.[0];
		const value = id ? consts.get(id) : undefined;
		const next = id ? skipSpace(src, i + id.length) : -1;
		return value !== undefined && (src[next] === ")" || src[next] === ",")
			? { cmd: value }
			: null;
	}
	const fields = objectFields(src, i + 1, to, consts);
	const cmd = fields?.get("cmd") ?? fields?.get("command");
	if (typeof cmd !== "string") return null;
	const cwd = fields?.get("workdir") ?? fields?.get("cwd");
	return { cmd, ...(typeof cwd === "string" && cwd ? { cwd } : {}) };
}

/**
 * An object literal's fields from just after `{`: string values as strings,
 * anything else as null (present, not readable). Null when it isn't a plain
 * literal the tokenizer can follow (shorthand, spread, computed keys).
 */
function objectFields(
	src: string,
	from: number,
	limit: number,
	consts: Consts,
): Map<string, string | null> | null {
	const fields = new Map<string, string | null>();
	let i = from;
	while (i < limit) {
		i = skipSpace(src, i);
		if (src[i] === "}") return fields;
		let key: string;
		const q = src[i];
		if (q === '"' || q === "'") {
			const s = readString(src, i);
			if (!s || s.value === null) return null;
			key = s.value;
			i = s.end;
		} else {
			const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
			if (!m) return null;
			key = m[0];
			i += key.length;
		}
		i = skipSpace(src, i);
		if (src[i] === "," || src[i] === "}") {
			// Shorthand `{ cmd }`: a constant, else present and unreadable.
			fields.set(key, consts.get(key) ?? null);
			if (src[i] === ",") i++;
			continue;
		}
		if (src[i] !== ":") return null;
		i = skipSpace(src, i + 1);
		const v = src[i];
		let value: string | null = null;
		const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64))?.[0];
		const afterId = id ? skipSpace(src, i + id.length) : -1;
		if (id && (src[afterId] === "," || src[afterId] === "}")) {
			value = consts.get(id) ?? null;
			i = afterId;
		} else if (v === '"' || v === "'" || v === "`") {
			const s = readString(src, i, consts);
			if (!s) return null;
			value = s.value;
			i = skipSpace(src, s.end);
			// `"a" + b` and the like: present, not readable.
			if (src[i] !== "," && src[i] !== "}") {
				value = null;
				i = skipValue(src, i, limit);
				if (i < 0) return null;
			}
		} else {
			i = skipValue(src, i, limit);
			if (i < 0) return null;
		}
		fields.set(key, value);
		i = skipSpace(src, i);
		if (src[i] === ",") i++;
		else if (src[i] !== "}") return null;
	}
	return null;
}

/** Past one value: to the `,` or `}` that ends it at depth 0, or -1. */
function skipValue(src: string, from: number, limit: number): number {
	let depth = 0;
	let i = from;
	while (i < limit) {
		const c = src[i]!;
		if (c === '"' || c === "'" || c === "`") {
			const s = readString(src, i);
			if (!s) return -1;
			i = s.end;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return c === "}" ? i : -1;
			depth--;
		} else if (c === "," && depth === 0) return i;
		i++;
	}
	return -1;
}

/** The `)` that closes the `(` before `from`, skipping strings and comments; -1 if none. */
function closeParen(src: string, from: number): number {
	let depth = 0;
	let i = from;
	while (i < src.length) {
		const c = src[i]!;
		if (c === '"' || c === "'" || c === "`") {
			const s = readString(src, i);
			if (!s) return -1;
			i = s.end;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const nl = src.indexOf("\n", i);
			if (nl < 0) return -1;
			i = nl + 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const end = src.indexOf("*/", i + 2);
			if (end < 0) return -1;
			i = end + 2;
			continue;
		}
		if (c === "(" || c === "[" || c === "{") depth++;
		else if (c === ")" || c === "]" || c === "}") {
			if (depth === 0) return c === ")" ? i : -1;
			depth--;
		}
		i++;
	}
	return -1;
}

const skipSpace = (src: string, i: number) => {
	while (i < src.length && /\s/.test(src[i]!)) i++;
	return i;
};

/**
 * The string literal at `src[at]` (a quote or backtick): its cooked value
 * (null for a template with `${…}`) and the index after it. Null when it
 * never closes, or a plain string runs into a newline.
 */
function readString(
	src: string,
	at: number,
	consts?: Consts,
): { value: string | null; end: number } | null {
	const q = src[at]!;
	let out = "";
	let dynamic = false;
	let i = at + 1;
	while (i < src.length) {
		const c = src[i]!;
		if (c === q) return { value: dynamic ? null : out, end: i + 1 };
		if (c === "\n" && q !== "`") return null;
		if (c === "\\") {
			const e = escapeAt(src, i + 1);
			out += e.text;
			i = e.end;
			continue;
		}
		if (q === "`" && c === "$" && src[i + 1] === "{") {
			const ref = /^\$\{\s*([A-Za-z_$][\w$]*)\s*\}/.exec(src.slice(i, i + 72));
			const known = ref ? consts?.get(ref[1]!) : undefined;
			if (ref && known !== undefined) {
				out += known;
				i += ref[0].length;
				continue;
			}
			dynamic = true;
			// Skip the expression, strings and nested braces included.
			let depth = 1;
			i += 2;
			while (i < src.length && depth > 0) {
				const d = src[i]!;
				if (d === '"' || d === "'" || d === "`") {
					const s = readString(src, i);
					if (!s) return null;
					i = s.end;
					continue;
				}
				if (d === "{") depth++;
				else if (d === "}") depth--;
				i++;
			}
			continue;
		}
		out += c;
		i++;
	}
	return null;
}

const SIMPLE: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
	v: "\v",
	0: "\0",
};

/** One escape sequence after a backslash at `src[at - 1]`. */
function escapeAt(src: string, at: number): { text: string; end: number } {
	const c = src[at] ?? "";
	if (c in SIMPLE && !(c === "0" && /\d/.test(src[at + 1] ?? "")))
		return { text: SIMPLE[c]!, end: at + 1 };
	if (c === "\n") return { text: "", end: at + 1 };
	if (c === "x") {
		const h = /^[0-9a-fA-F]{2}/.exec(src.slice(at + 1, at + 3));
		if (h)
			return {
				text: String.fromCharCode(Number.parseInt(h[0], 16)),
				end: at + 3,
			};
	}
	if (c === "u") {
		const braced = /^\{([0-9a-fA-F]{1,6})\}/.exec(src.slice(at + 1, at + 10));
		const code =
			braced?.[1] ?? /^[0-9a-fA-F]{4}/.exec(src.slice(at + 1, at + 5))?.[0];
		if (code) {
			const n = Number.parseInt(code, 16);
			if (n <= 0x10ffff)
				return {
					text: String.fromCodePoint(n),
					end: at + 1 + (braced ? braced[0].length : 4),
				};
		}
	}
	return { text: c, end: at + 1 };
}

// ------------------------------------------------------------------ results

export interface ScriptResult {
	/** What the script printed, with exec_command results unwrapped. */
	output: string;
	/** Per exec_command result, in order, when the output is made of them. */
	parts?: Array<{ output: string; exitCode?: number }>;
	/** The script's wall time, when Codex says. */
	wallMs?: number;
}

/**
 * Codex code-mode output: `Script completed\nWall time 0.4 s\nOutput:\n`,
 * then what the script printed, often exec_command results as JSON
 * (`{"chunk_id":…,"exit_code":0,"output":"…"}`), unwrapped here.
 */
export function scriptResult(text: string): ScriptResult {
	const head =
		/^Script (?:completed|failed)[^\n]*\n(?:Wall time:? ([\d.]+) ?(ms|s)[^\n]*\n)?(?:Output:\n?)?/.exec(
			text,
		);
	const body = head ? text.slice(head[0].length).replace(/^\n/, "") : text;
	const res: ScriptResult = { output: body };
	if (head?.[1]) {
		const n = Number(head[1]);
		if (Number.isFinite(n))
			res.wallMs = Math.round(head[2] === "ms" ? n : n * 1000);
	}
	const parts: NonNullable<ScriptResult["parts"]> = [];
	const plain: string[] = [];
	for (const line of body.split("\n")) {
		const r = execResult(line);
		if (r) parts.push(r);
		else if (line.trim()) plain.push(line);
	}
	if (parts.length && !plain.length) {
		res.parts = parts;
		res.output = parts.map((p) => p.output.replace(/\n$/, "")).join("\n");
	}
	return res;
}

/** One exec_command result line, or null. */
function execResult(
	line: string,
): { output: string; exitCode?: number } | null {
	const t = line.trim();
	if (!t.startsWith("{") || !t.includes('"output"')) return null;
	try {
		const j = rec(JSON.parse(t));
		if (typeof j.output !== "string") return null;
		if (
			!("chunk_id" in j) &&
			!("exit_code" in j) &&
			!("wall_time_seconds" in j)
		)
			return null;
		return {
			output: j.output,
			...(typeof j.exit_code === "number" ? { exitCode: j.exit_code } : {}),
		};
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ folders

/**
 * Where a command ran, for a label: the project's name at its root,
 * `web/` inside it, `~/…` under a home folder, else the path. `title` is
 * the absolute path when known (for a tooltip).
 */
export function folderLabel(
	dir: string | undefined | null,
	project: string | undefined | null,
): { text: string; title: string } | null {
	if (!dir?.trim()) return null;
	const root = project?.replace(/\/+$/, "");
	let abs = dir.trim();
	// A relative workdir is relative to the project.
	if (!abs.startsWith("/") && !abs.startsWith("~") && root)
		abs = `${root}/${abs.replace(/^\.\/?/, "")}`;
	abs = abs.replace(/\/+$/, "") || "/";
	if (root) {
		if (abs === root)
			return { text: root.split("/").pop() || root, title: abs };
		if (abs.startsWith(`${root}/`))
			return { text: `${abs.slice(root.length + 1)}/`, title: abs };
	}
	const home = /^(\/Users\/[^/]+|\/home\/[^/]+|\/root)(?=\/|$)/.exec(abs);
	if (home) return { text: `~${abs.slice(home[0].length)}` || "~", title: abs };
	return { text: abs, title: abs };
}
