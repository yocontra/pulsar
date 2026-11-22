import { diagnosticsSuite } from "./diagnostics.shared.ts";
import { expect, ready, test } from "./fixtures.ts";

// Chromium (desktop layout).
diagnosticsSuite("desktop");

test("Cmd-K opens Diagnostics", async ({ page }) => {
	await ready(page);
	await page.getByRole("button", { name: "Search", exact: true }).click();
	await page.getByRole("textbox", { name: "Search" }).fill("doctor");
	await page
		.getByRole("listbox", { name: "Results" })
		.getByRole("option", { name: /Diagnostics/ })
		.click();
	await expect(page).toHaveURL(/#\/diagnostics$/);
	await expect(
		page.getByRole("main", { name: "Diagnostics" }).locator(".diag-machine"),
	).toHaveCount(4);
});
