import { openAgent } from "./composer.shared.ts";
import { expect, test } from "./fixtures.ts";
import { openUnproven, slashSuite } from "./slash.shared.ts";

slashSuite("desktop");

test("the mode chip switches Claude Code's mode (desktop)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const chip = composer.getByTestId("mode-chip");
	await expect(chip).toHaveText("Manual");
	await chip.click();
	const menu = page.getByTestId("mode-menu");
	await expect(menu.getByRole("menuitemradio")).toHaveText([
		/Manual/,
		/Accept edits/,
		/Plan/,
		/Bypass permissions/,
		/Auto/,
	]);
	await menu.getByRole("menuitemradio", { name: /Plan/ }).click();
	await expect(page.getByText("apparish-auth is in Plan mode")).toBeVisible();
	await expect(chip).toHaveText("Plan");
});

test("switching a mode without a passkey session asks for Prove Human; cancel keeps it (desktop)", async ({
	page,
	request,
}) => {
	const composer = await openUnproven(page, request, "name=chat-blocks");
	const chip = composer.getByTestId("mode-chip");
	await expect(chip).toHaveText("Manual");
	await chip.click();
	await page
		.getByTestId("mode-menu")
		.getByRole("menuitemradio", { name: /Accept edits/ })
		.click();
	const prove = page.getByRole("dialog", { name: "Prove Human" });
	await expect(prove).toBeVisible();
	await expect(prove).toContainText("switch an agent's mode");
	await page.keyboard.press("Escape");
	await expect(prove).toHaveCount(0);
	await expect(chip).toHaveText("Manual");
});
