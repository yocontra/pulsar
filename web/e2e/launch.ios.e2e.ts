import { expect, ready, test } from "./fixtures.ts";

/**
 * New agent on the phone: Home's header button, the full-screen draft with
 * its chips, pickers as pages, Send's reason, and Prove Human before it
 * starts (the passkey itself is covered on the desktop: WebKit has no
 * virtual authenticator).
 */
test("the phone's draft: chips, picker pages, and Prove Human to start", async ({
	page,
}) => {
	await ready(page);
	await page.getByRole("button", { name: "New agent" }).click();
	await expect(page).toHaveURL(/#\/new$/);
	const d = page.getByTestId("launch-draft");
	await expect(
		page.locator("ion-title", { hasText: "New agent" }).last(),
	).toBeVisible();
	await expect(d.getByRole("heading", { level: 1 })).toContainText(
		/Start an agent in.+on\s*studio/,
	);

	// A picker is a page with Back.
	await page.getByTestId("launch-workspace").click();
	const pickerPage = page.getByRole("dialog", { name: "Workspace" });
	await expect(pickerPage).toBeVisible();
	await pickerPage.getByRole("option", { name: "New worktree" }).click();
	await expect(pickerPage).toHaveCount(0);
	await page.getByTestId("launch-base").click();
	const branches = page.getByRole("dialog", { name: "Base branch" });
	await branches
		.getByRole("searchbox", { name: "Search branches..." })
		.fill("zzz");
	await expect(branches.getByText("No branches available")).toBeVisible();
	await branches.getByRole("button", { name: "Back" }).click();
	await expect(branches).toHaveCount(0);

	const box = d.getByRole("textbox", { name: "First message" });
	await box.fill("hello from the phone");
	await page.getByRole("button", { name: "Start agent" }).click();
	const sheet = page.getByRole("dialog", { name: "Prove Human" });
	await expect(sheet).toBeVisible();
	await sheet
		.getByRole("button", { name: /close|cancel/i })
		.first()
		.click();
	await expect(sheet).toHaveCount(0);
	// Cancelled: nothing started, the message is still there.
	await expect(box).toHaveValue("hello from the phone");
	await expect(page.getByRole("button", { name: "Start agent" })).toBeEnabled();
});
