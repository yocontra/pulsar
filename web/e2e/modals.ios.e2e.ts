/**
 * Phone (iOS): every sheet and viewer has one X in its corner with a 44 pt
 * hit area, and the X and a tap on the backdrop each close it
 * (modals.shared.ts). No sheet shows a grabber.
 */
import type { Page } from "@playwright/test";
import { expect, ready, test } from "./fixtures.ts";
import {
	blocksConversation,
	type Modal,
	mockRealtime,
	modalSuite,
} from "./modals.shared.ts";

/** The top sheet, once it has presented. */
async function sheet(page: Page) {
	const m = page.locator("ion-modal.show-modal");
	await expect(m).toHaveCount(1);
	// Let the present animation finish: taps during it don't land.
	await page.waitForTimeout(600);
	return m;
}

/**
 * Home, without a reload once the app is up: a reload aborts fetches in
 * flight, which WebKit logs as console errors.
 */
async function home(page: Page) {
	if (page.url().startsWith("http"))
		await page.evaluate(() => {
			location.hash = "#/";
		});
	else await ready(page);
	await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
}

async function broadcast(page: Page) {
	await home(page);
	await page.getByRole("button", { name: "Broadcast…" }).tap();
	await page.getByTestId("match-count").waitFor();
}

const MODALS: Modal[] = [
	{
		name: "broadcast sheet",
		open: async (page) => {
			await broadcast(page);
			return sheet(page);
		},
	},
	{
		name: "facet picker",
		open: async (page) => {
			await broadcast(page);
			await sheet(page);
			await page.getByRole("button", { name: "Narrow it down" }).tap();
			await page
				.getByRole("region", { name: "machine facet" })
				.getByRole("button", { name: /^All/ })
				.tap();
			const picker = page.getByRole("dialog", { name: "Choose machine" });
			await expect(picker).toBeVisible();
			return picker;
		},
		after: async (page, way) => {
			if (way === "x") {
				// The X closes the picker; the broadcast sheet stays.
				await expect(page.getByTestId("match-count")).toBeVisible();
				return;
			}
			// The backdrop closes the whole sheet, picker and all, and a new
			// broadcast opens clean.
			await expect(page.locator("ion-modal")).toHaveCount(0);
			expect(new URL(page.url()).hash).not.toMatch(/^#\/broadcast/);
			await broadcast(page);
			await expect(
				page.getByRole("dialog", { name: "Choose machine" }),
			).toHaveCount(0);
		},
	},
	{
		name: "broadcast confirm",
		open: async (page) => {
			await broadcast(page);
			await sheet(page);
			await page.getByLabel("Broadcast message").fill("main is frozen");
			await page.getByRole("button", { name: /^Send to \d/ }).tap();
			const box = page.getByRole("alertdialog", { name: "Confirm broadcast" });
			await expect(box).toBeVisible();
			await page.waitForTimeout(400);
			return box;
		},
		// Closing the confirm leaves the broadcast sheet open.
		after: async (page) => {
			await expect(page.getByTestId("match-count")).toBeVisible();
			await expect(page.locator("ion-modal.show-modal")).toHaveCount(1);
		},
	},
	{
		name: "broadcast results",
		open: async (page) => {
			await home(page);
			await page.goto(
				`/#/broadcast?s=${encodeURIComponent("name=apparish-auth")}`,
			);
			const m = await sheet(page);
			await page.getByLabel("Broadcast message").fill("rebase on main");
			await page.getByRole("button", { name: /^Send to 1/ }).tap();
			await expect(
				m.getByRole("dialog", { name: "Broadcast results" }),
			).toBeVisible();
			return m;
		},
	},
	{
		name: "group sheet",
		open: async (page) => {
			await home(page);
			await page.goto("/#/n/m%3Astudio");
			await page.locator("ion-modal h1").waitFor();
			const m = await sheet(page);
			// The broken "minus": no grabber on any sheet.
			expect(
				await m.evaluate(
					(el) => !!el.shadowRoot?.querySelector(".modal-handle"),
				),
			).toBe(false);
			return m;
		},
	},
	{
		name: "prove human",
		open: async (page) => {
			await home(page);
			await page.getByTestId("tab-settings").tap();
			await page.getByRole("button", { name: /^Prove Human/ }).tap();
			return page.locator(".prove-backdrop");
		},
	},
	{
		name: "image viewer",
		open: async (page, request) => {
			const conv = await blocksConversation(page, request);
			const thumb = conv.locator(".ds-thumb").first();
			await thumb.scrollIntoViewIfNeeded();
			await thumb.tap();
			const box = page.locator(".ds-lightbox");
			await expect(box.locator("img")).toBeVisible();
			return box;
		},
	},
	{
		name: "PDF viewer",
		// Full screen on a phone, like the image viewer without its stage.
		noBackdrop: true,
		open: async (page, request) => {
			const conv = await blocksConversation(page, request);
			const doc = conv.locator(".ds-doc").first();
			await doc.scrollIntoViewIfNeeded();
			await doc.tap();
			return page.locator(".ds-pdf");
		},
	},
];

test.afterEach(async ({ request }) => {
	await mockRealtime(request, { action: "restore" });
});

modalSuite(MODALS, true);

test("a send in flight holds the sheet: the X is disabled and the backdrop waits", async ({
	page,
}) => {
	let release!: () => void;
	const held = new Promise<void>((r) => {
		release = r;
	});
	await page.route("**/api/v1/send", async (route) => {
		const body = route.request().postDataJSON() as { dryRun?: boolean };
		if (!body?.dryRun) await held;
		await route.continue();
	});
	await home(page);
	await page.goto(`/#/broadcast?s=${encodeURIComponent("name=apparish-auth")}`);
	const m = await sheet(page);
	await page.getByLabel("Broadcast message").fill("rebase on main");
	await page.getByRole("button", { name: /^Send to 1/ }).tap();
	await expect(
		m.getByRole("button", { name: "Close", exact: true }),
	).toBeDisabled();
	await page.touchscreen.tap(Math.round(page.viewportSize()!.width / 2), 6);
	await page.waitForTimeout(500);
	await expect(m).toBeVisible();
	release();
	await expect(
		m.getByRole("dialog", { name: "Broadcast results" }),
	).toBeVisible();
});
