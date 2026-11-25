import type { Page } from "@playwright/test";
import {
	copies,
	expectCopyOutside,
	expectFileKeys,
	expectRefs,
	fileUrl,
	openGallery,
	recordCopies,
	ref,
} from "./files.shared.ts";
import { agentId, expect, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/** The phone file viewer: one pushed page per folder or file. */

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

test.describe("file viewer", () => {
	test.beforeEach(async ({ page }) => {
		await recordCopies(page);
	});

	test("keyboard controls find text and move between source lines", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "fixture=blocks");
		await page.goto(
			`/#/file/${encodeURIComponent(id)}?path=src%2Fauth%2Frefresh.ts&line=7`,
		);
		const view = top(page).getByTestId("files-page");
		await expectFileKeys(view);
		// The same actions are available without a hardware keyboard.
		await view.getByRole("button", { name: "Go to line" }).click();
		await view.getByRole("spinbutton", { name: "Line number" }).fill("7");
		await view.getByRole("button", { name: "Go", exact: true }).click();
		await expect(view.getByText("Line 7 of 12")).toBeVisible();
	});

	test("a file reference pushes the file; an outside path copies", async ({
		page,
	}) => {
		const id = await openGallery(page);
		await expectRefs(page);
		await expectCopyOutside(page);

		await ref(page, "QA report").click();
		await expect(page).toHaveURL(fileUrl(id, "out/qa/report.html"));
		const p = top(page);
		await expect(p.locator("ion-title")).toContainText("report.html");
		await expect(p.locator(".ds-code")).toContainText("All checks passed.");
		await p.getByRole("button", { name: "Back" }).click();
		await expect(page).toHaveURL(new RegExp(`#/a/${encodeURIComponent(id)}$`));
	});

	test("folders push pages; a changed file offers Open in Changes", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/file/${encodeURIComponent(id)}`);
		let p = top(page);
		await p
			.getByRole("group", { name: "Files" })
			.getByRole("button", { name: "src" })
			.click();
		await expect(page).toHaveURL(/\?path=src$/);
		p = top(page);
		await expect(p.locator("ion-title")).toContainText("src");
		await p
			.getByRole("group", { name: "Files" })
			.getByRole("button", { name: "auth" })
			.click();
		p = top(page);
		await p
			.getByRole("group", { name: "Files" })
			.getByRole("button", { name: "refresh.ts" })
			.click();
		p = top(page);
		await expect(p.locator(".ds-code")).toContainText(
			"const lock = new Mutex();",
		);
		expect(await contrastFailures(page, ".fv-phone .fv-head *")).toEqual([]);
		await p.getByRole("button", { name: "Copy path" }).click();
		await expect(page.getByText("Path copied")).toBeVisible();
		expect(await copies(page)).toContain(
			"~/Projects/apparish/src/auth/refresh.ts",
		);
		await p.getByRole("button", { name: "Open in Changes" }).click();
		await expect(page).toHaveURL(/#\/changes\/.*\?f=src%2Fauth%2Frefresh\.ts$/);
	});
	test("the agent's ••• menu opens Files; a secret needs Show", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await top(page).getByRole("button", { name: "More" }).click();
		await page.getByRole("menuitem", { name: "Files", exact: true }).click();
		await expect(page).toHaveURL(
			new RegExp(`#/file/${encodeURIComponent(id)}$`),
		);
		let p = top(page);
		await p
			.getByRole("group", { name: "Files" })
			.getByRole("button", { name: ".env.local" })
			.click();
		p = top(page);
		await expect(p).toContainText("This file may hold secrets");
		await expect(p).not.toContainText("API_TOKEN");
		expect(await contrastFailures(page, ".fv-phone .fv-secret *")).toEqual([]);
		await p.getByRole("button", { name: "Show", exact: true }).click();
		await expect(p.locator(".ds-code")).toContainText("API_TOKEN=");
	});
});
