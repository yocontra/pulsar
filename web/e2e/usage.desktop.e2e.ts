import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * The usage page on the desktop (web/src/usage): entry points, toggles and
 * keys, filters, the model sheet with Set price, states, and the session
 * header's usage line. Mock data: web/mock/usage.ts (mbp-b is asleep).
 */

async function mockUsage(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/usage", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

const usage = (page: Page) => page.getByRole("main", { name: "Usage" });

test.describe("usage page", () => {
	test.afterEach(async ({ request }) => {
		await mockUsage(request, { reset: true });
	});

	test("sidebar button opens it; totals, harness rows, chart and machine errors", async ({
		page,
	}) => {
		await ready(page);
		await page
			.locator(".d-brand")
			.getByRole("button", { name: "Usage" })
			.click();
		await expect(page).toHaveURL(/#\/usage$/);
		const u = usage(page);
		await expect(u.getByTestId("usage-total")).toHaveText(/^\$[\d,.]+$/);
		await expect(u.locator(".usage-sub")).toContainText(
			"35 sessions · API estimate",
		);
		const rows = u.getByRole("list", { name: "By harness" }).locator("li");
		await expect(rows).toHaveCount(3);
		await expect(rows.first()).toContainText("Claude Code");
		await expect(u.getByRole("img", { name: "Daily cost" })).toBeVisible();
		await expect(
			u.getByRole("list", { name: "Machines not counted" }),
		).toContainText("mbp-b is asleep");
		await expect(
			u.getByRole("list", { name: "Machines not counted" }),
		).not.toContainText("mbp-b: mbp-b");
		// Codex's model has no price: counted out of the estimate, said so.
		await u.getByRole("button", { name: "About unpriced usage" }).click();
		await expect(u.getByRole("note")).toContainText("acme-coder-9");
		await expect(u.getByRole("note")).not.toContainText("qwen3.8");
		await expect(u.locator("dl.usage-totals")).toContainText("Cache savings");
		expect(await contrastFailures(page, ".usage *")).toEqual([]);
	});

	test("keys: T and C, mod+shift+1..4, Esc goes back", async ({ page }) => {
		await ready(page);
		await page.keyboard.press("ControlOrMeta+u");
		const u = usage(page);
		await expect(u.getByTestId("usage-total")).toBeVisible();
		await page.keyboard.press("t");
		await expect(u.getByRole("radio", { name: "Tokens" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(u.getByTestId("usage-total")).toHaveText(/^[\d.]+[KMBT]$/);
		await page.keyboard.press("ControlOrMeta+Shift+1");
		await expect(u.getByRole("radio", { name: "24h" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(u.getByRole("img", { name: "Hourly tokens" })).toBeVisible();
		await page.keyboard.press("c");
		await expect(u.getByRole("img", { name: "Hourly cost" })).toBeVisible();
		await page.keyboard.press("ControlOrMeta+Shift+3");
		await expect(u.getByRole("radio", { name: "30d" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await page.keyboard.press("Escape");
		await expect(page).not.toHaveURL(/#\/usage/);
	});

	test("Cmd-K opens it", async ({ page }) => {
		await ready(page);
		await page.getByRole("button", { name: "Search", exact: true }).click();
		await page.getByRole("textbox", { name: "Search" }).fill("tokens");
		await page
			.getByRole("listbox", { name: "Results" })
			.getByRole("option", { name: /Usage/ })
			.click();
		await expect(page).toHaveURL(/#\/usage$/);
	});

	test("filters, breakdown by day, the chart tooltip", async ({ page }) => {
		await page.goto("/#/usage");
		const u = usage(page);
		await u.getByRole("combobox", { name: "Harness" }).selectOption("codex");
		await expect(
			u.getByRole("list", { name: "By harness" }).locator("li"),
		).toHaveCount(1);
		await expect(u.locator(".usage-sub")).toContainText("5 sessions");
		await u.getByRole("combobox", { name: "Harness" }).selectOption("");
		await u.getByRole("combobox", { name: "Machine" }).selectOption("desk");
		await expect(u.getByRole("list", { name: "By harness" })).toContainText(
			"pi",
		);
		await u.getByRole("radio", { name: "Day" }).click();
		await expect(u.locator(".usage-breakdown .usage-row")).toHaveCount(7);
		const plot = u.locator(".usage-chart-plot").first();
		await plot.hover();
		await expect(u.locator(".usage-tip")).toBeVisible();
	});

	test("model sheet: trend, Set price re-prices, Esc closes the sheet only", async ({
		page,
	}) => {
		await page.goto("/#/usage");
		const u = usage(page);
		const row = u.locator(".usage-breakdown .usage-row", {
			hasText: "acme-coder-9",
		});
		await expect(row).toContainText("No price");
		await row.click();
		const sheet = page.getByRole("dialog", { name: "acme-coder-9" });
		await expect(sheet).toContainText("Cache hit rate");
		await expect(
			sheet.getByRole("button", { name: "Set price" }),
		).toBeDisabled();
		for (const [label, v] of [
			["Input", "1"],
			["Output", "8"],
			["Cache read", "0.1"],
			["Cache write (5m)", "0"],
			["Cache write (1h)", "0"],
		] as const)
			await sheet.getByLabel(label, { exact: true }).fill(v);
		await sheet.getByRole("button", { name: "Set price" }).click();
		await expect(sheet.getByRole("status")).toContainText("Saved.");
		await expect(
			sheet.getByRole("button", { name: "Use default" }),
		).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(sheet).toHaveCount(0);
		await expect(page).toHaveURL(/#\/usage$/);
		await expect(row).toContainText(/^acme-coder-9\$[\d,.]+$/);
	});

	test("a local model reads Local · $0 and has no price form", async ({
		page,
	}) => {
		await page.goto("/#/usage");
		const u = usage(page);
		const row = u.locator(".usage-breakdown .usage-row", {
			hasText: "qwen3.8:27b",
		});
		await expect(row).toContainText("Local · $0");
		await expect(row).not.toContainText("[local]");
		await row.click();
		const sheet = page.getByRole("dialog", { name: "qwen3.8:27b" });
		await expect(sheet).toContainText("Local · $0");
		await expect(sheet.getByRole("button", { name: "Set price" })).toHaveCount(
			0,
		);
	});

	test("model prices from the machine menu", async ({ page }) => {
		await page.goto("/#/usage");
		const u = usage(page);
		await u
			.getByRole("combobox", { name: "Machine" })
			.selectOption({ label: "Model prices…" });
		const sheet = page.getByRole("dialog", { name: "Model prices" });
		await expect(sheet).toContainText("claude-opus-5-5");
		await expect(sheet).toContainText("No price yet: acme-coder-9");
		await sheet.getByRole("button", { name: "Close" }).last().click();
		await expect(sheet).toHaveCount(0);
	});

	test("empty: No usage yet.", async ({ page, request }) => {
		await mockUsage(request, { empty: true });
		await page.goto("/#/usage");
		await expect(usage(page).getByRole("status")).toHaveText("No usage yet.");
	});

	test("a load failure offers Try again", async ({ page, errors }) => {
		await page.route(/\/api\/v1\/usage(\?|$)/, (r) =>
			r.fulfill({ status: 503, body: "{}" }),
		);
		await page.goto("/#/usage");
		await expect(usage(page).getByRole("alert")).toContainText(
			"Couldn't load usage.",
		);
		// The failures this test staged are expected.
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 503/.test(e)),
		);
	});

	test("the session header shows a $0 local inference cost", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.route(/\/api\/v1\/agents\/[^/]+\/usage$/, async (route) => {
			const response = await route.fetch();
			await route.fulfill({
				response,
				json: {
					...(await response.json()),
					cost: 0,
					costSources: ["local"],
					tokenSources: ["local"],
				},
			});
		});
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.locator(".d-session-head .usage-agent")).toContainText(
			"$0 · Local inference",
		);
	});

	test("session estimate separates models across a resumed conversation", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.route(/\/api\/v1\/agents\/[^/]+\/usage$/, async (route) => {
			const original = await route.fetch();
			await route.fulfill({
				response: original,
				json: {
					...(await original.json()),
					cost: 12,
					costSources: ["estimated"],
					period: {
						firstHour: Date.UTC(2026, 10, 9, 18),
						lastHour: Date.UTC(2026, 10, 23, 18),
					},
					byModel: [
						{ model: "claude-fable-5-2", cost: 8, records: 1 },
						{ model: "claude-opus-5-5", cost: 4, records: 1 },
					],
				},
			});
		});
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const estimate = page.getByRole("button", { name: /\$12.00.*estimate/i });
		await expect(estimate).toContainText(/Nov.*9.*23/);
		await estimate.click();
		const detail = page.getByRole("dialog", { name: "Session usage by model" });
		await expect(
			detail.getByRole("row", { name: /claude-fable-5-2/ }),
		).toContainText("$8.00");
		await expect(
			detail.getByRole("row", { name: /claude-opus-5-5/ }),
		).toContainText("$4.00");
		await expect(detail).toContainText("subagent");
		await page.keyboard.press("Escape");
		await expect(detail).toHaveCount(0);
	});

	test("the session header shows context and cost", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const head = page.locator(".d-session-head");
		await expect(head.locator(".usage-agent")).toContainText(
			/Context: \d+% used/,
		);
		await expect(
			head.getByRole("meter", { name: "Context used" }),
		).toBeVisible();
	});
});
