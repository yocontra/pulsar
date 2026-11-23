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
 * A price from a page with input, cached input and output columns. A
 * provider with no cache-write price bills the tokens that fill the cache
 * as plain input, so a write costs `input` unless the page lists one
 * (`write` for every write, `write1h` for the longer lifetime). A page
 * with no cached-input price (OpenAI's pro models) bills reads as input.
 */
function listed(
	input: number,
	cacheRead: number | null,
	output: number,
	write = input,
	write1h = write,
): Price {
	return {
		input,
		output,
		cacheRead: cacheRead ?? input,
		cacheWrite5m: write,
		cacheWrite1h: write1h,
	};
}

/**
 * Default prices: each block names the page it comes from and the day it
 * was checked; a model on no page has no default (the operator sets one
 * from the model sheet). Where a page shows a promotion and also the
 * standing price, the standing price is used; a model with only a
 * promotional price is left out. Higher rates for long prompts (over 272K
 * tokens at OpenAI, 200K at xAI and Google, 100K for Claude Haiku 5.5) are
 * not modeled.
 *
 * A model used through a flat subscription (a Claude plan, a ChatGPT plan
 * in Codex, OpenCode Go) is priced the same way: the usage page shows what
 * the tokens would cost on the API ("API estimate"), not what was paid.
 */
export const DEFAULT_PRICES: Record<string, Price> = {
	// Anthropic API list prices, November 2026. Checked 2026-11-23 against
	// the same models on https://opencode.ai/docs/zen, which match.
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

	// OpenAI, Standard tier, prompts up to 272K tokens:
	// https://developers.openai.com/api/docs/pricing, checked 2026-11-23.
	// The "30m write" column prices cacheWrite5m and "12h write" cacheWrite1h
	// (Codex reports every cache write as cacheWrite5m). Reasoning tokens
	// are in Codex's output_tokens and bill as output. gpt-5.6-sol is left
	// out: its listed price is a promotion that ends 2026-11-30.
	"gpt-6.2-astra": listed(8, 0.4, 40, 10, 20),
	"gpt-6.2-sol": listed(2, 0.1, 10, 2.5, 5),
	"gpt-6.1-sol": listed(2, 0.1, 10, 2.5, 5),
	"gpt-6.1-terra": listed(1, 0.05, 5, 1.25, 2.5),
	"gpt-6-astra": listed(10, 1, 50, 12.5, 25),
	"gpt-6-sol": listed(2, 0.2, 10, 2.5, 5),
	"gpt-6-luna": listed(0.1, 0.01, 0.5, 0.125, 0.25),
	"gpt-5.6-terra": listed(2, 0.2, 12, 2.5, 5),
	"gpt-5.6-luna": listed(0.2, 0.02, 1.2, 0.25, 0.5),
	"gpt-5.5": listed(5, 0.5, 30),
	"gpt-5.5-pro": listed(30, null, 180),
	"gpt-5.4": listed(2.5, 0.25, 15),
	"gpt-5.4-pro": listed(30, null, 180),
	"gpt-5.4-mini": listed(0.75, 0.075, 4.5),
	"gpt-5.4-nano": listed(0.2, 0.02, 1.25),
	"gpt-5.3-codex": listed(1.75, 0.175, 14),
	"gpt-5.2": listed(1.75, 0.175, 14),
	"gpt-5.2-pro": listed(21, null, 168),
	"gpt-5.1": listed(1.25, 0.125, 10),
	"gpt-5": listed(1.25, 0.125, 10),
	"gpt-5-mini": listed(0.25, 0.025, 2),
	"gpt-5-nano": listed(0.05, 0.005, 0.4),
	"gpt-5-pro": listed(15, null, 120),

	// Codex models OpenAI's page no longer lists, at the OpenCode Zen price:
	// https://opencode.ai/docs/zen, checked 2026-11-23.
	"gpt-5.3-codex-spark": listed(1.75, 0.175, 14),
	"gpt-5.2-codex": listed(1.75, 0.175, 14),
	"gpt-5.1-codex": listed(1.07, 0.107, 8.5),
	"gpt-5.1-codex-max": listed(1.25, 0.125, 10),
	"gpt-5.1-codex-mini": listed(0.25, 0.025, 2),
	"gpt-5-codex": listed(1.07, 0.107, 8.5),

	// DeepSeek, off-peak (base) rate: https://api-docs.deepseek.com/quick_start/pricing,
	// checked 2026-11-23. OpenCode Go lists the same base rates
	// (https://opencode.ai/zen/go/v1/models). Both charge double on weekday
	// peak hours (01:00-04:00 and 06:00-10:00 UTC), which is not modeled, so
	// the estimate is low for those hours. DeepSeek names V4.1 Flash
	// `deepseek-flash`; OpenCode names it `deepseek-v4.1-flash`.
	"deepseek-flash": listed(0.15, 0.003, 0.6),
	"deepseek-v4.1-flash": listed(0.15, 0.003, 0.6),
	"deepseek-v4-pro": listed(0.66, 0.022, 1.98),

	// Google Gemini API, Standard tier: https://ai.google.dev/gemini-api/docs/pricing,
	// checked 2026-11-23. Output includes thinking tokens. Gemini 4 Carbon and
	// Argon are at half price to 2026-11-30, Gemini 3.6 and 3.8 Flash to
	// 2026-12-31; these are the standing prices after that.
	"gemini-4-neon": listed(3, 0.15, 15),
	"gemini-4-carbon": listed(4, 0.2, 20),
	"gemini-4-argon": listed(4, 0.2, 20),
	"gemini-4-hydrogen": listed(1.5, 0.075, 7.5),
	"gemini-3.8-flash": listed(1.5, 0.15, 7.5),
	"gemini-3.6-flash": listed(1.5, 0.15, 7.5),
	"gemini-3.5-flash-lite": listed(0.3, 0.03, 2.5),
	"gemini-3.1-flash-lite": listed(0.25, 0.025, 1.5),
	"gemini-3.1-pro-preview": listed(2, 0.2, 12),
	"gemini-3-flash-preview": listed(0.5, 0.05, 3),

	// xAI, prompts under 200K tokens: https://docs.x.ai/docs/models,
	// checked 2026-11-23.
	"grok-4.7": listed(2, 0.5, 6),
	"grok-4.6": listed(2, 0.5, 6),
	"grok-4.5": listed(2, 0.3, 6),
	"grok-4.3": listed(1.25, 0.2, 2.5),
	"grok-4.20-0309-reasoning": listed(1.25, 0.2, 2.5),
	"grok-4.20-0309-non-reasoning": listed(1.25, 0.2, 2.5),
	"grok-4.20-multi-agent-0309": listed(1.25, 0.2, 2.5),
	"grok-build-0.1": listed(1, 0.2, 2),

	// Open-weight and other models, at the OpenCode Zen list price (before
	// any limited-time discount): https://opencode.ai/docs/zen, checked
	// 2026-11-23. Zen's free models are left out.
	"gemini-3.5-flash": listed(1.5, 0.15, 9),
	"glm-5.3": listed(1.4, 0.26, 4.4),
	"glm-5.3-flash": listed(0.15, 0.03, 0.5),
	"kimi-k3": listed(3, 0.3, 15, 3),
	"kimi-k2.7-code": listed(0.95, 0.19, 4),
	"kimi-k2.6": listed(0.95, 0.16, 4),
	"kimi-k2.5": listed(0.6, 0.1, 3),
	"minimax-m3": listed(0.3, 0.06, 1.2),
	"minimax-m2.7": listed(0.3, 0.06, 1.2),
	"minimax-m2.5": listed(0.3, 0.06, 1.2),
	"mistral-large-4": listed(1.36, 0.14, 4.18),
	"qwen3.8-max": listed(2, 0.25, 6, 2.5),
	"qwen3.8-flash": listed(0.15, 0.016, 0.47, 0.2),
	"qwen3.6-plus": listed(0.5, 0.05, 3, 0.625),
	"qwen3.5-plus": listed(0.2, 0.02, 1.2, 0.25),
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
 * `openai/…`, `opencode-go/…`, `anthropic.…` on Bedrock), a date suffix
 * (`-20260101`, `@20260101`, `-2026-01-01`), `-latest`, or a `[1m]` tag.
 */
export function normalizeModel(model: string): string {
	let m = model.trim().toLowerCase();
	m = m.replace(/\[[^\]]*\]$/, "");
	const slash = m.lastIndexOf("/");
	if (slash >= 0) m = m.slice(slash + 1);
	m = m.replace(/^(?:us\.|eu\.|global\.)?anthropic\./, "");
	m = m.replace(/-latest$/, "");
	m = m
		.replace(/[-@]\d{8}$/, "")
		.replace(/-\d{4}-\d{2}-\d{2}$/, "")
		.replace(/-v\d+(?::\d+)?$/, "");
	return m;
}

/** What may follow a table key in a model id it covers: version numbers or a date. */
const VERSION_TAIL = /^\d+(?:[-.]\d+)*$/;

/**
 * The price for a model: the table key that is the model id, or else the
 * longest key the id extends with a version number or date
 * (`claude-opus-4` covers `claude-opus-4-8`, `deepseek-v4.1-flash` covers
 * `deepseek-v4.1-flash-1017`). A variant name after the key never matches,
 * so `gpt-5` does not price `gpt-5-mini` or `gpt-5-search-api`. Custom
 * entries win over defaults with the same key. Null when nothing matches
 * (unpriced).
 */
export function priceFor(
	model: string,
	table: ReadonlyMap<string, Price>,
): Price | null {
	const m = normalizeModel(model);
	const exact = table.get(m);
	if (exact) return exact;
	let best: { key: string; price: Price } | null = null;
	for (const [key, price] of table) {
		if (!m.startsWith(`${key}-`)) continue;
		if (!VERSION_TAIL.test(m.slice(key.length + 1))) continue;
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
