/**
 * History on the phone: entries the app did not push itself (a link in a
 * message, `#/a/…` from a card, a hash typed or opened from elsewhere) and
 * the system back (Android's back, the browser's) keep lib/router's stack in
 * step with real history, so a tab switch never goes back past the app's
 * first entry and out of the app.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

const home = (page: Page) => page.locator('[data-node="m:studio"]');

/** A plain link to a hash route, followed by the browser (no app push). */
async function followLink(page: Page, id: string) {
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	await expect(page).toHaveURL(/#\/a\//);
	await page.locator(".m-composer").last().waitFor();
}

async function expectInApp(page: Page) {
	await expect(page).toHaveURL(/^http:\/\/[^/]+\/(#\/)?$/);
	await expect(home(page).last()).toBeVisible();
}

test("a link, then back, then Settings and Agents stays in the app", async ({
	page,
	request,
}) => {
	const id = await agentId(request, "name=codex@apparish");
	await ready(page);
	await followLink(page, id);
	await page.goBack();
	await expectInApp(page);
	await page.getByTestId("tab-settings").tap();
	await expect(page).toHaveURL(/#\/settings$/);
	await page.getByTestId("tab-agents").tap();
	await expectInApp(page);
	// One entry pushed for Settings, gone again: back from Agents leaves
	// nothing of the app's behind but its first entry.
	expect(
		await page.evaluate(
			() => (history.state as { depth?: number } | null)?.depth,
		),
	).toBe(0);
});

test("two links deep, system back and in-app back return to Agents", async ({
	page,
	request,
}) => {
	const a = await agentId(request, "name=codex@apparish");
	const b = await agentId(request, "name=apparish-auth");
	await ready(page);
	await followLink(page, a);
	await followLink(page, b);
	await page.goBack();
	await expect(page).toHaveURL(new RegExp(encodeURIComponent(a)));
	// The in-app back button pops the first link's page.
	await page.getByRole("button", { name: "Back" }).last().tap();
	await expectInApp(page);
	await page.getByTestId("tab-settings").tap();
	await page.getByTestId("tab-agents").tap();
	await expectInApp(page);
});

test("a tab switch never goes back past the app's first entry", async ({
	page,
	request,
}) => {
	const id = await agentId(request, "name=codex@apparish");
	await ready(page);
	await followLink(page, id);
	await page.goBack();
	await page.getByTestId("tab-settings").tap();
	// Re-tapping Settings at its root and then Agents: still in the app.
	await page.getByTestId("tab-settings").tap();
	await page.getByTestId("tab-agents").tap();
	await expectInApp(page);
	// Settings again, then the system back: Agents, in the app.
	await page.getByTestId("tab-settings").tap();
	await page.goBack();
	await expectInApp(page);
});
