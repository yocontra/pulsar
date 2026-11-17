import type { PublicAgent } from "./types.ts";

/**
 * A selector picks agents.
 *
 * - `*` matches every live agent (the machine-wide bus).
 * - `key=value` terms are ANDed. Known keys match fields (`harness`, `project`,
 *   `branch`, `status`, `name`, `id`); any other key matches the tag `key:value`.
 *   A value may end in `*` for a prefix match.
 * - A bare word with no `=` matches an agent name or id exactly, or a bare tag.
 */
export type Selector =
	| { kind: "all" }
	| { kind: "terms"; terms: Array<{ key: string; value: string }> }
	| { kind: "name"; value: string };

const FIELD_KEYS = new Set([
	"harness",
	"project",
	"branch",
	"status",
	"name",
	"id",
]);

export function parseSelector(input: string): Selector {
	const text = input.trim();
	if (text === "" || text === "*") return { kind: "all" };
	const parts = text.split(/[\s,]+/).filter(Boolean);
	if (parts.length === 1 && !parts[0]!.includes("=")) {
		return { kind: "name", value: parts[0]!.replace(/^@/, "") };
	}
	const terms = parts.map((part) => {
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
			return selector.terms.every(({ key, value }) => {
				if (key === "tag") return tagMatches(agent.tags, value);
				if (FIELD_KEYS.has(key)) {
					const field = agent[key as keyof PublicAgent];
					return valueMatches(typeof field === "string" ? field : null, value);
				}
				return tagMatches(agent.tags, `${key}:${value}`);
			});
	}
}

export function isBroadcast(selector: Selector): boolean {
	return selector.kind === "all";
}
