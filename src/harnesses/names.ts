import { slug } from "../git.ts";

/**
 * Session names the harness itself gives (docs/adapters.md, "Names"). A
 * driver, scan or extension puts the raw name in agent meta under
 * `harnessName` (Claude's older wire key `claudeName` still counts) and
 * where it came from under `harnessNameSource`: `user` for a rename
 * (`/rename`, `/name`), `auto` for a title the harness made up.
 */

export type NameSource = "user" | "auto";

export const NAME_KEY = "harnessName";
export const NAME_SOURCE_KEY = "harnessNameSource";

/** Longest name a harness title turns into (cut at a word boundary). */
const MAX_NAME = 40;

/** Titles a harness shows before it has a real one. */
const PLACEHOLDERS = [
	/^new session\b/i, // OpenCode: "New session - 2026-11-18T…"
	/^child session\b/i, // OpenCode subagent sessions
	/^untitled\b/i,
];

/** Words a cut name should not end on. */
const DANGLING = new Set([
	"a",
	"an",
	"and",
	"as",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
]);

/** The raw harness name in agent meta, if any. */
export function harnessNameOf(
	meta: Record<string, string> | undefined,
): { raw: string; source: NameSource } | null {
	const raw = meta?.[NAME_KEY] ?? meta?.claudeName;
	if (!raw?.trim()) return null;
	const source = meta?.[NAME_SOURCE_KEY] === "auto" ? "auto" : "user";
	return { raw, source };
}

/**
 * The pulsar name an agent's meta gives, or null. Claude's names are
 * already short slugs and are taken as they are (only slugged), as before.
 */
export function pulsarNameFor(
	meta: Record<string, string> | undefined,
): string | null {
	const raw = meta?.[NAME_KEY];
	if (raw?.trim())
		return nameFromHarness(
			raw,
			meta?.[NAME_SOURCE_KEY] === "auto" ? "auto" : "user",
		);
	const claude = meta?.claudeName?.trim();
	return claude ? slug(claude) || claude : null;
}

/**
 * The pulsar name for a harness session name: a slug of at most 40
 * characters. A longer one is cut at a word boundary, and not left on a
 * dangling "and" or "the". omp's generated titles look like
 * `🐝 SWARM: Swarm-review first program`; for generated titles the
 * upper-case category goes. Placeholders and names with no letters or
 * digits give null (the agent keeps its other name).
 */
export function nameFromHarness(
	raw: string,
	source: NameSource = "user",
): string | null {
	let text = raw.replace(/\s+/g, " ").trim();
	if (!text || PLACEHOLDERS.some((p) => p.test(text))) return null;
	text = text.replace(/^[^\p{L}\p{N}]+/u, "");
	if (source === "auto") text = text.replace(/^[A-Z0-9]{2,12}:\s+(?=\S)/, "");
	let name = slug(text);
	if (name.length > MAX_NAME) {
		const cut = name.slice(0, MAX_NAME + 1);
		const at = cut.lastIndexOf("-");
		name = at > 0 ? cut.slice(0, at) : name.slice(0, MAX_NAME);
		const words = name.split("-");
		while (words.length > 1 && DANGLING.has(words.at(-1) ?? "")) words.pop();
		name = words.join("-");
	}
	name = name.replace(/^[-.]+|[-.]+$/g, "");
	return /[a-z0-9]/.test(name) ? name : null;
}
