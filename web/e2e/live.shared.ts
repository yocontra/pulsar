import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Data stays live with no refresh control (web/src/data/live.ts): the
 * daemon's `usage`, `git` and `machines` notices (sent here by the mock's
 * realtime knobs, web/mock/server.ts) update Usage, an agent's git status,
 * PR card and files, and Diagnostics with no user action; and no screen
 * offers a refresh-style control. Shared by live.desktop.e2e.ts and
 * live.ios.e2e.ts.
 */

const H = { "X-Pulsar": "1" };

export async function realtime(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

async function mock(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

/** The visible page: the phone's top Ionic page, or the desktop's main area. */
export const view = (page: Page, phone: boolean, name: string) =>
	phone
		? page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last()
		: page.getByRole("main", { name });

const go = (page: Page, hash: string) =>
	page.evaluate((h) => {
		location.hash = h;
	}, hash);

/** Labels that name a refresh-style control. */
const REFRESH =
	/^(refresh|reload|re-?fetch|check again|sync now|pull to refresh)\b/i;

/**
 * Refresh-style controls on screen: a button, link or menu item whose
 * label, title or text starts with a refresh word, one holding a refresh or
 * rotate icon, or a pull-to-refresh element. Error-recovery controls
 * (Retry, Try again) show only on failures, which these screens don't have.
 */
export async function refreshControls(page: Page): Promise<string[]> {
	return page.evaluate((src) => {
		const re = new RegExp(src, "i");
		const icon = /\blucide-(refresh|rotate-c)/;
		const bad: string[] = [];
		if (document.querySelector("ion-refresher")) bad.push("ion-refresher");
		const controls = document.querySelectorAll(
			'button, a[href], [role="button"], [role="menuitem"], [role="link"], ion-button, ion-item[button]',
		);
		for (const el of controls) {
			const labels = [
				el.getAttribute("aria-label"),
				el.getAttribute("title"),
				el.textContent,
			].map((l) => (l ?? "").trim());
			const hit = labels.find((l) => re.test(l));
			if (hit) bad.push(`label "${hit.slice(0, 60)}"`);
			for (const svg of el.querySelectorAll("svg"))
				if (icon.test(svg.getAttribute("class") ?? ""))
					bad.push(
						`icon ${svg.getAttribute("class")} in "${labels.join(" ").slice(0, 60)}"`,
					);
		}
		return bad;
	}, REFRESH.source);
}

export function liveSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";

	// A worker's mock keeps the app load reports earlier tests sent (some
	// fail a chunk on purpose), and doctor shows them as a note on studio:
	// start from none.
	test.beforeEach(async ({ request }) => {
		const res = await request.post("/api/v1/__mock/client-errors", {
			headers: { "X-Pulsar": "1" },
		});
		expect(res.ok()).toBe(true);
	});

	test.afterEach(async ({ request }) => {
		await mock(request, "usage", { reset: true });
		await mock(request, "diagnostics", { reset: true });
		await realtime(request, { action: "restore" });
	});

	test(`Usage updates on a usage notice, with no refresh control (${platform})`, async ({
		page,
		request,
	}) => {
		await ready(page);
		await go(page, "#/usage");
		const u = view(page, phone, "Usage");
		const total = u.getByTestId("usage-total");
		await expect(total).toHaveText(/^\$[\d,.]+$/);
		const before = await total.textContent();
		await expect(u.getByRole("button", { name: /refresh/i })).toHaveCount(0);
		// New session lines on the daemon: the total moves on its own.
		await realtime(request, { action: "usage", scale: 3 });
		await expect(total).not.toHaveText(before ?? "");
		expect(await refreshControls(page)).toEqual([]);
	});

	test(`Diagnostics checks again on its own and says when it last checked (${platform})`, async ({
		page,
		request,
	}) => {
		await page.clock.install();
		await ready(page);
		await go(page, "#/diagnostics");
		const v = view(page, phone, "Diagnostics");
		const studio = v.locator('[data-machine="studio"]');
		await expect(studio.locator(".diag-health")).toHaveText("1 note");
		await expect(page.getByTestId("diag-checked")).toHaveText(
			/^Checked (now|\d+s ago)$/,
		);
		await expect(
			page.getByRole("button", { name: /check again/i }),
		).toHaveCount(0);
		// A machine joined or changed version: every machine runs doctor
		// again (fresh), with no tap.
		await mock(request, "diagnostics", { problem: "daemon is out of date" });
		const fresh = page.waitForRequest((r) =>
			r.url().endsWith("/api/v1/diagnostics/studio?refresh=1"),
		);
		await realtime(request, { action: "machines" });
		await fresh;
		await expect(studio.locator(".diag-health")).toHaveText("1 problem");
		await expect(studio).toContainText("daemon is out of date");
		// The report stays on screen while it is checked again.
		await expect(studio.locator(".diag-check").first()).toBeVisible();
		// And again each minute while the page shows.
		await mock(request, "diagnostics", { problem: "harness is missing" });
		const again = page.waitForRequest((r) =>
			r.url().endsWith("/api/v1/diagnostics/studio?refresh=1"),
		);
		await page.clock.fastForward(61_000);
		await again;
		await expect(studio).toContainText("harness is missing");
		expect(await refreshControls(page)).toEqual([]);
	});

	test(`no screen offers a refresh-style control (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await ready(page);
		const hash = (h: string) => () => go(page, h);
		const screens: [string, () => Promise<unknown>][] = [
			["home", hash("#/")],
			["agent", hash(`#/a/${encodeURIComponent(id)}`)],
			["usage", hash("#/usage")],
			["diagnostics", hash("#/diagnostics")],
			["changes", hash(`#/changes/${encodeURIComponent(id)}`)],
			["files", hash(`#/file/${encodeURIComponent(id)}`)],
			// Settings: the phone's screen; the desktop's dialog over Home.
			[
				"settings",
				phone
					? hash("#/settings")
					: async () => {
							await ready(page);
							await page
								.getByRole("button", { name: "Settings", exact: true })
								.click();
							await expect(
								page.getByRole("navigation", { name: "Settings sections" }),
							).toBeVisible();
						},
			],
		];
		const found: Record<string, string[]> = {};
		for (const [name, open] of screens) {
			await open();
			// Let the screen and its lazy parts settle (the event stream never
			// lets the network go idle).
			await page.waitForTimeout(800);
			const bad = await refreshControls(page);
			if (bad.length) found[name] = bad;
		}
		expect(found).toEqual({});
	});
}
