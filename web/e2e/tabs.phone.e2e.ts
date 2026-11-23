/**
 * The phone's tab bar (mobile/tabs.ts, mobile/ui/TabBar.tsx), on iOS
 * (WebKit, the `ios` project) and Android (Chromium, Material, `android`):
 * switching tabs adds no history and doesn't animate, each tab keeps its
 * root's scroll, re-tapping scrolls to the top, pushed pages cover the bar,
 * deep links go back to Agents, and Android's back returns to Agents.
 */
import type { Page } from "@playwright/test";
import { expectIonicStyledUnderCsp } from "./csp-phone.ts";
import { agentId, expect, ready, test } from "./fixtures.ts";

/** An ion-content element, as the page sees it. */
type ScrollerHost = { getScrollElement(): Promise<HTMLElement> };

const tab = (page: Page, id: string) => page.getByTestId(`tab-${id}`);
const bar = (page: Page) => page.getByTestId("tabbar");
const topContent = (page: Page) =>
	page.locator("ion-nav > .ion-page:last-child ion-content");

/**
 * A phone's body text and bottom inset: WebKit and Chromium emulation report
 * no safe area, and macOS WebKit gives -apple-system-body 13px (an iPhone's
 * is 17px). Android's gesture bar is 24 dp.
 */
async function phoneInsets(page: Page, md: boolean) {
	await page.addInitScript(
		(sab) => {
			const apply = () => {
				const r = document.documentElement?.style;
				if (!r) return;
				r.setProperty("font-size", "17px");
				r.setProperty("--sab", `${sab}px`);
			};
			apply();
			document.addEventListener("DOMContentLoaded", apply);
		},
		md ? 24 : 34,
	);
}

/** The tab bar's metrics, as drawn. */
function barMetrics(page: Page) {
	return page.evaluate(() => {
		const q = (s: string) => document.querySelector(s) as HTMLElement;
		// iOS: the glass capsule; Material: the bar's row (its pane is
		// display: contents).
		const bar = (
			q('[data-testid="tabbar"] .k-toolbar-pane') ??
			q('[data-testid="tabbar"] > div:last-child')
		).getBoundingClientRect();
		const links = [
			...document.querySelectorAll('[data-testid="tabbar"] .k-link'),
		].map((e) => e.getBoundingClientRect());
		const icon = q('[data-testid="tab-agents"] svg').getBoundingClientRect();
		const label = getComputedStyle(
			q('[data-testid="tab-agents"] .k-tabbar-link-icon + span'),
		);
		return {
			height: bar.height,
			bottom: innerHeight - bar.bottom,
			side: bar.left,
			icon: [icon.width, icon.height],
			label: Number.parseFloat(label.fontSize),
			minHit: Math.min(...links.flatMap((l) => [l.width, l.height])),
		};
	});
}

test.describe("tabs", () => {
	test("the platform look follows the device", async ({ page }, info) => {
		await ready(page);
		const md = info.project.name === "android";
		await expect(page.locator("html")).toHaveClass(md ? /\bmd\b/ : /\bios\b/);
		await expect(page.locator("html")).toHaveClass(
			md ? /\bk-material\b/ : /\bk-ios\b/,
		);
		// This mode's Ionic and Konsta styles, under the CSP.
		await expectIonicStyledUnderCsp(page);
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
		// Named for screen readers; the tab bar shows where you are.
		await expect(
			page
				.locator("ion-nav > .ion-page:last-child")
				.locator("h1.p-tab-title, ion-title")
				.first(),
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
		// The app is up (it put Agents under the page in history).
		await expect(bar(page)).toBeAttached();
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
	test("the bar has native metrics that don't grow with the text", async ({
		page,
	}, info) => {
		const md = info.project.name === "android";
		await phoneInsets(page, md);
		await ready(page);
		await expect(bar(page)).toBeInViewport();
		const m = await barMetrics(page);
		if (md) {
			// Material 3: an 80 dp bar over the gesture bar, 24 dp icons,
			// 12 sp labels.
			expect(m.height).toBe(80);
			expect(m.bottom).toBe(24);
			expect(m.label).toBe(12);
			expect(m.icon).toEqual([24, 24]);
		} else {
			// iOS 26: a 62 pt capsule 25 pt from the sides and the bottom
			// edge, inside the home indicator's inset; 10 pt labels.
			expect(m.height).toBeGreaterThanOrEqual(56);
			expect(m.height).toBeLessThanOrEqual(64);
			expect(m.bottom).toBeGreaterThanOrEqual(20);
			expect(m.bottom).toBeLessThanOrEqual(30);
			expect(m.side).toBeGreaterThanOrEqual(16);
			expect(m.side).toBeLessThanOrEqual(28);
			expect(m.label).toBeLessThanOrEqual(11);
			expect(m.icon[0]).toBeGreaterThanOrEqual(24);
			expect(m.icon[0]).toBeLessThanOrEqual(28);
		}
		// Every tab is at least a 44 pt target.
		expect(m.minHit).toBeGreaterThanOrEqual(44);
		// Larger body text (Dynamic Type) leaves the bar as it is.
		await page.evaluate(() =>
			document.documentElement.style.setProperty("font-size", "23px"),
		);
		expect(await barMetrics(page)).toEqual(m);
	});

	// Tab roots on TabShell with no controls of their own. (Needs You and
	// Settings join when they move to TabShell.)
	for (const [hash, name] of [["#/usage", "Usage"]])
		test(`${hash}: no title or empty bar; content starts under the status bar`, async ({
			page,
		}, info) => {
			await phoneInsets(page, info.project.name === "android");
			await page.addInitScript(() =>
				document.addEventListener("DOMContentLoaded", () =>
					document.documentElement.style.setProperty("--sat", "47px"),
				),
			);
			await page.goto(`/${hash}`);
			await expect(bar(page)).toBeInViewport();
			const top = page.locator("ion-nav > .ion-page:last-child");
			// No bar: these roots have no controls of their own.
			await expect(top.locator("ion-header, ion-title")).toHaveCount(0);
			await expect(top.getByRole("heading", { level: 1, name })).toBeAttached();
			await page.waitForTimeout(300);
			const r = await topContent(page).evaluate((c) => {
				// The first painted leaf: right under the status bar.
				const first = [...c.querySelectorAll("*")]
					.filter(
						(e) =>
							e.childElementCount === 0 &&
							!e.closest(".p-tab-title, [slot=fixed]") &&
							e.getBoundingClientRect().height > 0 &&
							e.checkVisibility(),
					)
					.map((e) => e.getBoundingClientRect().top);
				return Math.min(...first);
			});
			expect(r).toBeGreaterThanOrEqual(47);
			// No large title's worth of space above it.
			expect(r).toBeLessThanOrEqual(47 + 48);
		});

	test("Agents: no title; one slim row of search and actions under the status bar", async ({
		page,
	}, info) => {
		await phoneInsets(page, info.project.name === "android");
		await page.addInitScript(() =>
			document.addEventListener("DOMContentLoaded", () =>
				document.documentElement.style.setProperty("--sat", "47px"),
			),
		);
		await ready(page);
		const top = page.locator("ion-nav > .ion-page:last-child");
		await expect(top.locator("ion-title")).toHaveCount(0);
		await expect(
			top.getByRole("heading", { level: 1, name: "Agents" }),
		).toBeAttached();
		const row = top.locator(".p-tab-row");
		await expect(row).toBeVisible();
		await expect(row.getByLabel("Search agents and messages")).toBeVisible();
		const m = await row.evaluate((r) => {
			const box = (e: Element) => e.getBoundingClientRect();
			const field = box(r.querySelector(".p-tab-row-main")!);
			const buttons = [...r.querySelectorAll(".p-tab-row-end ion-button")]
				.filter((b) => b.checkVisibility())
				.map(box);
			const header = box(r.closest("ion-header")!);
			return {
				rowTop: box(r).top,
				rowHeight: box(r).height,
				headerBottom: header.bottom,
				field,
				buttons,
			};
		});
		// Right under the status bar, and slim: no large title's room.
		expect(m.rowTop).toBeGreaterThanOrEqual(47);
		expect(m.rowHeight).toBeLessThanOrEqual(64);
		expect(m.headerBottom).toBeLessThanOrEqual(47 + 72);
		// The actions sit beside the field, never over it.
		expect(m.buttons.length).toBeGreaterThan(0);
		for (const b of m.buttons) {
			expect(b.left).toBeGreaterThanOrEqual(m.field.right);
			expect(b.width).toBeGreaterThanOrEqual(36);
		}
	});

	for (const hash of ["#/", "#/needs", "#/usage", "#/settings"])
		test(`${hash}: the last row scrolls clear of the tab bar`, async ({
			page,
		}, info) => {
			await phoneInsets(page, info.project.name === "android");
			await page.goto(`/${hash}`);
			await expect(bar(page)).toBeInViewport();
			await page.waitForTimeout(500);
			const r = await topContent(page).evaluate(async (c) => {
				const el = await (c as unknown as ScrollerHost).getScrollElement();
				el.scrollTop = el.scrollHeight;
				await new Promise((r) => setTimeout(r, 300));
				// Rows and text (leaves), not containers padded past them.
				const kids = [...c.querySelectorAll("*")].filter(
					(e) =>
						e.childElementCount === 0 &&
						(e as HTMLElement).offsetParent &&
						e.getBoundingClientRect().height > 0,
				);
				const last = Math.max(
					...kids.map((e) => e.getBoundingClientRect().bottom),
				);
				const barTop = document
					.querySelector(
						'[data-testid="tabbar"] .k-toolbar-pane, [data-testid="tabbar"]',
					)!
					.getBoundingClientRect().top;
				return { last, barTop };
			});
			expect(r.last).toBeLessThanOrEqual(r.barTop + 1);
		});
});
