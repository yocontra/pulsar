/**
 * Desktop: every dialog and viewer has one X in its corner, and the X, a
 * click on the backdrop and Escape each close it (modals.shared.ts).
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, ready, test } from "./fixtures.ts";
import {
	blocksConversation,
	type Modal,
	mockRealtime,
	modalSuite,
} from "./modals.shared.ts";

const dialog = (page: Page, name: string) =>
	page.getByRole("dialog", { name, exact: true });

async function builder(page: Page, selector: string) {
	await ready(page);
	await page.goto(`/#/broadcast?s=${encodeURIComponent(selector)}`);
	await page.getByTestId("match-count").waitFor();
	await page.getByLabel("Broadcast message").fill("rebase on main");
}

async function busyAgent(request: APIRequestContext) {
	const res = await request.get(
		"/api/v1/agents?selector=status%3Dbusy&limit=100",
		{ headers: { "X-Pulsar": "1" } },
	);
	const { items } = (await res.json()) as {
		items: { id: string; canStop: boolean }[];
	};
	const busy = items.find((a) => a.canStop);
	if (!busy) throw new Error("no stoppable agent in the mock");
	return busy.id;
}

const MODALS: Modal[] = [
	{
		name: "palette",
		open: async (page) => {
			await ready(page);
			const palette = dialog(page, "Search the pool");
			await page.keyboard.press("ControlOrMeta+k");
			await expect(palette).toBeVisible();
			return palette;
		},
	},
	{
		name: "settings",
		open: async (page) => {
			await ready(page);
			await page.getByRole("button", { name: "Settings" }).first().click();
			return dialog(page, "Settings");
		},
	},
	{
		name: "open on phone (QR)",
		open: async (page) => {
			await ready(page);
			await page.getByRole("button", { name: /phone/i }).first().click();
			return dialog(page, "Open on phone");
		},
	},
	{
		name: "keyboard shortcuts",
		open: async (page) => {
			await ready(page);
			await page.keyboard.press("?");
			return dialog(page, "Keyboard shortcuts");
		},
	},
	{
		name: "broadcast builder",
		open: async (page) => {
			await builder(page, "*");
			return dialog(page, "Broadcast");
		},
	},
	{
		name: "broadcast confirm",
		open: async (page) => {
			await builder(page, "*");
			await page.getByRole("button", { name: /^Send to \d/ }).click();
			return page.getByRole("alertdialog", { name: "Confirm broadcast" });
		},
		// Closing the confirm leaves the builder open.
		after: async (page) => {
			await expect(dialog(page, "Broadcast")).toBeVisible();
		},
	},
	{
		name: "broadcast results",
		open: async (page) => {
			await builder(page, "project=billing");
			await page.getByRole("button", { name: /^Send to \d/ }).click();
			await page
				.getByRole("alertdialog", { name: "Confirm broadcast" })
				.getByRole("button", { name: /^Send to/ })
				.click();
			return dialog(page, "Broadcast results");
		},
	},
	{
		name: "confirm stop",
		open: async (page, request) => {
			const id = await busyAgent(request);
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.getByRole("button", { name: "Stop", exact: true }).click();
			return page.getByRole("alertdialog", { name: "Confirm stop" });
		},
	},
	{
		name: "prove human",
		open: async (page) => {
			await ready(page);
			await page.getByRole("button", { name: /^Prove Human/ }).click();
			return dialog(page, "Prove Human");
		},
	},
	{
		name: "image viewer",
		open: async (page, request) => {
			const conv = await blocksConversation(page, request);
			const thumb = conv.locator(".ds-thumb").first();
			await thumb.scrollIntoViewIfNeeded();
			await thumb.click();
			const box = page.locator(".ds-lightbox");
			await expect(box.locator("img")).toBeVisible();
			return box;
		},
	},
	{
		name: "PDF viewer",
		open: async (page, request) => {
			const conv = await blocksConversation(page, request);
			const doc = conv.locator(".ds-doc").first();
			await doc.scrollIntoViewIfNeeded();
			await doc.click();
			return page.locator(".ds-pdf");
		},
	},
];

test.afterEach(async ({ request }) => {
	await mockRealtime(request, { action: "restore" });
});

modalSuite(MODALS, false);

test("a send in flight: the X, the backdrop and Escape wait for it", async ({
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
	await builder(page, "name=apparish-auth");
	const box = dialog(page, "Broadcast");
	await page.getByRole("button", { name: /^Send to 1/ }).click();
	const x = box.getByRole("button", { name: "Close", exact: true });
	await expect(x).toBeDisabled();
	await page.keyboard.press("Escape");
	await page.mouse.click(6, 6);
	await page.waitForTimeout(300);
	await expect(box).toBeVisible();
	release();
	await expect(dialog(page, "Broadcast results")).toBeVisible();
});
