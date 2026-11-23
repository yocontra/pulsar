import { openAgent, plusMenu } from "./composer.shared.ts";
import { agentId, expect, test } from "./fixtures.ts";
import { ran, slashSuite } from "./slash.shared.ts";

slashSuite("phone");

test("+ → Skills & Commands opens the command sheet: search, tap inserts, Run sends (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=apparish-auth");
	const id = await agentId(request, "name=apparish-auth");
	await (await plusMenu(page, composer))
		.getByRole("menuitem", { name: "Skills & Commands" })
		.click();
	const sheet = page.getByTestId("slash-sheet");
	await expect(page.getByRole("dialog", { name: "Commands" })).toBeVisible();
	await sheet.getByPlaceholder("Search commands and skills").fill("ship");
	await sheet.getByRole("button", { name: "/ship", exact: true }).click();
	await expect(composer.locator(".composer-input")).toHaveValue("/ship ");
	// A command that takes nothing runs from the sheet in one tap.
	await (await plusMenu(page, composer))
		.getByRole("menuitem", { name: "Skills & Commands" })
		.click();
	await sheet.getByPlaceholder("Search commands and skills").fill("recap");
	await sheet.getByRole("button", { name: "Run /recap", exact: true }).click();
	await expect(
		page.getByText("Ran /recap in apparish-auth's session"),
	).toBeVisible();
	expect(await ran(request)).toContainEqual({ agent: id, line: "/recap" });
});

test("the mode chip above the composer opens the mode sheet (phone)", async ({
	page,
	request,
}) => {
	const composer = await openAgent(page, request, "name=codex@apparish");
	const chip = composer.getByTestId("mode-chip");
	await expect(chip).toHaveText("Default");
	await chip.click();
	await page.getByRole("button", { name: "Plan", exact: true }).click();
	await expect(page.getByText("codex@apparish is in Plan mode")).toBeVisible();
});

test("the agent page's More menu has Mode… (phone)", async ({
	page,
	request,
}) => {
	await openAgent(page, request, "name=chat-blocks");
	await page
		.getByTestId("agent-actions")
		.getByRole("button", { name: "More", exact: true })
		.click();
	await page.getByRole("menuitem", { name: "Mode…" }).click();
	await expect(page.getByText(/^Now: Manual/)).toBeVisible();
	await page.getByRole("button", { name: "Accept edits", exact: true }).click();
	await expect(
		page.getByText("chat-blocks is in Accept edits mode"),
	).toBeVisible();
});
