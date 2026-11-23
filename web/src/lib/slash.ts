/**
 * Slash commands in the composer: which drafts run as a command, and how the
 * `/` menu ranks entries. Pure and tiny: the composer (first-load bundle)
 * only needs `commandLine`; the menu itself is a lazy feature
 * (features/slash).
 */
import type { CommandEntry } from "../api/types.ts";

/** A command line as the daemon takes it (src/service/controls.ts parseCommand). */
const LINE = /^\/[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}(?: +[^\n]*)?$/;

/**
 * The draft as a command line (trimmed), or null when it is a message: one
 * line that starts with `/` and a command name.
 */
export function commandLine(text: string): string | null {
	const t = text.trim();
	if (!t.startsWith("/") || t.includes("\n") || t.length > 4000) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters make it a message.
	if (/[\x00-\x1f\x7f]/.test(t)) return null;
	return LINE.test(t) ? t : null;
}

/** The `/word` the caret is in at the start of the draft, or null. */
export function slashToken(
	value: string,
	caret: number,
): { q: string; end: number } | null {
	const m = /^\/([^\s]*)/.exec(value);
	if (!m) return null;
	const end = m[0].length;
	return caret <= end && caret >= 1 ? { q: m[1]!, end } : null;
}

/** How well `q` matches a name: lower is better; null when it doesn't. */
function score(name: string, q: string): number | null {
	if (!q) return 0;
	const n = name.toLowerCase();
	if (n === q) return 0;
	if (n.startsWith(q)) return 1;
	// After a plugin prefix or a separator: `rev` finds `gh:review`.
	if (new RegExp(`[:_.-]${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(n))
		return 2;
	if (n.includes(q)) return 3;
	// The letters in order (`cmp` finds `compact`).
	let i = 0;
	for (const ch of n) if (ch === q[i]) i++;
	return i === q.length ? 4 + (n.length - q.length) / 100 : null;
}

/**
 * The menu's entries for `q`: best matches first; with no query, recent
 * ones first, then built-ins, then the rest by name. A description match
 * comes last.
 */
export function rankCommands(
	list: CommandEntry[],
	q: string,
	recent: string[] = [],
	limit = 50,
): CommandEntry[] {
	const query = q.toLowerCase();
	const scored: Array<[CommandEntry, number]> = [];
	for (const c of list) {
		let s = score(c.name, query);
		if (
			s === null &&
			query.length > 1 &&
			c.description.toLowerCase().includes(query)
		)
			s = 10;
		if (s === null) continue;
		const r = recent.indexOf(c.name);
		if (r >= 0) s -= 1 - r / 100;
		if (!query && c.source !== "builtin" && r < 0) s += 0.5;
		// Only the terminal can answer these: after everything that runs here.
		if (c.dialog && !c.args) s += 20;
		scored.push([c, s]);
	}
	scored.sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name));
	return scored.slice(0, limit).map(([c]) => c);
}

/** What the menu inserts for an entry: `/name ` with room for arguments. */
export function insertText(c: CommandEntry): string {
	return `/${c.name} `;
}

/** A dialog command with nothing to pass is one only the terminal can answer. */
export function needsTerminal(c: CommandEntry): boolean {
	return c.dialog === true && !c.args;
}

/** Commands that end, restart or leave the session: never one tap. */
const DRASTIC = new Set([
	"exit",
	"quit",
	"clear",
	"new",
	"restart",
	"background",
	"logout",
	"resume",
	"handoff",
]);

/** The phone sheet offers Run (one tap) only for a command with nothing to type that keeps the session. */
export function runsInOneTap(c: CommandEntry): boolean {
	return !c.args && !c.dialog && !c.skill && !DRASTIC.has(c.name);
}
