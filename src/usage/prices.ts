/**
 * Model prices for the usage page's "API estimate": US dollars per million
 * tokens. Tokens are stored, never dollars, so an edited price re-prices all
 * history and a model with no price counts as unpriced instead of free.
 */

export interface Price {
	/** Uncached input. */
	input: number;
	output: number;
	/** Reading cached input. */
	cacheRead: number;
	/** Writing the cache with a 5-minute lifetime (also the default write). */
	cacheWrite5m: number;
	/** Writing the cache with a 1-hour lifetime. */
	cacheWrite1h: number;
}

export interface PriceEntry extends Price {
	/** A model id or an id prefix (`claude-opus-4` covers every 4.x Opus). */
	model: string;
	source: "default" | "custom";
}

/** Anthropic's usual cache multipliers: writes 1.25x (5m) and 2x (1h), reads 0.1x. */
function anthropic(input: number, output: number, cacheRead = input * 0.1) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite5m: input * 1.25,
		cacheWrite1h: input * 2,
	};
}

/**
 * First-party API list prices (Anthropic, November 2026) for the models
 * listed then. Older models and other providers' have no default: the
 * operator sets them from the model sheet. Claude Haiku 5.5's higher rate
 * for prompts over 100K tokens is not modeled.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
	"claude-fable-5-2": anthropic(8, 40, 0.2),
	"claude-mythos-5-2": anthropic(8, 40, 0.2),
	"claude-fable-5-1": anthropic(10, 50, 0.25),
	"claude-mythos-5-1": anthropic(10, 50, 0.25),
	"claude-fable-5": anthropic(10, 50),
	"claude-opus-5-5": anthropic(4, 20, 0.2),
	"claude-opus-5": anthropic(5, 25),
	"claude-opus-4-8": anthropic(5, 25),
	"claude-opus-4-7": anthropic(5, 25),
	"claude-opus-4-6": anthropic(5, 25),
	"claude-sonnet-5-5": anthropic(2, 10, 0.1),
	"claude-sonnet-5": anthropic(2, 10),
	"claude-sonnet-4-6": anthropic(3, 15),
	"claude-haiku-5-5": anthropic(0.1, 0.5),
	"claude-haiku-4-5": anthropic(1, 5),
};

/** Price fields, for validating an edit. */
export const PRICE_FIELDS = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite5m",
	"cacheWrite1h",
] as const;

/**
 * Model ids as harnesses write them: a provider prefix (`anthropic/…`,
 * `anthropic.…` on Bedrock), a date suffix, or a `[1m]` tag.
 */
export function normalizeModel(model: string): string {
	let m = model.trim().toLowerCase();
	m = m.replace(/\[[^\]]*\]$/, "");
	const slash = m.lastIndexOf("/");
	if (slash >= 0) m = m.slice(slash + 1);
	m = m.replace(/^(?:us\.|eu\.|global\.)?anthropic\./, "");
	m = m.replace(/[-@]\d{8}$/, "").replace(/-v\d+(?::\d+)?$/, "");
	return m;
}

/**
 * The price for a model: the longest table key that is the model id or a
 * `-`-separated prefix of it. Custom entries win over defaults with the
 * same key. Null when nothing matches (unpriced).
 */
export function priceFor(
	model: string,
	table: ReadonlyMap<string, Price>,
): Price | null {
	const m = normalizeModel(model);
	let best: { key: string; price: Price } | null = null;
	for (const [key, price] of table) {
		if (m !== key && !m.startsWith(`${key}-`)) continue;
		if (!best || key.length > best.key.length) best = { key, price };
	}
	return best?.price ?? null;
}

/** Defaults overlaid with the operator's edits (a custom null removes a default). */
export function priceTable(
	custom: Record<string, Price | null>,
): Map<string, Price> {
	const table = new Map<string, Price>(Object.entries(DEFAULT_PRICES));
	for (const [model, price] of Object.entries(custom)) {
		if (price) table.set(model, price);
		else table.delete(model);
	}
	return table;
}

export interface TokenCounts {
	input: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	output: number;
}

/** Dollars for some tokens at a price. */
export function costOf(t: TokenCounts, p: Price): number {
	return (
		(t.input * p.input +
			t.output * p.output +
			t.cacheRead * p.cacheRead +
			t.cacheWrite5m * p.cacheWrite5m +
			t.cacheWrite1h * p.cacheWrite1h) /
		1_000_000
	);
}
