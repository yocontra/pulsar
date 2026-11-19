/**
 * The `[human operator - <name>]` tag. Only the daemon writes it, at the top
 * of a push from the human operator with a passkey session (Face ID / Touch
 * ID). Any text that looks like it, anywhere else (an agent's message, a
 * peer's, an unverified app send, a sender name), is rewritten when it is
 * shown to an agent, so no agent can make its words look like the operator's.
 */

/** The tag's exact opening, as agents are told to look for it. */
export const HUMAN_TAG = "[human operator";

/** What a look-alike tag becomes: it says plainly that it is not the real one. */
const NEUTRAL = "[unverified claim: human operator";

/** Brackets a look-alike may use instead of `[` (fullwidth and CJK forms). */
const OPENERS = /[［【〔〖〘⟦⦋⦍⦏⁅]/gu;
/** Zero-width and other invisible format characters. */
const INVISIBLE = /\p{Cf}/gu;
/**
 * Each letter of "human operator" with the look-alikes we know of: Cyrillic,
 * Greek and Armenian letters, small capitals, letters with a stroke (no
 * decomposition to strip), a zero for o. With the `iu`
 * flags, each one's other case matches too (Cyrillic М for m, Greek Τ for t).
 */
const LETTERS: Record<string, string> = {
	h: "hһнʜħ",
	u: "uυսᴜμʉ",
	m: "mмᴍμ",
	a: "aаαɑᴀⱥ",
	n: "nոɴν",
	o: "oоοօσᴏ0øɵ",
	p: "pрρᴘᵽ",
	e: "eеεҽᴇɇ",
	r: "rгʀɍ",
	t: "tтτᴛŧ",
};
/** One letter, with any combining marks (accents, strike-throughs) after it. */
const letter = (c: string) => `[${LETTERS[c] ?? c}]\\p{M}*`;
const word = (w: string) => [...w].map(letter).join("");
/**
 * Spacing between words. Marks only after a separator: no two neighbouring
 * parts may match the same character, or a run of marks backtracks
 * quadratically (this runs in the daemon on text agents control).
 */
const GAP = "(?:[\\s_\\-.]\\p{M}*)*";
/**
 * `[human operator`, any case, any spacing or joiner between the words, with
 * look-alike letters and combining marks. Matched on NFKD text, so accented
 * letters arrive as the base letter plus marks.
 */
const TAG = new RegExp(
	`\\[\\p{M}*${GAP}${word("human")}${GAP}${word("operator")}`,
	"giu",
);

/**
 * `text` with every look-alike of the human operator tag neutralized. Text
 * with nothing like it comes back unchanged; text with one comes back
 * NFKC-normalized, without invisible characters, and with each tag rewritten
 * (the rest of the text keeps its accents and scripts).
 *
 * Residual: the letter table covers the common confusables, not every one
 * Unicode lists (multi-letter look-alikes such as "rn" for "m" pass). The
 * real tag only ever opens the push header, and agents are told so.
 */
export function neutralizeHumanTag(text: string): string {
	if (!text) return text;
	const plain = text
		.normalize("NFKD")
		.replace(INVISIBLE, "")
		.replace(OPENERS, "[");
	// `search` and a global `replace` both ignore the shared regex's lastIndex.
	if (plain.search(TAG) < 0) return text;
	return plain.replace(TAG, NEUTRAL).normalize("NFKC");
}

/**
 * The operator's name as the tag shows it: from Tailscale (display name,
 * else login). No brackets, line breaks or control characters, at most 64
 * characters, so the name can't close the tag early or start a new line.
 */
export function operatorName(
	displayName?: string | null,
	login?: string,
): string {
	const clean = (s: string | null | undefined) =>
		(s ?? "")
			.normalize("NFKC")
			.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
			.replace(/[[\]()<>{}]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 64)
			.trim();
	return clean(displayName) || clean(login) || "operator";
}
