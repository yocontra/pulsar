/**
 * The Usage tab on the phone (usage/UsagePhone.tsx), on iOS and Android:
 * period and metric as segmented controls, machine and harness pickers as
 * list rows that open sheets, the chart card, totals, the breakdown and a
 * model's sheet. Readable from 320 to 430 px wide (web/mock/usage.ts).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

async function openUsage(page: Page) {
	await page.goto("/");
	await page.getByTestId("tab-usage").click();
	await expect(page).toHaveURL(/#\/usage$/);
	await expect(top(page).getByTestId("usage-total")).toHaveText(/^\$[\d,.]+$/);
}

test.describe("usage tab", () => {
	test("period, metric, pickers, model sheet", async ({ page }) => {
		await openUsage(page);
		const p = top(page);
		await expect(p.getByLabel("By harness").locator("li")).toHaveCount(3);
		// No refresh control: the report is live.
		await expect(p.getByRole("button", { name: /refresh/i })).toHaveCount(0);

		await p
			.getByRole("radiogroup", { name: "Period" })
			.getByRole("radio", { name: "24h" })
			.click();
		await expect(p.getByRole("radio", { name: "24h" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await expect(p.getByRole("img", { name: "Hourly cost" })).toBeVisible();
		await p.getByRole("radio", { name: "Tokens" }).click();
		await expect(p.getByTestId("usage-total")).toHaveText(/^[\d.]+[KMBT]$/);
		expect(await contrastFailures(page, ".p-usage *")).toEqual([]);

		// The harness picker: a sheet of choices; the row shows the pick.
		await p.getByTestId("usage-harness").click();
		const sheet = page.getByTestId("actions");
		await sheet.getByRole("button", { name: "Codex" }).click();
		await expect(p.getByTestId("usage-harness")).toContainText("Codex");
		await expect(p.getByLabel("By harness").locator("li")).toHaveCount(1);
		await p.getByTestId("usage-harness").click();
		await sheet.getByRole("button", { name: "All harnesses" }).click();
		await expect(p.getByTestId("usage-harness")).toContainText("All");

		// A model's sheet.
		await p.getByRole("radio", { name: "Cost" }).click();
		// A local model's row says why it costs nothing.
		await expect(
			p
				.getByLabel("Breakdown", { exact: true })
				.locator('[data-model="qwen3.8:27b[local]"]'),
		).toContainText("Local · $0");
		await p
			.getByLabel("Breakdown", { exact: true })
			.locator('[data-model="claude-opus-5-5"]')
			.click();
		// The sheet (an IonModal): named for the model; its host holds the content.
		await expect(
			page.getByRole("dialog", { name: "claude-opus-5-5" }),
		).toBeVisible();
		const model = page.getByTestId("usage-sheet");
		await expect(model).toContainText("Per million tokens");
		await model.getByRole("button", { name: "Close" }).last().click();
		await expect(model).toHaveCount(0);

		await page.getByTestId("tab-agents").click();
		await expect(page).not.toHaveURL(/#\/usage/);
	});

	test("AA contrast in dark", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await openUsage(page);
		expect(await contrastFailures(page, ".p-usage *")).toEqual([]);
	});

	for (const width of [320, 375, 430])
		test(`fits ${width} px: no sideways scroll, the chart fills its card`, async ({
			page,
		}) => {
			await page.setViewportSize({ width, height: 800 });
			await openUsage(page);
			const r = await top(page).evaluate((el) => {
				const card = el
					.querySelector(".p-usage-chart")!
					.getBoundingClientRect();
				const chart = el
					.querySelector(".p-usage-chart .usage-chart")!
					.getBoundingClientRect();
				const overflow = [...el.querySelectorAll(".p-usage *")]
					.filter((e) => {
						const b = e.getBoundingClientRect();
						return b.width > 0 && (b.right > innerWidth + 0.5 || b.left < -0.5);
					})
					.map((e) => e.className || e.tagName)
					.slice(0, 5);
				const labels = [
					...el.querySelectorAll(".usage-chart-x span, .usage-chart-y span"),
				].map((s) => Number.parseFloat(getComputedStyle(s).fontSize));
				const segs = [...el.querySelectorAll('[role="radio"]')].map(
					(b) => b.getBoundingClientRect().height,
				);
				return {
					card: card.width,
					chart: chart.width,
					overflow,
					minLabel: Math.min(...labels),
					minSeg: Math.min(...segs),
					scroll: document.scrollingElement!.scrollWidth - innerWidth,
				};
			});
			expect(r.overflow).toEqual([]);
			expect(r.scroll).toBeLessThanOrEqual(0);
			expect(r.chart).toBeGreaterThan(r.card * 0.85);
			expect(r.minLabel).toBeGreaterThanOrEqual(11);
			expect(r.minSeg).toBeGreaterThanOrEqual(28);
		});
});
