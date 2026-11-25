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
 * Phone git actions (web/src/features/git/GitPhone.tsx): the branch button
 * in the agent header opens the git sheet (overview, quick action, reasons),
 * the commit form and the PR card in the same sheet (web/mock/git.ts).
 */

const H = { "X-Pulsar": "1" };

async function mock(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

/** The agent page's git sheet; a software passkey answers Prove Human (WebKit). */
async function sheetFor(
	page: Page,
	request: APIRequestContext,
	selector: string,
) {
	const id = await agentId(request, selector);
	await resetPasskeys(request);
	await softAuthenticator(page);
	await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
	await page.getByRole("button", { name: /^Git: / }).click();
	return sheetNamed(page, "Git");
}

/**
 * The git sheet (one SheetShell, "Git", for every view), once its heading
 * says `name`. Its content is slotted light DOM, so tests query from the
 * host element.
 */
async function sheetNamed(page: Page, name: string) {
	await expect(page.getByRole("dialog", { name: "Git" })).toBeVisible();
	const sheet = page.getByTestId("git-sheet");
	await expect(sheet.getByRole("heading", { level: 2 })).toHaveText(name);
	return sheet;
}

test.describe("git sheet", () => {
	test.afterEach(async ({ request }) => {
		await mock(request, "realtime", { action: "restore" });
	});

	test("outside a repository the agent menu offers Files and hides Git", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=omp@apparish");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.getByRole("button", { name: "More", exact: true }).click();
		await expect(
			page.getByRole("menuitem", { name: "Files", exact: true }),
		).toBeVisible();
		await expect(
			page.getByRole("menuitem", {
				name: /^(Git$|Open Branch|Open Repository|Open Pull Request|Issue #)/,
			}),
		).toHaveCount(0);
		await expect(page.locator(".g-phone-btn, .p-changes-btn")).toHaveCount(0);
	});

	test("Git opens only when an action is available, including under More", async ({
		page,
		request,
	}) => {
		const id = await agentId(
			request,
			"name=codex@apparish branch=feat/billing",
		);
		let conflicted = 1;
		let preservePr = false;
		await page.route("**/git/status", async (route) => {
			const response = await route.fetch();
			await route.fulfill({
				response,
				json: {
					...(await response.json()),
					conflicted,
					behind: 0,
					ahead: 1,
					...(!preservePr && { pr: null }),
				},
			});
		});
		await page.setViewportSize({ width: 390, height: 844 });
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page.getByRole("button", { name: /^Git: / })).toBeDisabled();
		await page.setViewportSize({ width: 350, height: 844 });
		const more = page.getByRole("button", { name: "More", exact: true });
		await more.click();
		const git = page.getByRole("menuitem", { name: "Git", exact: true });
		await expect(git).toBeDisabled();
		await git.click({ force: true });
		await expect(page.getByRole("dialog", { name: "Git" })).toBeHidden();
		conflicted = 0;
		await page.setViewportSize({ width: 390, height: 844 });
		await page.reload();
		await expect(page.getByRole("button", { name: /^Git: / })).toBeEnabled();
		await page.setViewportSize({ width: 350, height: 844 });
		await more.click();
		await expect(git).toBeEnabled();
		await git.click();
		const sheet = await sheetNamed(page, "Git");
		await expect(
			sheet.getByRole("button", { name: "Push", exact: true }),
		).toBeEnabled();
		preservePr = true;
		conflicted = 1;
		const withPr = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(withPr)}`);
		await more.click();
		await expect(git).toBeEnabled();
		await git.click();
		const prSheet = await sheetNamed(page, "Git");
		await expect(
			prSheet.getByRole("button", { name: "Commit", exact: true }).first(),
		).toBeDisabled();
		await expect(
			prSheet.getByRole("button", { name: /PR #1402/ }),
		).toBeEnabled();
	});

	test("overview → commit form → confirm → Prove Human → progress → done", async ({
		page,
		browserName,
		request,
	}) => {
		// Linux WebKit (CI) has no WebAuthn at all: Prove Human can't run.
		test.skip(
			process.platform === "linux" && browserName === "webkit",
			"no WebAuthn in Linux WebKit",
		);
		const sheet = await sheetFor(page, request, "name=apparish-auth");
		const rows = sheet.locator(".g-rows");
		await expect(rows).toContainText("fix-1378");
		await expect(rows).toContainText("7 files");
		await expect(rows).toContainText("Up to date with origin/fix-1378");
		await expect(rows.getByRole("button", { name: /PR #1402/ })).toContainText(
			"Open",
		);
		expect(
			await contrastFailures(
				page,
				'[data-testid="git-sheet"] .p-sheet-frame *',
			),
		).toEqual([]);
		await sheet.getByRole("button", { name: "Commit & push" }).click();
		const form = await sheetNamed(page, "Commit changes");
		const message = form.getByPlaceholder("Describe your changes…");
		await expect(form.locator(".g-file")).toHaveCount(7);
		await form.getByRole("button", { name: "Draft from changes" }).click();
		await expect(message).toHaveValue(/^Update /);
		await form.getByRole("button", { name: "Commit", exact: true }).click();
		// The agent is mid-turn: the sheet asks first.
		const busy = page.getByRole("alertdialog", {
			name: "apparish-auth is working",
		});
		await busy.getByRole("button", { name: "Commit anyway" }).click();
		await proveInSheet(page);
		const sheet2 = await sheetNamed(page, "Git");
		await expect(sheet2.locator(".g-progress")).toHaveText(
			"Pushed to origin/fix-1378",
		);
		await expect(sheet2.locator(".g-rows")).toContainText("Clean");
	});

	test("commit on a new branch from the sheet", async ({
		page,
		browserName,
		request,
	}) => {
		// Linux WebKit (CI) has no WebAuthn at all: Prove Human can't run.
		test.skip(
			process.platform === "linux" && browserName === "webkit",
			"no WebAuthn in Linux WebKit",
		);
		const sheet = await sheetFor(page, request, "name=apparish-auth");
		await sheet.getByRole("button", { name: "Commit", exact: true }).click();
		const form = await sheetNamed(page, "Commit changes");
		await form.getByPlaceholder("Describe your changes…").fill("Fix the race");
		await form.getByRole("button", { name: "Commit on new branch" }).click();
		const branch = form.getByLabel("New branch");
		await expect(branch).toHaveValue("pulsar/fix-the-race");
		await form.getByRole("button", { name: "Commit on new branch" }).click();
		await page
			.getByRole("alertdialog", { name: "apparish-auth is working" })
			.getByRole("button", { name: "Commit anyway" })
			.click();
		await proveInSheet(page);
		const git = await sheetNamed(page, "Git");
		await expect(git.locator(".g-progress")).toContainText("Committed");
		await expect(git.locator(".g-rows")).toContainText("pulsar/fix-the-race");
		await expect(git.locator(".g-rows")).toContainText(
			"Not pushed to origin/pulsar/fix-the-race yet",
		);
	});

	test("reasons under the buttons; the PR card and Ask to fix", async ({
		page,
		request,
	}) => {
		await mock(request, "git", {
			agent: "codex@apparish",
			set: { behind: 2, ahead: 0 },
		});
		let sheet = await sheetFor(
			page,
			request,
			"name=codex@apparish branch=feat/billing",
		);
		await expect(
			sheet.getByRole("button", { name: "Push", exact: true }).first(),
		).toBeDisabled();
		await expect(sheet).toContainText(
			"Branch is behind upstream. Pull or rebase before pushing.",
		);
		await expect(sheet).toContainText(
			"Commit: Worktree is clean. Make changes before committing.",
		);

		sheet = await sheetFor(page, request, "name=apparish-auth");
		await sheet.getByRole("button", { name: /PR #1402/ }).click();
		const pr = await sheetNamed(page, "Pull request");
		await expect(pr.getByRole("region", { name: "Checks" })).toContainText(
			"1 failing",
		);
		await expect(pr.locator(".g-comment")).toHaveCount(2);
		expect(
			await contrastFailures(
				page,
				'[data-testid="git-sheet"] .p-sheet-frame *',
			),
		).toEqual([]);
		await pr.getByRole("button", { name: "Ask apparish-auth to fix" }).click();
		const ask = await sheetNamed(page, "Ask apparish-auth to fix");
		await expect(ask.getByLabel("Message")).toHaveValue(/^Please fix PR #1402/);
		await ask.getByRole("button", { name: "Send to apparish-auth" }).click();
		await expect(page.locator("[data-sonner-toast]")).toContainText(
			"Asked apparish-auth to fix",
		);
	});
});
