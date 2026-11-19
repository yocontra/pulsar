/**
 * The `shiki` the app bundles (astro.config.mjs aliases the bare `shiki`
 * import here). Same exports as shiki's full bundle, but with only common
 * languages, the app's own CSS-variable theme ("pulsar") and the two GitHub themes: the full bundle ships a lazy chunk
 * for each of 300+ grammars and 60+ themes, which made dist/web ~16 MB.
 * Any other fence language renders as plain text. The JavaScript regex
 * engine is the default (Oniguruma needs WebAssembly, i.e. CSP
 * 'wasm-unsafe-eval').
 */
import {
	type BundledLanguageInfo,
	type BundledThemeInfo,
	createBundledHighlighter,
	createSingletonShorthands,
	type DynamicImportLanguageRegistration,
	type DynamicImportThemeRegistration,
	guessEmbeddedLanguages,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

export * from "shiki/core";

export const bundledLanguagesInfo: BundledLanguageInfo[] = [
	{
		id: "typescript",
		name: "TypeScript",
		aliases: ["ts", "cts", "mts"],
		import: () => import("@shikijs/langs/typescript"),
	},
	// The TSX grammar covers JSX; its own grammar would add ~0.18 MB.
	{
		id: "tsx",
		name: "TSX",
		aliases: ["jsx"],
		import: () => import("@shikijs/langs/tsx"),
	},
	{
		id: "javascript",
		name: "JavaScript",
		aliases: ["js", "cjs", "mjs"],
		// Shared with the HTML grammar, which embeds it.
		import: () => import("@shikijs/langs/javascript"),
	},
	{
		id: "json",
		name: "JSON",
		aliases: ["jsonc", "json5"],
		import: () => import("@shikijs/langs/json"),
	},
	{ id: "bash", name: "Bash", import: () => import("@shikijs/langs/bash") },
	{
		id: "shellscript",
		name: "Shell",
		aliases: ["sh", "shell", "zsh", "console"],
		import: () => import("@shikijs/langs/shellscript"),
	},
	{
		id: "python",
		name: "Python",
		aliases: ["py"],
		import: () => import("@shikijs/langs/python"),
	},
	{ id: "go", name: "Go", import: () => import("@shikijs/langs/go") },
	{
		id: "rust",
		name: "Rust",
		aliases: ["rs"],
		import: () => import("@shikijs/langs/rust"),
	},
	{ id: "swift", name: "Swift", import: () => import("@shikijs/langs/swift") },
	{
		id: "kotlin",
		name: "Kotlin",
		aliases: ["kt", "kts"],
		import: () => import("@shikijs/langs/kotlin"),
	},
	{ id: "java", name: "Java", import: () => import("@shikijs/langs/java") },
	{
		id: "c",
		name: "C",
		aliases: ["h"],
		import: () => import("@shikijs/langs/c"),
	},
	{
		id: "cpp",
		name: "C++",
		aliases: ["c++", "cc", "hpp"],
		import: () => import("@shikijs/langs/cpp"),
	},
	{ id: "css", name: "CSS", import: () => import("@shikijs/langs/css") },
	{
		id: "html",
		name: "HTML",
		aliases: ["htm"],
		import: () => import("@shikijs/langs/html"),
	},
	{
		id: "markdown",
		name: "Markdown",
		aliases: ["md"],
		import: () => import("@shikijs/langs/markdown"),
	},
	{
		id: "yaml",
		name: "YAML",
		aliases: ["yml"],
		import: () => import("@shikijs/langs/yaml"),
	},
	{ id: "toml", name: "TOML", import: () => import("@shikijs/langs/toml") },
	{ id: "sql", name: "SQL", import: () => import("@shikijs/langs/sql") },
	{
		id: "diff",
		name: "Diff",
		aliases: ["patch"],
		import: () => import("@shikijs/langs/diff"),
	},
	{
		id: "dockerfile",
		name: "Dockerfile",
		aliases: ["docker"],
		import: () => import("@shikijs/langs/dockerfile"),
	},
];

export const bundledLanguagesBase: Record<
	string,
	DynamicImportLanguageRegistration
> = Object.fromEntries(bundledLanguagesInfo.map((l) => [l.id, l.import]));

export const bundledLanguagesAlias: Record<
	string,
	DynamicImportLanguageRegistration
> = Object.fromEntries(
	bundledLanguagesInfo.flatMap((l) =>
		(l.aliases ?? []).map((a) => [a, l.import]),
	),
);

export const bundledLanguages = {
	...bundledLanguagesBase,
	...bundledLanguagesAlias,
};

export const bundledThemesInfo: BundledThemeInfo[] = [
	// The app's own theme: colors are CSS variables (see shiki-theme.ts).
	{
		id: "pulsar",
		displayName: "Pulsar",
		type: "light",
		import: () =>
			import("./shiki-theme.ts").then((m) => ({
				default: m.pulsarTheme as never,
			})),
	},
	{
		id: "github-light",
		displayName: "GitHub Light",
		type: "light",
		import: () => import("@shikijs/themes/github-light"),
	},
	{
		id: "github-dark",
		displayName: "GitHub Dark",
		type: "dark",
		import: () => import("@shikijs/themes/github-dark"),
	},
];

export const bundledThemes: Record<string, DynamicImportThemeRegistration> =
	Object.fromEntries(bundledThemesInfo.map((t) => [t.id, t.import]));

export const createHighlighter = /* @__PURE__ */ createBundledHighlighter({
	langs: bundledLanguages,
	themes: bundledThemes,
	engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

export const {
	codeToHtml,
	codeToHast,
	codeToTokens,
	codeToTokensBase,
	codeToTokensWithThemes,
	getSingletonHighlighter,
	getLastGrammarState,
} = /* @__PURE__ */ createSingletonShorthands(createHighlighter, {
	guessEmbeddedLanguages,
});
