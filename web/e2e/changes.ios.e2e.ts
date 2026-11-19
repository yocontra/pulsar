import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * The phone's changes pages: "Changes (N)" on the agent page pushes the
 * file list, a file pushes its unified diff (web/mock/changes.ts).
 */

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

test.describe("changes pages", () => {
	test("agent → Changes (7) → file list → unified diff → back", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const button = page.getByRole("button", { name: "Changes (7)" });
		await expect(button).toBeVisible();
		await button.click();
		await expect(page).toHaveURL(/#\/changes\//);
		const list = top(page);
		await expect(list.locator(".cv-file")).toHaveCount(7);
		await expect(list.locator(".cv-branch")).toContainText("fix-1378");
		expect(await contrastFailures(page, ".cv-phone *")).toEqual([]);

		await list.locator(".cv-file", { hasText: "refresh.ts" }).first().click();
		await expect(page).toHaveURL(/\?f=src%2Fauth%2Frefresh\.ts/);
		const file = top(page);
		await expect(file.locator(".ds-diff.unified")).toBeVisible();
		await expect(file.locator(".ds-diff-row.del").first()).toContainText(
			"let refreshing",
		);
		await expect(file.locator(".ds-diff-split, .ds-diff.split")).toHaveCount(0);

		await file.getByRole("button", { name: "Back" }).click();
		await expect(page).toHaveURL(/#\/changes\/[^?]+$/);
		await top(page).getByRole("radio", { name: "Branch vs base" }).click();
		await expect(top(page).locator(".cv-file")).toHaveCount(8);
		await top(page).getByRole("radio", { name: "Working tree" }).click();
	});

	test("a file page says so when the changes can't be read", async ({
		page,
		request,
		errors,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.route(/\/api\/v1\/agents\/[^/]+\/changes(\?|$)/, (r) =>
			r.fulfill({ status: 500, body: "{}" }),
		);
		await page.goto(
			`/#/changes/${encodeURIComponent(id)}?f=${encodeURIComponent("src/auth/refresh.ts")}`,
		);
		await expect(top(page).getByRole("alert")).toContainText(
			"Couldn't read this agent's changes.",
		);
		await expect(top(page).locator(".cv-loading")).toHaveCount(0);
		errors.splice(
			0,
			errors.length,
			...errors.filter((e) => !/status of 500/.test(e)),
		);
	});

	test("binary and too-large files, and an agent with no repo", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(
			`/#/changes/${encodeURIComponent(id)}?f=${encodeURIComponent("assets/logo.png")}`,
		);
		await expect(top(page).locator(".cv-placeholder")).toContainText(
			"Binary file",
		);
		await page.goto(
			`/#/changes/${encodeURIComponent(id)}?f=${encodeURIComponent("fixtures/recording.json")}`,
		);
		await expect(top(page).locator(".cv-placeholder")).toContainText(
			"over 512 KB",
		);
		const omp = await agentId(request, "name=omp@apparish");
		await page.goto(`/#/changes/${encodeURIComponent(omp)}`);
		await expect(top(page).locator(".cv-empty")).toContainText(
			"isn't in a git repository",
		);
	});
});
