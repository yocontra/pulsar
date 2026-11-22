import type { APIRequestContext, Page } from "@playwright/test";
import {
	agentId,
	expect,
	localhostBase,
	proveInSheet,
	resetPasskeys,
	test,
} from "./fixtures.ts";
import { softAuthenticator } from "./soft-webauthn.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Phone PR review (web/src/features/prreview/ReviewPhone.tsx): the git
 * sheet's PR card opens the review page; Files pushes one file's page with
 * its threads; a line comment, a resolve and the review sheet each run as
 * an acting op (web/mock/prreview.ts).
 */

const H = { "X-Pulsar": "1" };

async function mock(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

async function openReview(page: Page, request: APIRequestContext) {
	const id = await agentId(request, "name=apparish-auth");
	await resetPasskeys(request);
	await softAuthenticator(page);
	await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
	await page.getByRole("button", { name: /^Git: / }).click();
	const sheet = page.locator("ion-modal.g-modal");
	await sheet.getByRole("button", { name: /PR #1402/ }).click();
	await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(
		"Pull request",
	);
	await sheet.getByRole("button", { name: "Review" }).click();
	// The sheet closes and the review page is pushed.
	await expect(page.locator(".prv-phone .prv-title h2")).toContainText(
		"Fix the token refresh race",
	);
	await expect(page.getByRole("dialog", { name: "Git" })).toHaveCount(0);
	return id;
}

const toast = (page: Page, text: string) =>
	page.locator("[data-sonner-toast]", { hasText: text }).first();

test.describe("PR review (phone)", () => {
	test.afterEach(async ({ request }) => {
		await mock(request, "realtime", { action: "restore" });
	});

	test("tabs, a file's threads, a line comment, resolve, the review sheet", async ({
		page,
		request,
	}) => {
		// Linux WebKit (CI) has no WebAuthn at all: Prove Human can't run.
		test.skip(process.platform === "linux", "no WebAuthn in Linux WebKit");
		await openReview(page, request);
		const view = page.locator(".prv-phone");
		await expect(
			view.getByRole("region", { name: "Description" }),
		).toContainText("Two refreshes that start together raced");
		expect(await contrastFailures(page, ".prv-phone *")).toEqual([]);
		const tabs = view.getByRole("tablist", { name: "Review" });
		await tabs.getByRole("tab", { name: "Checks" }).click();
		await expect(view.locator(".g-check")).toHaveCount(3);
		await tabs.getByRole("tab", { name: "Files" }).click();
		await expect(view).toContainText("2 open threads");
		await view
			.getByRole("button", { name: /refresh\.ts/ })
			.first()
			.click();

		// The file's page: outdated thread first, the open one at its line.
		const file = page.locator(".prv-phone-file");
		await expect(file.locator(".prv-loose")).toContainText("Outdated");
		const open = file
			.locator(".prv-at-line")
			.getByRole("region", { name: "Thread by reviewer", exact: true });
		await expect(open).toContainText("Use the mutex here too.");
		expect(
			await contrastFailures(page, ".prv-thread *, .cv-section-head *"),
		).toEqual([]);

		// Comment on a line: tap its gutter button.
		await file.getByRole("button", { name: "Comment on line 41" }).click();
		await file
			.getByRole("textbox", { name: "New comment" })
			.fill("Shorter, please.");
		await file.getByRole("button", { name: "Comment", exact: true }).click();
		await proveInSheet(page);
		await expect(toast(page, "Comment added")).toBeVisible();
		await expect(
			file.getByRole("region", { name: "Thread by operator" }),
		).toContainText("Shorter, please.");
		await open.getByRole("button", { name: "Resolve" }).click();
		await expect(toast(page, "Thread resolved")).toBeVisible();

		// Back to the PR; Review opens the sheet.
		await page.getByRole("button", { name: "Back" }).last().click();
		await expect(
			page.locator(".prv-phone:not(.prv-phone-file) .prv-title"),
		).toBeVisible();
		await page
			.locator(".prv-phone:not(.prv-phone-file)")
			.getByRole("button", { name: "Submit review" })
			.click();
		const sheet = page.locator("ion-modal.g-modal");
		await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(
			"Submit review",
		);
		await expect(sheet.getByRole("radio", { name: /Approve/ })).toBeDisabled();
		await sheet.getByLabel("Review summary").fill("Good to go once CI passes.");
		await sheet.getByRole("button", { name: "Submit review" }).click();
		await expect(toast(page, "Review submitted")).toBeVisible();
		await expect(
			page.getByRole("dialog", { name: "Submit review" }),
		).toHaveCount(0);
		const pr = page.locator(".prv-phone:not(.prv-phone-file)");
		await pr.getByRole("tab", { name: "Summary" }).click();
		await expect(pr.getByRole("region", { name: "Reviews" })).toContainText(
			"Good to go once CI passes.",
		);
	});

	test("no PR: the page says so", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await mock(request, "git", { agent: "apparish-auth", set: { pr: null } });
		await page.goto(`${localhostBase()}/#/pr/${encodeURIComponent(id)}`);
		await expect(page.getByText("No PR for this branch.")).toBeVisible();
	});
});
