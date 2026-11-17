import type { PublicAgent } from "./types.ts";

/**
 * A selector picks agents.
 *
 * - `*` matches every live agent (the machine-wide bus).
 * - `key=value` terms are ANDed. Known keys match fields (`harness`, `project`,
 *   `branch`, `status`, `name`, `id`); `activity` matches words in the agent's
 *   activity text; `model` matches part of the model id (`model=fable`); any other key matches the tag `key:value` (so `pr=1402`
 *   matches the tag `pr:1402`). A value may end in `*` for a prefix match.
 * - `~text` (or `#1378`, or `q=text`) matches text anywhere in the agent's name,
 *   branch, project, tags or activity: "find whoever is on 1378".
 * - A single bare word matches an agent name or id exactly, or a bare tag.
 */
type Term = { key: string; value: string };

type Selector =
	| { kind: "all" }
	| { kind: "terms"; terms: Term[] }
	| { kind: "name"; value: string };

const FIELD_KEYS = new Set([
	"harness",
	"project",
	"branch",
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

function termMatches(agent: PublicAgent, { key, value }: Term): boolean {
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

export function isBroadcast(selector: Selector): boolean {
	return selector.kind === "all";
}
