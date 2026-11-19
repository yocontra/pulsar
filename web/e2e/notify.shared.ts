import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Finish and fail notifications in the app: the in-app toast (CircleCheck or
 * CircleAlert, the agent's name, "Open agent", closed once that agent opens)
 * and Settings → "Agent activity" (the select and the in-app switch, kept
 * with this browser's push subscription by `POST /push/settings`). Shared by
 * notify.desktop.e2e.ts and notify.ios.e2e.ts.
 */

async function mock(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

/** This browser has a push subscription at `endpoint` (no real push service in tests). */
async function fakeSubscription(page: Page, endpoint: string) {
	await page.addInitScript((ep) => {
		const sub = {
			endpoint: ep,
			unsubscribe: async () => true,
			toJSON: () => ({ endpoint: ep, keys: {} }),
		};
		const reg = { pushManager: { getSubscription: async () => sub } };
		Object.defineProperty(navigator.serviceWorker, "getRegistration", {
			value: async () => reg,
		});
	}, endpoint);
}

async function openSettings(page: Page, phone: boolean) {
	if (phone) {
		await page.evaluate(() => {
			location.hash = "#/settings";
		});
		const group = page.getByRole("region", { name: "Agent activity" });
		await expect(group).toBeVisible();
		return group;
	}
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: "Agent activity" })
		.click();
	const section = page.locator(
		'section[aria-labelledby="set-x-agent-activity"]',
	);
	await expect(section).toBeVisible();
	return section;
}

export function notifySuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";
	const tap = async (el: ReturnType<Page["locator"]>) =>
		phone ? el.tap() : el.click();

	test(`a finished agent shows a toast that opens it (${platform})`, async ({
		page,
		request,
	}) => {
		await ready(page);
		const id = await agentId(request, "name=apparish-auth");
		await mock(request, { action: "turn", id, kind: "finished" });
		const card = page.locator("[data-sonner-toast]");
		await expect(card).toHaveCount(1);
		await expect(card).toContainText("Agent finished");
		await expect(card).toContainText("apparish-auth");
		await expect(card.locator("svg.lucide-circle-check")).toHaveCount(1);
		await tap(card.getByRole("button", { name: "Open agent" }));
		await expect(page).toHaveURL(new RegExp(`#/a/${encodeURIComponent(id)}$`));
		await expect(card).toHaveCount(0);
	});

	test(`a failed agent shows an error toast; none for the agent on screen (${platform})`, async ({
		page,
		request,
	}) => {
		await ready(page);
		const id = await agentId(request, "name=apparish-auth");
		await mock(request, { action: "turn", id, kind: "failed" });
		const card = page.locator("[data-sonner-toast]");
		await expect(card).toContainText("Agent failed");
		await expect(card.locator("svg.lucide-circle-alert")).toHaveCount(1);
		// Opening it closes the toast.
		await page.evaluate((id) => {
			location.hash = `#/a/${encodeURIComponent(id)}`;
		}, id);
		await expect(card).toHaveCount(0);
		// While it is open, its next finish shows no toast.
		await mock(request, { action: "turn", id, kind: "finished" });
		await page.waitForTimeout(500);
		await expect(card).toHaveCount(0);
	});

	test(`Agent activity settings are kept with the subscription (${platform})`, async ({
		page,
		request,
	}) => {
		const endpoint = `https://web.push.apple.com/e2e-${platform}-${Date.now()}`;
		await mock(request, { action: "push-subscription", endpoint });
		await fakeSubscription(page, endpoint);
		await ready(page);
		const saved = () =>
			page.waitForRequest(
				(r) =>
					r.url().endsWith("/api/v1/push/settings") &&
					!!r.postDataJSON()?.turns,
			);
		let section = await openSettings(page, phone);
		if (phone) {
			const row = section.locator('[data-setting="agent-activity"]');
			await expect(row).toContainText("Notifications only");
			const req = saved();
			await row.tap();
			await page
				.locator("ion-action-sheet")
				.getByRole("button", { name: "Notifications with sound" })
				.tap();
			expect((await req).postDataJSON()).toMatchObject({
				endpoint,
				turns: "both",
			});
			await expect(row).toContainText("Notifications with sound");
		} else {
			const select = section.getByRole("combobox", {
				name: "When an agent finishes or fails",
			});
			await expect(select).toHaveValue("notify");
			const req = saved();
			await select.selectOption("both");
			expect((await req).postDataJSON()).toMatchObject({
				endpoint,
				turns: "both",
			});
		}
		// In-app off: kept on the daemon too.
		const off = page.waitForRequest(
			(r) =>
				r.url().endsWith("/api/v1/push/settings") &&
				r.postDataJSON()?.inApp === false,
		);
		const toggle = phone
			? section.locator('ion-toggle[aria-label="In-app notifications"]')
			: section.getByRole("switch", { name: "In-app notifications" });
		await tap(toggle);
		await off;
		// The daemon's copy wins after this device forgets its own.
		await page.evaluate(() => localStorage.clear());
		await ready(page);
		section = await openSettings(page, phone);
		if (phone)
			await expect(
				section.locator('[data-setting="agent-activity"]'),
			).toContainText("Notifications with sound");
		else
			await expect(
				section.getByRole("combobox", {
					name: "When an agent finishes or fails",
				}),
			).toHaveValue("both");
		// With in-app off, a finish shows no toast.
		const id = await agentId(request, "name=apparish-auth");
		await mock(request, { action: "turn", id, kind: "finished" });
		await page.waitForTimeout(500);
		await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
	});

	test(`notifications without a subscription explain why (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		const section = await openSettings(page, phone);
		if (phone) {
			const row = section.locator('[data-setting="agent-activity"]');
			// No subscription: the select shows the mode without notifications.
			await expect(row).toContainText("Off");
			await row.tap();
			await page
				.locator("ion-action-sheet")
				.getByRole("button", { name: "Notifications only" })
				.tap();
			// iPhone Safari (not the Home Screen app) can't subscribe.
			await expect(section.getByRole("alert")).toContainText("Home Screen");
		} else {
			const select = section.getByRole("combobox", {
				name: "When an agent finishes or fails",
			});
			await expect(select).toHaveValue("off");
			await select.selectOption("sound");
			await expect(select).toHaveValue("sound");
			await select.selectOption("notify");
			await expect(section.getByRole("alert")).toContainText(
				"Sound only still works",
			);
			await expect(select).toHaveValue("sound");
		}
	});
}
