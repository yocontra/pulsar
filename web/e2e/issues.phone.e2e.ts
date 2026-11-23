import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, localhostBase, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Phone issue awareness (web/src/features/issues/IssuePhone.tsx): no
 * top-bar button; the agent menu's "Issue #1378" (•••) opens the card in a
 * sheet; the Home row shows the issue (web/mock/issues.ts). apparish-auth
 * works on #1378.
 */

const H = { "X-Pulsar": "1" };

async function ghMode(request: APIRequestContext, mode: string) {
	const res = await request.post("/api/v1/__mock/issue", {
		headers: H,
		data: { mode },
	});
	expect(res.ok()).toBe(true);
}

/** The issue sheet; its content is slotted light DOM (query from the host). */
async function sheet(page: Page) {
	await expect(page.getByRole("dialog", { name: "Issue #1378" })).toBeVisible();
	const s = page.getByTestId("issue-sheet");
	await expect(s.getByRole("heading", { level: 2 })).toHaveText("Issue #1378");
	return s;
}

/** The agent page's ••• menu, then "Issue #1378". */
async function fromMenu(page: Page) {
	await page
		.locator("ion-header.p-agent-header")
		.getByRole("button", { name: "More" })
		.click();
	await page.getByRole("button", { name: "Issue #1378" }).click();
}

test.describe("issue sheet", () => {
	test.afterEach(async ({ request }) => {
		await ghMode(request, "ok");
	});

	test("the ••• menu opens the card in a sheet; no top-bar button", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		const head = page.locator("ion-header.p-agent-header");
		await expect(head.locator("h1")).toHaveText("apparish-auth");
		await expect(head.getByRole("button", { name: "Issue #1378" })).toHaveCount(
			0,
		);
		await fromMenu(page);
		const s = await sheet(page);
		await expect(s.locator(".i-title a")).toHaveText(
			"#1378 Token refresh races with logout",
		);
		await expect(s.locator(".i-state")).toHaveText("Open");
		await expect(s.locator(".i-label")).toHaveText([
			"bug",
			"auth",
			"good first issue",
		]);
		await expect(s.locator(".i-assignees")).toHaveText(
			"Assigned to octo, mona",
		);
		await expect(
			s.locator(".i-body").getByRole("heading", { name: "Steps" }),
		).toBeVisible();
		await expect(s.getByRole("link", { name: "Open on GitHub" })).toBeVisible();
		expect(
			await contrastFailures(
				page,
				'[data-testid="issue-sheet"] .p-sheet-frame *',
			),
		).toEqual([]);
		await s.getByRole("button", { name: "Close" }).click();
		await expect(page.getByRole("dialog", { name: "Issue #1378" })).toHaveCount(
			0,
		);
	});

	test("the Home row shows the issue", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/`);
		await page.locator('[data-tree-node="m:studio"]').first().waitFor();
		const project = page.locator(
			'[data-tree-node="m:studio/p:apparish"] ion-item',
		);
		if (!(await project.isVisible()))
			await page
				.locator('[data-tree-node="m:studio"] ion-item')
				.first()
				.click();
		await project.click();
		const row = page.locator(".p-row.is-agent", { hasText: "apparish-auth" });
		await expect(row.first().locator(".p-issue")).toHaveText("#1378");
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		await fromMenu(page);
		const s = await sheet(page);
		await expect(s).toContainText("Token refresh races with logout");
	});

	test("gh logged out: says why", async ({ page, request }) => {
		await ghMode(request, "logged_out");
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`${localhostBase()}/#/a/${encodeURIComponent(id)}`);
		await fromMenu(page);
		const s = await sheet(page);
		await expect(s).toContainText(
			"gh is not logged in on studio. Run gh auth login there.",
		);
	});
});
