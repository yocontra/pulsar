import { describe, expect, test } from "bun:test";
import {
	costOf,
	DEFAULT_PRICES,
	normalizeModel,
	type Price,
	priceFor,
	priceTable,
} from "../src/usage/prices.ts";

const table = priceTable({});
const price = (model: string) => priceFor(model, table);
const M = 1_000_000;

describe("default price table", () => {
	test("every key is a normalized id that prices itself", () => {
		for (const key of Object.keys(DEFAULT_PRICES)) {
			expect(normalizeModel(key)).toBe(key);
			expect(price(key)).toBe(DEFAULT_PRICES[key] as Price);
		}
	});

	test("every price is finite and non-negative, with a cache write price", () => {
		for (const [key, p] of Object.entries(DEFAULT_PRICES)) {
			for (const v of Object.values(p)) {
				expect(Number.isFinite(v)).toBe(true);
				expect(v).toBeGreaterThanOrEqual(0);
			}
			// A missing write price would make cache writes free.
			expect(p.cacheWrite5m, key).toBeGreaterThan(0);
			expect(p.cacheWrite1h, key).toBeGreaterThan(0);
		}
	});
});

describe("model id matching", () => {
	test("OpenAI: provider prefixes, dated snapshots and -latest", () => {
		expect(price("gpt-6.2-sol")?.input).toBe(2);
		expect(price("openai/gpt-6.2-sol")?.input).toBe(2);
		expect(price("opencode/gpt-6.2-astra")?.output).toBe(40);
		expect(price("GPT-6.2-Sol-2026-10-01")?.input).toBe(2);
		expect(price("gpt-6.2-sol-latest")?.input).toBe(2);
		expect(price("gpt-5.5-20260301")?.output).toBe(30);
	});

	test("OpenAI: a size or tier name is its own model, never its base's price", () => {
		expect(price("gpt-5-mini")?.input).toBe(0.25);
		expect(price("gpt-5-nano")?.input).toBe(0.05);
		expect(price("gpt-5.4-mini")?.input).toBe(0.75);
		expect(price("gpt-5.5-pro")?.input).toBe(30);
		expect(price("gpt-6-luna")?.input).toBe(0.1);
		// Variants with no listed price stay unpriced.
		expect(price("gpt-5-search-api")).toBeNull();
		expect(price("gpt-5.5-cyber-preview")).toBeNull();
		expect(price("gpt-6-luna-decision")).toBeNull();
		expect(price("gpt-5.6-sol")).toBeNull();
		expect(price("gpt-6.3-sol")).toBeNull();
	});

	test("Codex models", () => {
		expect(price("gpt-5.3-codex")?.output).toBe(14);
		expect(price("gpt-5.1-codex-mini")?.input).toBe(0.25);
		expect(price("gpt-5.1-codex-max")?.input).toBe(1.25);
		expect(price("gpt-5.1-codex")?.input).toBe(1.07);
		expect(price("codex-mini-latest")).toBeNull();
	});

	test("DeepSeek: both naming schemes and numbered snapshots", () => {
		expect(price("deepseek-flash")?.input).toBe(0.15);
		expect(price("deepseek-v4.1-flash")?.input).toBe(0.15);
		expect(price("opencode-go/deepseek-v4.1-flash")?.output).toBe(0.6);
		expect(price("deepseek-v4.1-flash-1017")?.cacheRead).toBe(0.003);
		expect(price("deepseek-v4-pro")?.output).toBe(1.98);
		// Venice's retired snapshot has its own price; Zen's free tier has none.
		expect(price("deepseek-v4-flash-0731")?.input).toBe(0.13);
		expect(price("deepseek-v4-flash-0731")?.cacheRead).toBe(0.13);
		expect(price("deepseek-v4-flash")).toBeNull();
		expect(price("deepseek-v4.1-flash-free")).toBeNull();
	});

	test("Gemini, Grok and open-weight models", () => {
		expect(price("models/gemini-4-carbon")?.input).toBe(4);
		expect(price("google/gemini-3.1-pro-preview")?.output).toBe(12);
		expect(price("gemini-3.5-flash-lite")?.input).toBe(0.3);
		expect(price("gemini-3.5-flash")?.input).toBe(1.5);
		expect(price("xai/grok-4.7")?.cacheRead).toBe(0.5);
		expect(price("grok-4.20-0309-reasoning")?.input).toBe(1.25);
		expect(price("opencode-go/kimi-k3")?.cacheWrite5m).toBe(3);
		expect(price("qwen3.8-max")?.cacheWrite1h).toBe(2.5);
		expect(price("glm-5.3")?.input).toBe(1.4);
		expect(price("glm-5.3-flash")?.input).toBe(0.15);
		expect(price("grok-4")).toBeNull();
		expect(price("qwen4-max")).toBeNull();
	});

	test("Claude still matches by version", () => {
		expect(price("anthropic/claude-opus-5-5")?.input).toBe(4);
		expect(price("claude-opus-4-8-20260101")?.input).toBe(5);
		expect(price("claude-opus-50")).toBeNull();
	});

	test("local and unknown models stay unpriced", () => {
		expect(price("local/heretic-pure")).toBeNull();
		expect(
			price("hf.co/mradermacher/gemma-4-31B-it-heretic-GGUF:Q4_K_M"),
		).toBeNull();
		expect(price("unknown")).toBeNull();
		expect(price("")).toBeNull();
	});

	test("a custom price covers numbered versions and beats the default", () => {
		const t = priceTable({
			"acme-coder": {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite5m: 1,
				cacheWrite1h: 1,
			},
			"gpt-6.2-sol": null,
		});
		expect(priceFor("acme-coder-2", t)?.output).toBe(2);
		expect(priceFor("acme-coder-mini", t)).toBeNull();
		expect(priceFor("gpt-6.2-sol", t)).toBeNull();
	});
});

describe("cost", () => {
	test("Codex-shaped tokens at the GPT-6.2 Sol price", () => {
		// Cached reads, a cache write (Codex reports it as 5m), output with reasoning.
		const c = costOf(
			{
				input: 2 * M,
				cacheRead: 10 * M,
				cacheWrite5m: M,
				cacheWrite1h: 0,
				output: M,
			},
			price("gpt-6.2-sol") as Price,
		);
		expect(c).toBeCloseTo(2 * 2 + 10 * 0.1 + 2.5 + 10, 9);
	});

	test("a provider with no write price bills writes as input", () => {
		const p = price("deepseek-v4.1-flash") as Price;
		const c = costOf(
			{ input: M, cacheRead: M, cacheWrite5m: M, cacheWrite1h: M, output: M },
			p,
		);
		expect(c).toBeCloseTo(0.15 + 0.003 + 0.15 + 0.15 + 0.6, 9);
	});

	test("a model with no cached-input price bills reads as input", () => {
		const p = price("gpt-5.5-pro") as Price;
		expect(p.cacheRead).toBe(30);
	});
});
