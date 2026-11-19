/**
 * Text rules shared by both search engines (SQLite FTS5 and the in-memory
 * fallback): how text splits into words, what a query means, how hits are
 * scored and how a snippet is cut. Keeping these in JS means a hit scores the
 * same on every node, whichever engine found it.
 */

/** Shortest word that makes a query searchable (a query needs at least one). */
export const MIN_WORD = 3;
/** Most words of a query used. */
export const MAX_TERMS = 8;
/** Characters a snippet shows, about. */
export const SNIPPET_CHARS = 160;

const WORD = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** One word as the index keeps it: no accents, lower case (like FTS5's `unicode61 remove_diacritics 2`). */
export function fold(word: string): string {
	return word.normalize("NFKD").replace(MARKS, "").toLowerCase();
}

/** The words of `text`, folded. */
export function words(text: string): string[] {
	return Array.from(text.matchAll(WORD), (m) => fold(m[0])).filter(Boolean);
}

/** The words of `text` with where each sits in it. */
function spans(text: string): { word: string; start: number; end: number }[] {
	return Array.from(text.matchAll(WORD), (m) => ({
		word: fold(m[0]),
		start: m.index,
		end: m.index + m[0].length,
	}));
}

/**
 * What a query asks for: every term must be in the text; the last one may be
 * the start of a word while the operator is still typing. Null when no word
 * has `MIN_WORD` letters.
 */
export interface Query {
	terms: string[];
	/** The last term matches as a prefix. */
	prefix: boolean;
	/** The folded query, for the phrase bonus. */
	phrase: string;
}

export function parseQuery(q: string): Query | null {
	const terms = [...new Set(words(q))].slice(0, MAX_TERMS);
	if (!terms.some((t) => [...t].length >= MIN_WORD)) return null;
	// "fix aut" types on: the last word is a prefix while the query ends in it.
	const prefix = /[\p{L}\p{N}]$/u.test(q) && words(q).at(-1) === terms.at(-1);
	return { terms, prefix, phrase: terms.join(" ") };
}

/** True when `word` satisfies term `i` of `query`. */
function matchesTerm(query: Query, i: number, word: string): boolean {
	const term = query.terms[i]!;
	if (word === term) return true;
	return query.prefix && i === query.terms.length - 1 && word.startsWith(term);
}

/** The FTS5 MATCH expression for a query: every term quoted, never raw input. */
export function ftsExpression(query: Query): string {
	return query.terms
		.map((t, i) => {
			const quoted = `"${t.replaceAll('"', '""')}"`;
			return query.prefix && i === query.terms.length - 1
				? `${quoted}*`
				: quoted;
		})
		.join(" ");
}

/** True when `text` has every term (the check both engines' candidates pass). */
export function matches(query: Query, text: string): boolean {
	const ws = new Set(words(text));
	return query.terms.every((_, i) => {
		for (const w of ws) if (matchesTerm(query, i, w)) return true;
		return false;
	});
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * One score for a hit, the same on every node: recency (half after a week),
 * plus a bonus when the words come in the query's order, plus a little when
 * every term matched a whole word, plus a little for the operator's own words.
 */
export function score(
	query: Query,
	doc: { text: string; ts: number; role: string },
	now: number,
): number {
	const folded = words(doc.text).join(" ");
	const age = Math.max(0, now - doc.ts);
	let s = 0.5 ** (age / (7 * DAY));
	if (query.terms.length > 1 && ` ${folded} `.includes(` ${query.phrase}`))
		s += 0.5;
	const whole = new Set(folded.split(" "));
	if (query.terms.every((t) => whole.has(t))) s += 0.25;
	if (doc.role === "user") s += 0.1;
	return Math.round(s * 1e6) / 1e6;
}

/**
 * A short piece of `text` around the first match, whitespace collapsed, with
 * the matched words as [start, end) ranges into the snippet. Plain text: the
 * app marks the ranges itself, so agent-written text is never markup.
 */
export function snippet(
	query: Query,
	text: string,
	size = SNIPPET_CHARS,
): { text: string; marks: [number, number][] } {
	const all = spans(text);
	const first = all.find((s) =>
		query.terms.some((_, i) => matchesTerm(query, i, s.word)),
	);
	let start = 0;
	let end = text.length;
	if (text.length > size) {
		const at = first?.start ?? 0;
		start = Math.max(0, at - Math.floor(size / 3));
		end = Math.min(text.length, start + size);
		start = Math.max(0, Math.min(start, end - size));
		// Whole words at the edges.
		if (start > 0) {
			const space = text.slice(start, at).search(/\s/);
			if (space >= 0) start += space + 1;
		}
		if (end < text.length) {
			const cut = text.slice(0, end).search(/\s\S*$/);
			if (cut > (first?.end ?? start)) end = cut;
		}
	}
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	const out = (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
	const marks: [number, number][] = [];
	for (const s of spans(out))
		if (query.terms.some((_, i) => matchesTerm(query, i, s.word)))
			marks.push([s.start, s.end]);
	return { text: out, marks };
}
