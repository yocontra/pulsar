/**
 * Code formatted for display: a one-line script an agent ran becomes
 * readable before it is highlighted. Display only: callers keep the original
 * for Copy and offer "Show original". JSON is pretty-printed natively,
 * TypeScript/JavaScript with Prettier (loaded on first use, never in the
 * initial bundle), Bash only has top-level `&&` / `;` chains broken onto
 * lines. Anything else, anything over `FORMAT_MAX`, and any error or
 * timeout: the text as it was (null).
 */
import { useEffect, useState } from "react";

/** Longest code formatted; longer code is shown as written. */
export const FORMAT_MAX = 20_000;
/** Longest wait for the formatter (its first load included). */
const TIMEOUT_MS = 3000;
const CACHE_MAX = 300;
/** Shared display target for Prettier and shell formatting. */
const PRINT_WIDTH = 80;

/** Languages formatted, by Shiki id or alias. */
const FORMATS: Record<string, "ts" | "js" | "json" | "bash"> = {
	typescript: "ts",
	ts: "ts",
	tsx: "ts",
	javascript: "js",
	js: "js",
	jsx: "js",
	mjs: "js",
	json: "json",
	bash: "bash",
	sh: "bash",
	shell: "bash",
	zsh: "bash",
};

/** True when `lang` is a language this module formats. */
export const formats = (lang: string | null | undefined) =>
	!!lang && lang.toLowerCase() in FORMATS;

const cache = new Map<string, string | null>();
const keyOf = (code: string, lang: string) => `${lang}\u0000${code}`;

function remember(k: string, v: string | null) {
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(k, v);
}

/** A cached result: the formatted text, null (left as is), undefined (not yet). */
export function cachedFormat(
	code: string,
	lang: string,
): string | null | undefined {
	return cache.get(keyOf(code, lang.toLowerCase()));
}

/**
 * `code` formatted for display, or null when it is better left as written
 * (unknown language, too long, unchanged, invalid, slow).
 */
export async function formatCode(
	code: string,
	lang: string,
): Promise<string | null> {
	const id = lang.toLowerCase();
	const kind = FORMATS[id];
	if (!kind || !code.trim() || code.length > FORMAT_MAX) return null;
	const k = keyOf(code, id);
	if (cache.has(k)) return cache.get(k)!;
	let out: string | null = null;
	try {
		if (kind === "json") out = formatJson(code);
		else if (kind === "bash") out = splitChain(code);
		else out = await withTimeout(prettierFormat(code, kind), TIMEOUT_MS);
	} catch {
		out = null;
	}
	if (out !== null && out.trim() === code.trim()) out = null;
	remember(k, out);
	return out;
}

export function formatJson(code: string): string | null {
	try {
		return JSON.stringify(JSON.parse(code), null, 2);
	} catch {
		return null;
	}
}

async function prettierFormat(code: string, kind: "ts" | "js") {
	const [prettier, babel, estree] = await Promise.all([
		import("prettier/standalone"),
		import("prettier/plugins/babel"),
		import("prettier/plugins/estree"),
	]);
	const out = await prettier.format(code, {
		// babel-ts reads TypeScript and JavaScript, top-level await included.
		parser: kind === "ts" ? "babel-ts" : "babel",
		plugins: [babel, estree],
		printWidth: PRINT_WIDTH,
	});
	return out.replace(/\n$/, "");
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(null), ms);
		p.then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			() => {
				clearTimeout(t);
				resolve(null);
			},
		);
	});
}

/**
 * A one-line shell command with top-level `&&` or `;` chains, one step per
 * line (`a &&\n  b`, the same command to a shell). Null when there is no
 * such chain, or anything makes the split unsure: several lines, a
 * heredoc, a comment, `;;`, unbalanced quotes or brackets.
 */
export function splitChain(cmd: string): string | null {
	if (cmd.includes("\n") || cmd.length <= PRINT_WIDTH || /<</.test(cmd))
		return null;
	const parts: Array<{ text: string; op: string }> = [];
	let depth = 0;
	let start = 0;
	let i = 0;
	while (i < cmd.length) {
		const c = cmd[i]!;
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === "'") {
			const end = cmd.indexOf("'", i + 1);
			if (end < 0) return null;
			i = end + 1;
			continue;
		}
		if (c === '"' || c === "`") {
			let j = i + 1;
			while (j < cmd.length && cmd[j] !== c) j += cmd[j] === "\\" ? 2 : 1;
			if (j >= cmd.length) return null;
			i = j + 1;
			continue;
		}
		if (c === "#" && (i === 0 || /\s/.test(cmd[i - 1]!))) return null;
		if (c === "(" || c === "{" || c === "[") depth++;
		else if (c === ")" || c === "}" || c === "]") {
			depth--;
			if (depth < 0) return null;
		} else if (depth === 0 && c === "&" && cmd[i + 1] === "&") {
			parts.push({ text: cmd.slice(start, i), op: "&&" });
			i += 2;
			start = i;
			continue;
		} else if (depth === 0 && c === ";") {
			if (cmd[i + 1] === ";") return null;
			parts.push({ text: cmd.slice(start, i), op: ";" });
			i++;
			start = i;
			continue;
		}
		i++;
	}
	if (depth !== 0 || !parts.length) return null;
	parts.push({ text: cmd.slice(start), op: "" });
	const steps = parts
		.map((p) => ({ text: p.text.trim(), op: p.op }))
		.filter((p) => p.text);
	if (steps.length < 2) return null;
	return steps
		.map((p, n) => {
			const tail = p.op === "&&" && n < steps.length - 1 ? " &&" : "";
			return `${n ? "  " : ""}${p.text}${tail}`;
		})
		.join("\n");
}

/**
 * `code` for display: formatted when `on` and the formatter has an answer,
 * else as written. `formatted` says which; `original` / `setOriginal` is the
 * person's "Show original" choice.
 */
export function useFormatted(
	code: string,
	lang: string | null | undefined,
	on: boolean,
): {
	shown: string;
	formatted: boolean;
	canFormat: boolean;
	original: boolean;
	setOriginal: (v: boolean) => void;
} {
	const id = on && formats(lang) ? lang!.toLowerCase() : null;
	const [result, setResult] = useState<{ k: string; v: string | null } | null>(
		() => {
			if (!id) return null;
			const v = cachedFormat(code, id);
			return v === undefined ? null : { k: keyOf(code, id), v };
		},
	);
	const [original, setOriginal] = useState(false);
	const k = id ? keyOf(code, id) : "";
	useEffect(() => {
		if (!id || result?.k === k) return;
		let live = true;
		void formatCode(code, id).then((v) => {
			if (live) setResult({ k, v });
		});
		return () => {
			live = false;
		};
	}, [code, id, k, result?.k]);
	const pretty = result?.k === k ? result.v : null;
	return {
		shown: pretty && !original ? pretty : code,
		formatted: !!pretty && !original,
		canFormat: !!pretty,
		original,
		setOriginal,
	};
}
