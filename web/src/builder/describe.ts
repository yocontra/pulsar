/**
 * A broadcast audience in words: the selector's chips as sentence tokens
 * ("Claude Code agents", "in apparish", "on studio or desk"). Pure. The
 * sentence never says more or less than the selector: values within one
 * key read "or" (the daemon ORs them), keys stack (it ANDs them), and
 * free text, unknown keys and raw terms show verbatim.
 */
import type { Query } from "../lib/selector.ts";

export interface Token {
	/** What removing or editing it changes. */
	kind: "chip" | "text" | "raw";
	/** The chip's key, the text term, or the raw term. */
	key: string;
	/** Index into `query.text` / `query.raw`. */
	index?: number;
	/** The connecting words before the value ("in", "on"); may be empty. */
	lead: string;
	/** The value as people read it ("studio or desk"). */
	value: string;
	/** Show the value as code (a raw term or an unknown key). */
	code?: boolean;
}

const STATUS: Record<string, string> = {
	busy: "working",
	idle: "idle",
	gone: "offline",
	unknown: "in an unknown state",
	"needs-you": "waiting on you",
};

/** "a, b or c" */
function either(values: string[]): string {
	if (values.length <= 1) return values[0] ?? "";
	return `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
}

/** Sentence order: who (harness) first, then where, then the rest. */
const ORDER = ["harness", "project", "machine", "model", "status", "role"];

export function describe(
	q: Query,
	label: (key: string, value: string) => string,
): { subject: Token | null; tokens: Token[] } {
	const chips = [...q.chips].sort(
		(a, b) =>
			(ORDER.indexOf(a.key) + 1 || 99) - (ORDER.indexOf(b.key) + 1 || 99),
	);
	let subject: Token | null = null;
	const tokens: Token[] = [];
	for (const c of chips) {
		const names = c.values.map((v) => label(c.key, v));
		switch (c.key) {
			case "harness":
				subject = {
					kind: "chip",
					key: c.key,
					lead: "",
					value: `${either(names)} agents`,
				};
				break;
			case "project":
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "in",
					value: either(names),
				});
				break;
			case "machine":
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "on",
					value: either(names),
				});
				break;
			case "model":
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "running",
					value: either(names),
				});
				break;
			case "status":
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "that are",
					value: either(c.values.map((v) => STATUS[v] ?? v)),
				});
				break;
			case "role":
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "with role",
					value: either(names),
				});
				break;
			default:
				tokens.push({
					kind: "chip",
					key: c.key,
					lead: "with",
					value: `${c.key}=${c.values.join("|")}`,
					code: true,
				});
		}
	}
	q.text.forEach((t, i) =>
		tokens.push({
			kind: "text",
			key: t,
			index: i,
			lead: "matching",
			value: `“${t}”`,
		}),
	);
	q.raw.forEach((t, i) =>
		tokens.push({
			kind: "raw",
			key: t,
			index: i,
			lead: "and",
			value: t,
			code: true,
		}),
	);
	return { subject, tokens };
}

/** The whole sentence as plain text (for labels and tests). */
export function sentence(
	q: Query,
	label: (key: string, value: string) => string,
): string {
	const { subject, tokens } = describe(q, label);
	const who = subject?.value ?? (tokens.length ? "all agents" : "everyone");
	return [
		who,
		...tokens.map((t) => (t.lead ? `${t.lead} ${t.value}` : t.value)),
	].join(" ");
}
