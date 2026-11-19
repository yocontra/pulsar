/**
 * Show a tool argument exactly: spaces as `·`, tabs as `→`, newlines as `\n`
 * (then a real break), and every control, zero-width or bidi character as a
 * `<U+XXXX>` marker. The markers replace the characters, so nothing in the
 * argument can reorder or hide the text around it.
 */
export type Piece = { text: string; mark?: "space" | "tab" | "nl" | "ctl" };

/**
 * C0/C1 controls (except tab and newline), DEL, soft hyphen, zero-width
 * characters and joiners, bidi embeddings/overrides/isolates, line and
 * paragraph separators, BOM, Hangul fillers, variation selectors, tag
 * characters, and every space other than U+0020 (NBSP, en/em/thin spaces,
 * ideographic space), which look like a plain space.
 */
function invisible(cp: number): boolean {
	return (
		(cp <= 0x1f && cp !== 0x09 && cp !== 0x0a) ||
		(cp >= 0x7f && cp <= 0x9f) ||
		cp === 0xad ||
		cp === 0xa0 ||
		cp === 0x1680 ||
		(cp >= 0x2000 && cp <= 0x200a) ||
		cp === 0x202f ||
		cp === 0x205f ||
		cp === 0x3000 ||
		cp === 0x34f ||
		cp === 0x61c ||
		cp === 0x115f ||
		cp === 0x1160 ||
		cp === 0x17b4 ||
		cp === 0x17b5 ||
		cp === 0x180e ||
		(cp >= 0x200b && cp <= 0x200f) ||
		(cp >= 0x2028 && cp <= 0x202e) ||
		(cp >= 0x2060 && cp <= 0x206f) ||
		cp === 0x3164 ||
		(cp >= 0xfe00 && cp <= 0xfe0f) ||
		cp === 0xfeff ||
		cp === 0xffa0 ||
		(cp >= 0xfff9 && cp <= 0xfffb) ||
		(cp >= 0xe0000 && cp <= 0xe007f)
	);
}

export function visible(s: string): Piece[] {
	const out: Piece[] = [];
	let run = "";
	const flush = () => {
		if (run) out.push({ text: run });
		run = "";
	};
	for (const ch of s) {
		if (ch === " ") {
			flush();
			out.push({ text: "·", mark: "space" });
		} else if (ch === "\t") {
			flush();
			out.push({ text: "→", mark: "tab" });
		} else if (ch === "\n") {
			flush();
			out.push({ text: "\\n", mark: "nl" });
		} else if (ch === "\r") {
			flush();
			out.push({ text: "\\r", mark: "ctl" });
		} else if (invisible(ch.codePointAt(0)!)) {
			flush();
			const cp = ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
			out.push({ text: `<U+${cp}>`, mark: "ctl" });
		} else run += ch;
	}
	flush();
	return out;
}
