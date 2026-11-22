import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/** The usage page on the phone: the Usage tab opens it (web/mock/usage.ts). */

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

test.describe("usage page", () => {
	test("Home → Usage → toggles → model sheet → back", async ({ page }) => {
		await page.goto("/");
		await page.getByTestId("tab-usage").click();
		await expect(page).toHaveURL(/#\/usage$/);
		const p = top(page);
		await expect(p.getByTestId("usage-total")).toHaveText(/^\$[\d,.]+$/);
		await expect(
			p.getByRole("list", { name: "By harness" }).locator("li"),
		).toHaveCount(3);
		// Narrow: the period is a compact select.
		await p.getByRole("combobox", { name: "Period" }).selectOption("24h");
		await expect(p.getByRole("img", { name: "Hourly cost" })).toBeVisible();
		await p.getByRole("radio", { name: "Tokens" }).click();
		await expect(p.getByTestId("usage-total")).toHaveText(/^[\d.]+[KMBT]$/);
		expect(await contrastFailures(page, ".usage *")).toEqual([]);

		await p
			.locator(".usage-breakdown .usage-row", { hasText: "claude-opus-5-5" })
			.click();
		const sheet = page.getByRole("dialog", { name: "claude-opus-5-5" });
		await expect(sheet).toContainText("Per million tokens");
		await sheet.getByRole("button", { name: "Close" }).last().click();
		await expect(sheet).toHaveCount(0);

		// Usage is a tab: back to Agents through the tab bar.
		await page.getByTestId("tab-agents").click();
		await expect(page).not.toHaveURL(/#\/usage/);
	});
});
