import type { PublicAgent } from "./types.ts";

/**
 * A selector picks agents.
 *
 * - `*` matches every live agent (the machine-wide bus).
 * - `key=value` terms are ANDed. Known keys match fields (`harness`, `project`,
 *   `branch`, `machine`, `status`, `name`, `id`); `activity` matches words in the agent's
 *   activity text; `model` matches part of the model id (`model=fable`); any other key matches the tag `key:value` (so `pr=1402`
 *   matches the tag `pr:1402`, and `issue=1378` the tag `issue:1378` that an
 *   agent sets or pulsar detects, src/service/issues.ts). A value may end in `*` for a prefix match.
 *   `key=a|b` matches either value (OR within one key).
 * - `~text` (or `#1378`, or `q=text`) matches text anywhere in the agent's name,
 *   branch, project, tags or activity: "find whoever is on 1378".
 * - A single bare word matches an agent name or id exactly, or a bare tag.
 */
export type Term = { key: string; value: string };

export type Selector =
	| { kind: "all" }
	| { kind: "terms"; terms: Term[] }
	| { kind: "name"; value: string };

const FIELD_KEYS = new Set([
	"harness",
	"project",
	"branch",
	"machine",
	"status",
	"name",
	"id",
]);

function textTerm(part: string): Term | null {
	if (part.startsWith("~") && part.length > 1)
		return { key: "q", value: part.slice(1) };
	if (/^#\w+$/.test(part)) return { key: "q", value: part.slice(1) };
	return null;
}

export function parseSelector(input: string): Selector {
	const text = input.trim();
	if (text === "" || text === "*") return { kind: "all" };
	const parts = text.split(/[\s,]+/).filter(Boolean);
	if (parts.length === 1 && !parts[0]!.includes("=") && !textTerm(parts[0]!)) {
		return { kind: "name", value: parts[0]!.replace(/^@/, "") };
	}
	const terms = parts.map((part): Term => {
		const t = textTerm(part);
		if (t) return t;
		const eq = part.indexOf("=");
		if (eq <= 0) return { key: "tag", value: part };
		return { key: part.slice(0, eq).toLowerCase(), value: part.slice(eq + 1) };
	});
	return { kind: "terms", terms };
}

function valueMatches(actual: string | null | undefined, wanted: string) {
	if (actual == null) return false;
	const a = actual.toLowerCase();
	const w = wanted.toLowerCase();
	return w.endsWith("*") ? a.startsWith(w.slice(0, -1)) : a === w;
}

function tagMatches(tags: string[], wanted: string) {
	return tags.some((t) => valueMatches(t, wanted));
}

function contains(haystack: Array<string | null | undefined>, needle: string) {
	const n = needle.toLowerCase();
	return haystack.some((h) => h?.toLowerCase().includes(n));
}

/** `key=a|b`: the term matches when any alternative does. */
function termMatches(agent: PublicAgent, term: Term): boolean {
	if (term.key !== "tag" && term.value.includes("|")) {
		const alternatives = term.value.split("|").filter(Boolean);
		if (alternatives.length > 0)
			return alternatives.some((value) =>
				singleTermMatches(agent, { key: term.key, value }),
			);
	}
	return singleTermMatches(agent, term);
}

function singleTermMatches(agent: PublicAgent, { key, value }: Term): boolean {
	if (key === "tag") return tagMatches(agent.tags, value);
	if (key === "q" || key === "text") {
		return contains(
			[
				agent.name,
				agent.id,
				agent.branch,
				agent.project,
				agent.model,
				agent.activity,
				...agent.tags,
			],
			value,
		);
	}
	if (key === "activity") return contains([agent.activity], value);
	// `model=fable` matches claude-fable-5-2; `model=gpt-5*` works as a prefix too.
	if (key === "model")
		return value.endsWith("*")
			? valueMatches(agent.model, value)
			: contains([agent.model], value);
	// A record without the field (from a 1.x daemon) still matches its `machine:` tag.
	if (key === "machine" && agent.machine == null)
		return tagMatches(agent.tags, `machine:${value}`);
	if (FIELD_KEYS.has(key)) {
		const field = agent[key as keyof PublicAgent];
		return valueMatches(typeof field === "string" ? field : null, value);
	}
	return tagMatches(agent.tags, `${key}:${value}`);
}

export function matches(agent: PublicAgent, selector: Selector): boolean {
	switch (selector.kind) {
		case "all":
			return true;
		case "name":
			return (
				valueMatches(agent.name, selector.value) ||
				agent.id === selector.value ||
				tagMatches(agent.tags, selector.value)
			);
		case "terms":
			return selector.terms.every((t) => termMatches(agent, t));
	}
}

/**
 * The selector without its terms on `key` (facet counts for a key ignore
 * that key's own filter, so other values stay visible). A bare-name
 * selector counts as a `tag` term here.
 */
export function withoutKey(selector: Selector, key: string): Selector {
	if (selector.kind === "all") return selector;
	if (selector.kind === "name")
		return key === "tag" || key === "name" ? { kind: "all" } : selector;
	const terms = selector.terms.filter((t) => t.key !== key);
	return terms.length ? { kind: "terms", terms } : { kind: "all" };
}

export function isBroadcast(selector: Selector): boolean {
	return selector.kind === "all";
}
