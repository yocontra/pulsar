/**
 * "pulsar": one Shiki theme for both color schemes. Its colors are CSS
 * variables (`--ds-syn-*` in styles/tokens.css), so the code palette follows
 * light, dark and forced themes with no re-highlighting, and always matches
 * the app's own palette.
 */
const v = (name: string) => `var(--ds-syn-${name})`;

export const pulsarTheme = {
	name: "pulsar",
	displayName: "Pulsar",
	type: "light" as const,
	colors: {
		"editor.foreground": v("fg"),
		"editor.background": "transparent",
	},
	fg: v("fg"),
	bg: "transparent",
	tokenColors: [
		{ settings: { foreground: v("fg") } },
		{
			scope: ["comment", "punctuation.definition.comment", "string.comment"],
			settings: { foreground: v("comment"), fontStyle: "italic" },
		},
		{
			scope: [
				"keyword",
				"storage",
				"storage.type",
				"storage.modifier",
				"keyword.control",
				"keyword.operator.new",
				"keyword.operator.expression",
				"keyword.operator.logical.python",
				"variable.language.this",
				"variable.language.self",
			],
			settings: { foreground: v("keyword") },
		},
		{
			scope: [
				"keyword.operator",
				"punctuation",
				"meta.brace",
				"punctuation.separator",
				"punctuation.terminator",
			],
			settings: { foreground: v("punct") },
		},
		{
			scope: [
				"string",
				"string.quoted",
				"string.template",
				"punctuation.definition.string",
				"markup.inline.raw",
			],
			settings: { foreground: v("string") },
		},
		{
			scope: ["string.regexp", "constant.character.escape"],
			settings: { foreground: v("type") },
		},
		{
			scope: [
				"constant.numeric",
				"constant.language",
				"constant.language.boolean",
				"support.constant",
				"constant.other.color",
			],
			settings: { foreground: v("number") },
		},
		{
			scope: [
				"entity.name.function",
				"support.function",
				"meta.function-call entity.name.function",
				"variable.function",
				// shell: the command word (`git`, `bun`, `ls`)
				"entity.name.command",
				"support.function.builtin.shell",
				"entity.name.function.call.shell",
			],
			settings: { foreground: v("function") },
		},
		{
			scope: [
				"entity.name.type",
				"entity.name.class",
				"support.type",
				"support.class",
				"entity.other.inherited-class",
				"meta.type.annotation entity.name.type",
				"entity.name.tag",
				"support.type.property-name.json",
			],
			settings: { foreground: v("type") },
		},
		{
			scope: [
				"variable.parameter",
				"constant.other.option",
				"constant.other.option.dash",
				"entity.other.attribute-name",
				"meta.object-literal.key",
				"support.type.property-name",
			],
			settings: { foreground: v("constant") },
		},
		{
			scope: [
				"variable.other.normal.shell",
				"variable.other.positional.shell",
				"variable.other.special.shell",
				"punctuation.definition.variable.shell",
				"variable.other.constant",
				"variable.other.enummember",
			],
			settings: { foreground: v("variable") },
		},
		{
			scope: ["markup.heading", "markup.bold"],
			settings: { foreground: v("keyword"), fontStyle: "bold" },
		},
		{ scope: "markup.italic", settings: { fontStyle: "italic" } },
		{
			scope: ["markup.inserted", "meta.diff.header.to-file"],
			settings: { foreground: "var(--ds-diff-add-text)" },
		},
		{
			scope: ["markup.deleted", "meta.diff.header.from-file"],
			settings: { foreground: "var(--ds-diff-del-text)" },
		},
		{
			scope: ["markup.underline.link", "string.other.link"],
			settings: { foreground: "var(--ds-link)" },
		},
	],
};
