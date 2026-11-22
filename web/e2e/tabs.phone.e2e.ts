/**
 * The phone's tab bar (mobile/tabs.ts, mobile/ui/TabBar.tsx), on iOS
 * (WebKit, the `ios` project) and Android (Chromium, Material, `android`):
 * switching tabs adds no history and doesn't animate, each tab keeps its
 * root's scroll, re-tapping scrolls to the top, pushed pages cover the bar,
 * deep links go back to Agents, and Android's back returns to Agents.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/** An ion-content element, as the page sees it. */
type ScrollerHost = { getScrollElement(): Promise<HTMLElement> };

const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);
const bar = (page: Page) => page.getByTestId("tabbar");
const topContent = (page: Page) =>
	page.locator("ion-nav > .ion-page:last-child ion-content");

test.describe("tabs", () => {
	test("the platform look follows the device", async ({ page }, info) => {
		await ready(page);
		const md = info.project.name === "android";
		await expect(page.locator("html")).toHaveClass(md ? /\bmd\b/ : /\bios\b/);
		await expect(page.locator("html")).toHaveClass(
			md ? /\bk-material\b/ : /\bk-ios\b/,
		);
		// The forced look: ?platform= (tests and screenshots).
		await page.goto(md ? "/?platform=ios" : "/?platform=android");
		await expect(page.locator("html")).toHaveClass(md ? /\bios\b/ : /\bmd\b/);
		await expect(bar(page)).toBeVisible();
	});

	test("switching tabs adds no history and keeps each root's scroll", async ({
		page,
	}) => {
		await ready(page);
		await expect(bar(page)).toBeVisible();
		await expect(tab(page, "agents")).toHaveAttribute("aria-current", "page");
		const len = await page.evaluate(() => history.length);

		// Scroll Agents, visit every tab, come back: the scroll is kept.
		await topContent(page).evaluate(async (c) => {
			const el = await (c as unknown as ScrollerHost).getScrollElement();
			el.scrollTop = 300;
		});
		await tab(page, "needs").click();
		await expect(page).toHaveURL(/#\/needs$/);
		await expect(tab(page, "needs")).toHaveAttribute("aria-current", "page");
		await expect(
			page.locator("ion-nav > .ion-page:last-child ion-title").first(),
		).toHaveText("Needs You");
		// A tab's root has no back button.
		await expect(
			page.locator("ion-nav > .ion-page:last-child .p-back"),
		).toHaveCount(0);
		await tab(page, "usage").click();
		await expect(page).toHaveURL(/#\/usage$/);
		await tab(page, "settings").click();
		await expect(page).toHaveURL(/#\/settings$/);
		// One entry holds every non-Agents tab.
		expect(await page.evaluate(() => history.length)).toBe(len + 1);
		await tab(page, "agents").click();
		await expect(page).toHaveURL(/#\/$|\/$/);
		await expect(tab(page, "agents")).toHaveAttribute("aria-current", "page");
		await expect
			.poll(() =>
				topContent(page).evaluate(
					async (c) =>
						(await (c as unknown as ScrollerHost).getScrollElement()).scrollTop,
				),
			)
			.toBe(300);
	});

	test("a pushed page covers the bar; re-tapping the tab scrolls to the top", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		// An agent page pushed from Agents: the bar hides, back returns.
		await page.evaluate((id) => {
			// The app's own push (lib/router navigate), as a row tap does.
			history.pushState({ depth: 1 }, "", `#/a/${encodeURIComponent(id)}`);
			dispatchEvent(new PopStateEvent("popstate", { state: { depth: 1 } }));
		}, id);
		await expect(page).toHaveURL(/#\/a\//);
		await expect(bar(page)).toHaveAttribute("aria-hidden", "true");
		await expect(bar(page)).not.toBeInViewport();
		await page.goBack();
		await expect(page).toHaveURL(/\/(#\/)?$/);
		await expect(bar(page)).toBeInViewport();
		await expect(bar(page)).not.toHaveAttribute("aria-hidden", "true");

		// Re-tapping the active tab at its root scrolls it to the top.
		await topContent(page).evaluate(async (c) => {
			const el = await (c as unknown as ScrollerHost).getScrollElement();
			el.scrollTop = 200;
		});
		await tab(page, "agents").click();
		await expect
			.poll(() =>
				topContent(page).evaluate(
					async (c) =>
						(await (c as unknown as ScrollerHost).getScrollElement()).scrollTop,
				),
			)
			.toBe(0);
	});

	test("a deep link to an agent goes back to Agents, then out", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await expect(page).toHaveURL(/#\/a\//);
		await expect(bar(page)).not.toBeInViewport();
		// The system back (Android) lands on Agents first.
		await page.goBack();
		await expect(page).toHaveURL(/#\/$/);
		await expect(bar(page)).toBeInViewport();
		await expect(tab(page, "agents")).toHaveAttribute("aria-current", "page");
	});

	test("opened on a tab, back returns to Agents", async ({ page }) => {
		await page.goto("/#/settings");
		await expect(tab(page, "settings")).toHaveAttribute("aria-current", "page");
		await page.goBack();
		await expect(page).toHaveURL(/#\/$/);
		await expect(tab(page, "agents")).toHaveAttribute("aria-current", "page");
	});

	test("Needs You shows the live count", async ({ page }) => {
		await ready(page);
		const n = await page.evaluate(async () => {
			const r = await fetch("/api/v1/attention", {
				headers: { "X-Pulsar": "1" },
			});
			return ((await r.json()) as { items: unknown[] }).items.length;
		});
		if (n > 0)
			await expect(tab(page, "needs")).toHaveAttribute(
				"aria-label",
				`Needs You, ${n}`,
			);
		else
			await expect(tab(page, "needs")).toHaveAttribute(
				"aria-label",
				"Needs You",
			);
	});
});
