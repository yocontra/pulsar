import { expect, ready, test } from "./fixtures.ts";
import { hostedFixture, inspectHosted, openHosted } from "./hosted.shared.ts";

test("hosted tasks show offline observers and stale provider results on a phone", async ({
	page,
	errors,
}) => {
	const fixture = await hostedFixture(page);
	await ready(page);
	await openHosted(page);
	await inspectHosted(page);
	await expect.poll(fixture.detailsRead).toBe(3);
	fixture.failRefresh(true);
	const failed = page.waitForResponse((response) =>
		response.url().endsWith("/api/v1/hosted?refresh=1"),
	);
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	expect((await failed).status()).toBe(503);
	await expect(
		page.getByText("Could not refresh hosted agents.", { exact: false }),
	).toBeVisible();
	await expect(page.getByText("One hosted task")).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "GitHub Copilot" })
			.getByText("New hosted task", { exact: true }),
	).toBeHidden();
	fixture.failRefresh(false);
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(
		page
			.getByRole("region", { name: "GitHub Copilot" })
			.getByText("New hosted task", { exact: true }),
	).toBeVisible();
	expect(fixture.forcedRefreshes()).toBe(2);
	const overflow = await page
		.getByTestId("hosted")
		.evaluate((element) => element.scrollWidth - element.clientWidth);
	expect(overflow).toBeLessThanOrEqual(1);
	const injected503 = errors.findIndex((error) =>
		/^Failed to load resource:.*\b503\b/.test(error),
	);
	if (injected503 >= 0) errors.splice(injected503, 1);
});
