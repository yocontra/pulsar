/**
 * ANSI escape codes in tool output → styled spans. Only SGR colors and
 * weights survive (16 colors, bold, dim, italic, underline); every other
 * escape (cursor moves, OSC titles and links, 256/true colors) is dropped.
 * Text stays text: the renderer puts it in React text nodes, never HTML.
 */

export interface AnsiSpan {
	text: string;
	/** 0–15: the 16 terminal colors. */
	fg?: number;
	bg?: number;
	bold?: boolean;
	dim?: boolean;
	italic?: boolean;
	underline?: boolean;
}

const E = "\u001b";
const BEL = "\u0007";
/** Any escape sequence: CSI (colors, cursor moves), OSC (titles, links), or a two-byte one. */
const ANY_ESCAPE = new RegExp(
	`${E}(?:\\[[0-9;?]*[ -/]*[@-~]|\\][^${BEL}${E}]*(?:${BEL}|${E}\\\\)|[@-Z\\\\-_])`,
	"g",
);
/** Select Graphic Rendition: colors and weights. */
const SGR = new RegExp(`${E}\\[([0-9;]*)m`, "g");

/** True when the text holds an escape code worth parsing. */
export function hasAnsi(text: string): boolean {
	return text.includes(E);
}

/** A line as the terminal left it: only what follows its last carriage return. */
function settle(text: string): string {
	return text
		.split("\n")
		.map((line) => {
			const i = line.replace(/\r$/, "").lastIndexOf("\r");
			return i >= 0 ? line.slice(i + 1) : line.replace(/\r$/, "");
		})
		.join("\n");
}

/** The text without escape codes (for copying and for plain renderers). */
export function stripAnsi(text: string): string {
	return settle(text.replace(ANY_ESCAPE, ""));
}

export function parseAnsi(input: string): AnsiSpan[] {
	const text = settle(input);
	const out: AnsiSpan[] = [];
	let style: Omit<AnsiSpan, "text"> = {};
	let last = 0;
	const push = (chunk: string) => {
		const clean = chunk.replace(ANY_ESCAPE, "");
		if (clean) out.push({ text: clean, ...style });
	};
	for (const m of text.matchAll(SGR)) {
		push(text.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;
		const codes = (m[1] || "0").split(";").map(Number);
		for (let i = 0; i < codes.length; i++) {
			const c = codes[i]!;
			if (c === 0) style = {};
			else if (c === 1) style = { ...style, bold: true };
			else if (c === 2) style = { ...style, dim: true };
			else if (c === 3) style = { ...style, italic: true };
			else if (c === 4) style = { ...style, underline: true };
			else if (c === 22) style = { ...style, bold: false, dim: false };
			else if (c === 23) style = { ...style, italic: false };
			else if (c === 24) style = { ...style, underline: false };
			else if (c >= 30 && c <= 37) style = { ...style, fg: c - 30 };
			else if (c >= 90 && c <= 97) style = { ...style, fg: c - 90 + 8 };
			else if (c === 39) style = { ...style, fg: undefined };
			else if (c >= 40 && c <= 47) style = { ...style, bg: c - 40 };
			else if (c >= 100 && c <= 107) style = { ...style, bg: c - 100 + 8 };
			else if (c === 49) style = { ...style, bg: undefined };
			else if (c === 38 || c === 48) {
				// 256-color (5;n) and true color (2;r;g;b): keep only the 16 basic colors.
				const mode = codes[i + 1];
				const n = codes[i + 2];
				if (mode === 5 && n !== undefined && n < 16)
					style = { ...style, [c === 38 ? "fg" : "bg"]: n };
				i += mode === 5 ? 2 : mode === 2 ? 4 : 0;
			}
		}
	}
	push(text.slice(last));
	return out;
}

/** The classes for one span: `ansi-fg-1 ansi-b`… */
export function ansiClass(s: AnsiSpan): string {
	const c: string[] = [];
	if (s.fg !== undefined) c.push(`ansi-fg-${s.fg}`);
	if (s.bg !== undefined) c.push(`ansi-bg-${s.bg}`);
	if (s.bold) c.push("ansi-b");
	if (s.dim) c.push("ansi-d");
	if (s.italic) c.push("ansi-i");
	if (s.underline) c.push("ansi-u");
	return c.join(" ");
}
