/**
 * Syntax highlighting for tool cards, diffs and Markdown code blocks. One lazy Shiki highlighter (the app's trimmed bundle, see
 * lib/shiki.ts) with the CSS-variable "pulsar" theme, so tokens follow the
 * color scheme without re-highlighting. Tokens render as React spans (no
 * innerHTML, CSP-safe). Until Shiki loads, the same text renders plain in
 * the same box, so highlighting never moves layout.
 */
import {
	createContext,
	Fragment,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import type { HighlighterGeneric, ThemedToken } from "shiki";
import { visible } from "../approval/visible.ts";

/**
 * Inside an approval card: highlighted text still shows every control,
 * zero-width and bidi character (and every space that isn't U+0020) as a
 * red `<U+XXXX>` tag, and tabs as `→`. Plain spaces stay spaces. The
 * markers replace the characters, so nothing can reorder or hide the code
 * around them; highlighting only colors the visible text.
 */
export const MarkHidden = createContext(false);

/** `text` with hidden characters as markers (see MarkHidden). */
export function marked(text: string): ReactNode {
	const pieces = visible(text);
	if (pieces.every((p) => !p.mark || p.mark === "space")) return text;
	return pieces.map((p, i) =>
		p.mark === "space" ? (
			" "
		) : p.mark === "tab" || p.mark === "ctl" ? (
			<span key={i} className={`mk mk-${p.mark}`}>
				{p.text}
			</span>
		) : p.mark === "nl" ? (
			<Fragment key={i}>{"\n"}</Fragment>
		) : (
			p.text
		),
	);
}

type HL = HighlighterGeneric<string, string>;
let hl: Promise<HL> | null = null;
const langLoads = new Map<string, Promise<boolean>>();

function highlighter(): Promise<HL> {
	hl ??= Promise.all([import("shiki"), import("shiki/engine/javascript")]).then(
		([s, e]) =>
			s.createHighlighter({
				themes: ["pulsar"],
				langs: [],
				engine: e.createJavaScriptRegexEngine({ forgiving: true }),
			}) as unknown as Promise<HL>,
	);
	return hl;
}

/** Resolve aliases ("sh", "zsh", "ts") to a bundled id, or null for plain text. */
async function ensureLang(h: HL, lang: string): Promise<string | null> {
	const s = await import("shiki");
	const id = lang.toLowerCase();
	if (!(id in s.bundledLanguages)) return null;
	let p = langLoads.get(id);
	if (!p) {
		p = h
			.loadLanguage(id as never)
			.then(() => true)
			.catch(() => false);
		langLoads.set(id, p);
	}
	return (await p) ? id : null;
}

export type Lines = ThemedToken[][];

const cache = new Map<string, Lines>();
const CACHE_MAX = 400;
const keyOf = (code: string, lang: string) => `${lang}\u0000${code}`;

/** Highlight now if Shiki is warm; otherwise null and resolve later. */
export async function tokenize(code: string, lang: string): Promise<Lines> {
	const k = keyOf(code, lang);
	const hit = cache.get(k);
	if (hit) return hit;
	const h = await highlighter();
	const id = await ensureLang(h, lang);
	const lines = id
		? h.codeToTokens(code, { lang: id as never, theme: "pulsar" }).tokens
		: code.split("\n").map((l) => (l ? [{ content: l, offset: 0 }] : []));
	if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
	cache.set(k, lines as Lines);
	return lines as Lines;
}

/** Highlighted lines of `code`, or null while Shiki loads. */
export function useTokens(code: string, lang: string | null): Lines | null {
	const k = lang ? keyOf(code, lang) : "";
	const [state, setState] = useState<{ k: string; lines: Lines } | null>(() =>
		lang && cache.has(k) ? { k, lines: cache.get(k)! } : null,
	);
	useEffect(() => {
		if (!lang) return;
		if (cache.has(k)) {
			setState({ k, lines: cache.get(k)! });
			return;
		}
		let live = true;
		tokenize(code, lang)
			.then((lines) => live && setState({ k, lines }))
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [k]);
	return state?.k === k ? state.lines : null;
}

/** One token: color from the theme's CSS variable (set through CSSOM). */
export function Tok({ t }: { t: ThemedToken }) {
	const mark = useContext(MarkHidden);
	const text = mark ? marked(t.content) : t.content;
	if (!t.color && !t.fontStyle) return <>{text}</>;
	return (
		<span
			style={{
				color: t.color,
				fontStyle: t.fontStyle && t.fontStyle & 1 ? "italic" : undefined,
				fontWeight: t.fontStyle && t.fontStyle & 2 ? 600 : undefined,
			}}
		>
			{text}
		</span>
	);
}

/** A line's tokens, or its plain text before Shiki is ready. */
export function LineTokens({
	tokens,
	text,
}: {
	tokens: ThemedToken[] | undefined;
	text: string;
}) {
	const mark = useContext(MarkHidden);
	if (!tokens) return <>{mark ? marked(text) : text}</>;
	return (
		<>
			{tokens.map((t, i) => (
				<Tok key={i} t={t} />
			))}
		</>
	);
}

/** Inline highlighted code (a one-line shell command in a tool card summary). */
export const InlineCode = memo(function InlineCode({
	code,
	lang,
	className,
}: {
	code: string;
	lang: string;
	className?: string;
}) {
	const lines = useTokens(code, lang);
	const rows = code.split("\n");
	return (
		<code className={className} data-lang={lang}>
			{rows.map((r, i) => (
				<span key={i} className="ds-code-line">
					<LineTokens tokens={lines?.[i]} text={r} />
					{i < rows.length - 1 ? "\n" : null}
				</span>
			))}
		</code>
	);
});

const EXT: Record<string, string> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	jsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	json: "json",
	jsonc: "json",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	py: "python",
	go: "go",
	rs: "rust",
	swift: "swift",
	kt: "kotlin",
	kts: "kotlin",
	java: "java",
	c: "c",
	h: "c",
	cc: "cpp",
	cpp: "cpp",
	hpp: "cpp",
	css: "css",
	html: "html",
	htm: "html",
	md: "markdown",
	mdx: "markdown",
	yml: "yaml",
	yaml: "yaml",
	toml: "toml",
	sql: "sql",
	diff: "diff",
	patch: "diff",
};

/** A Shiki language for a file path ("src/a.ts" → "typescript"), or null. */
export function langForPath(path: string | undefined | null): string | null {
	if (!path) return null;
	const base = path.split(/[\\/]/).pop() ?? "";
	if (/^dockerfile/i.test(base)) return "dockerfile";
	const ext = base.includes(".") ? base.split(".").pop()!.toLowerCase() : "";
	return EXT[ext] ?? null;
}

/** "TypeScript" for a label from a language id or alias. */
export function langLabel(lang: string | null | undefined): string {
	if (!lang) return "Text";
	const l = lang.toLowerCase();
	const M: Record<string, string> = {
		ts: "TypeScript",
		typescript: "TypeScript",
		tsx: "TSX",
		jsx: "JSX",
		js: "JavaScript",
		javascript: "JavaScript",
		json: "JSON",
		bash: "Bash",
		sh: "Shell",
		shell: "Shell",
		shellscript: "Shell",
		zsh: "Zsh",
		console: "Console",
		py: "Python",
		python: "Python",
		go: "Go",
		rs: "Rust",
		rust: "Rust",
		swift: "Swift",
		kotlin: "Kotlin",
		java: "Java",
		c: "C",
		cpp: "C++",
		css: "CSS",
		html: "HTML",
		md: "Markdown",
		markdown: "Markdown",
		yaml: "YAML",
		yml: "YAML",
		toml: "TOML",
		sql: "SQL",
		diff: "Diff",
		dockerfile: "Dockerfile",
		text: "Text",
		plaintext: "Text",
	};
	return M[l] ?? lang;
}
