/**
 * Hover hints on the desktop screens: every icon-only button or link has a
 * `title` (an aria-label is spoken, never shown to a mouse user), and every
 * relative time ("4 min ago", "3h") carries its full date in a `title`.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";
import { untitledIconControls, untitledRelativeTimes } from "./ui-audit.ts";

type Screen = [name: string, open: (page: Page, id: string) => Promise<void>];

const session = async (page: Page, id: string) => {
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await page.locator(".transcript .ev").first().waitFor();
};

const SCREENS: Screen[] = [
	["home tree", async (page) => ready(page)],
	["agent page header and composer", session],
	[
		"changes panel",
		async (page, id) => {
			await session(page, id);
			await page.getByRole("button", { name: /^Changes/ }).click();
			await page
				.getByRole("complementary", { name: "Changes" })
				.locator(".cv-file")
				.first()
				.waitFor();
		},
	],
	[
		"usage",
		async (page) => {
			await ready(page);
			await page
				.locator(".d-brand")
				.getByRole("button", { name: "Usage" })
				.click();
			await page.getByTestId("usage-total").waitFor();
		},
	],
	[
		"settings",
		async (page) => {
			await ready(page);
			await page.getByRole("button", { name: "Settings" }).first().click();
			await page.getByRole("radiogroup", { name: "Appearance" }).waitFor();
		},
	],
	[
		"palette",
		async (page) => {
			await ready(page);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByRole("dialog").first().waitFor();
		},
	],
	[
		"needs you",
		async (page) => {
			await page.goto("/#/needs");
			await page.locator(".d-main").first().waitFor();
		},
	],
	[
		"broadcast",
		async (page) => {
			await ready(page);
			await page.keyboard.press("ControlOrMeta+Shift+b");
			await page.getByTestId("match-count").waitFor();
		},
	],
];

test.describe("hover titles", () => {
	for (const [name, open] of SCREENS)
		test(`${name}: icon-only controls and relative times have titles`, async ({
			page,
			request,
		}) => {
			const id = await agentId(request, "name=apparish-auth");
			await open(page, id);
			await page.waitForTimeout(300);
			expect.soft(await untitledIconControls(page), `${name}: icon-only controls`)
				.toEqual([]);
			expect.soft(await untitledRelativeTimes(page), `${name}: relative times`)
				.toEqual([]);
		});
});
