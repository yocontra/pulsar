/**
 * The broadcast builder's model of a selector: facet chips (AND across keys,
 * `key=a|b` within one), free-text `~terms`, and raw terms the chips can't
 * show. `serialize(parse(s))` round-trips any selector the daemon accepts.
 */
export interface Query {
	chips: { key: string; values: string[] }[];
	text: string[];
	raw: string[];
}

export const EMPTY: Query = { chips: [], text: [], raw: [] };

export function parse(input: string): { query: Query; error: string | null } {
	const q: Query = { chips: [], text: [], raw: [] };
	const s = input.trim();
	if (s === "" || s === "*") return { query: q, error: null };
	let error: string | null = null;
	for (const part of s.split(/[\s,]+/).filter(Boolean)) {
		if (part === "*") continue;
		if ((part.startsWith("~") && part.length > 1) || /^#\w+$/.test(part)) {
			q.text.push(part.slice(1));
			continue;
		}
		const eq = part.indexOf("=");
		if (eq === 0 || eq === part.length - 1) {
			error = `"${part}" needs a key and a value`;
			q.raw.push(part);
			continue;
		}
		if (eq < 0) {
			q.raw.push(part);
			continue;
		}
		const key = part.slice(0, eq).toLowerCase();
		const values = part
			.slice(eq + 1)
			.split("|")
			.filter(Boolean);
		if (key === "q" || key === "text") {
			q.text.push(...values);
			continue;
		}
		const chip = q.chips.find((c) => c.key === key);
		if (chip) {
			// Two terms for one key are ANDed by the daemon; keep them apart.
			q.raw.push(part);
		} else q.chips.push({ key, values });
	}
	return { query: q, error };
}

export function serialize(q: Query, omitKey?: string): string {
	const parts = [
		...q.chips
			.filter((c) => c.key !== omitKey && c.values.length)
			.map((c) => `${c.key}=${c.values.join("|")}`),
		...q.text.map((t) => `~${t}`),
		...q.raw,
	];
	return parts.length ? parts.join(" ") : "*";
}

export function toggle(q: Query, key: string, value: string): Query {
	const chips = q.chips.map((c) => ({ ...c, values: [...c.values] }));
	let chip = chips.find((c) => c.key === key);
	if (!chip) {
		chip = { key, values: [] };
		chips.push(chip);
	}
	const i = chip.values.indexOf(value);
	if (i >= 0) chip.values.splice(i, 1);
	else chip.values.push(value);
	return { ...q, chips: chips.filter((c) => c.values.length) };
}

export function has(q: Query, key: string, value: string) {
	return !!q.chips.find((c) => c.key === key)?.values.includes(value);
}

/** Add free input from the "+ add filter" box: `key=value` or `~text`. */
export function addTerm(q: Query, term: string): Query {
	const { query } = parse(term);
	let next = {
		...q,
		text: [...q.text, ...query.text],
		raw: [...q.raw, ...query.raw],
	};
	for (const c of query.chips)
		for (const v of c.values)
			if (!has(next, c.key, v)) next = toggle(next, c.key, v);
	return next;
}

export function isAll(q: Query) {
	return serialize(q) === "*";
}
