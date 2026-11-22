import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Desktop issue awareness (web/src/features/issues): the session header's
 * "#1378" chip opens the issue card (title, state, labels, assignees,
 * Markdown body, link); the sidebar row shows the issue and its menu opens
 * the card; gh failures read plainly (web/mock/issues.ts). apparish-auth
 * works on #1378; codex@apparish has no issue.
 */

const H = { "X-Pulsar": "1" };

async function ghMode(request: APIRequestContext, mode: string) {
	const res = await request.post("/api/v1/__mock/issue", {
		headers: H,
		data: { mode },
	});
	expect(res.ok()).toBe(true);
}

async function openAgent(page: Page, request: APIRequestContext, sel: string) {
	const id = await agentId(request, sel);
	await ready(page);
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	return id;
}

test.describe("issue card", () => {
	test.afterEach(async ({ request }) => {
		await ghMode(request, "ok");
	});

	test("the header chip opens the card", async ({ page, request }) => {
		await openAgent(page, request, "name=apparish-auth");
		const head = page.locator(".d-session-head");
		const chip = head.getByRole("button", { name: "Issue #1378" });
		await expect(chip).toHaveText("#1378");
		await chip.click();
		const card = page.getByRole("dialog", { name: "Issue #1378" });
		await expect(card).toBeVisible();
		await expect(card.locator(".i-title a")).toHaveText(
			"#1378 Token refresh races with logout",
		);
		await expect(card.locator(".i-title a")).toHaveAttribute(
			"href",
			"https://github.com/acme/apparish/issues/1378",
		);
		await expect(card.locator(".i-state")).toHaveText("Open");
		await expect(card.locator(".i-sub")).toContainText("Opened by reporter");
		await expect(
			card.getByRole("list", { name: "Labels" }).getByRole("listitem"),
		).toHaveText(["bug", "auth", "good first issue"]);
		await expect(card.locator(".i-assignees")).toHaveText(
			"Assigned to octo, mona",
		);
		// The body is Markdown: a heading, a list, code and a safe link.
		const body = card.locator(".i-body");
		await expect(body.getByRole("heading", { name: "Steps" })).toBeVisible();
		await expect(body).toContainText("comes back to life");
		await expect(body.getByRole("listitem")).toHaveCount(3);
		await expect(body).toContainText("await refresh();");
		await expect(
			body.getByRole("link", { name: "auth notes" }),
		).toHaveAttribute("rel", /noopener/);
		await expect(card.locator(".i-more")).toBeVisible();
		await expect(card.locator(".i-source")).toHaveText("From the branch name");
		await expect(
			card.getByRole("link", { name: "Open on GitHub" }),
		).toHaveAttribute("href", "https://github.com/acme/apparish/issues/1378");
		expect(await contrastFailures(page, ".i-pop *")).toEqual([]);
		await page.keyboard.press("Escape");
		await expect(card).toBeHidden();
	});

	test("no issue: no chip", async ({ page, request }) => {
		await openAgent(page, request, "name=codex@apparish branch=feat/billing");
		await expect(page.locator(".d-session-head h1")).toHaveText(
			"codex@apparish",
		);
		await expect(page.locator(".i-chip")).toHaveCount(0);
	});

	test("the sidebar row shows the issue; its menu opens the card", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		const apparish = page.locator('[data-node="m:studio/p:apparish"]');
		if ((await apparish.getAttribute("aria-expanded")) !== "true")
			await apparish.locator(".chev").click();
		const row = page.locator(`.tree [data-agent="${id}"]`);
		await expect(row.locator(".d-issue")).toHaveText("#1378");
		await expect(row).toHaveAttribute("aria-label", /issue #1378/);
		await row.click({ button: "right" });
		await page.getByRole("menuitem", { name: "Show issue #1378" }).click();
		await expect(page.locator(".d-session-head h1")).toHaveText(
			"apparish-auth",
		);
		await expect(
			page.getByRole("dialog", { name: "Issue #1378" }),
		).toContainText("Token refresh races with logout");
	});

	test("gh logged out or the issue missing: says why", async ({
		page,
		request,
	}) => {
		await ghMode(request, "logged_out");
		await openAgent(page, request, "name=apparish-auth");
		await page
			.locator(".d-session-head")
			.getByRole("button", { name: "Issue #1378" })
			.click();
		const card = page.getByRole("dialog", { name: "Issue #1378" });
		await expect(card).toContainText(
			"gh is not logged in on studio. Run gh auth login there.",
		);
		await page.keyboard.press("Escape");
		await ghMode(request, "not_found");
		await page.reload();
		await page
			.locator(".d-session-head")
			.getByRole("button", { name: "Issue #1378" })
			.click();
		await expect(
			page.getByRole("dialog", { name: "Issue #1378" }),
		).toContainText("#1378 wasn't found in this repo.");
	});
});
