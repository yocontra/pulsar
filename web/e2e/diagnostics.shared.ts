import type { APIRequestContext, Page } from "@playwright/test";
import { expect, ready, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Diagnostics (web/src/features/diagnostics): the pool from
 * `GET /diagnostics`, then each machine's doctor checks from
 * `GET /diagnostics/:id` as they arrive (web/mock/diagnostics.ts), grouped, with
 * fixes, machine facts and version skew; opened from Settings and Cmd-K.
 * It checks again on its own (live.shared.ts covers that). Shared by
 * diagnostics.desktop.e2e.ts and diagnostics.ios.e2e.ts.
 */

/** The visible page: the phone's top Ionic page, or the desktop's main area. */
const view = (page: Page, phone: boolean) =>
	phone
		? page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last()
		: page.getByRole("main", { name: "Diagnostics" });

async function knobs(request: APIRequestContext, body: object) {
	const res = await request.post("/api/v1/__mock/diagnostics", {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

export function diagnosticsSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";

	test.afterEach(async ({ request }) => {
		await knobs(request, { reset: true });
	});

	test(`this machine shows at once; each peer as it answers, or why it timed out (${platform})`, async ({
		page,
		request,
	}) => {
		await knobs(request, { hold: { "mbp-a": 2500 }, timeout: ["mbp-a"] });
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const studio = v.locator('[data-machine="studio"]');
		const mbp = v.locator('[data-machine="mbp-a"]');
		await expect(studio.locator(".diag-health")).toHaveText("1 note");
		// mbp-a is still being asked: a Checking… row in its place.
		await expect(mbp.getByRole("status")).toHaveText("Checking…");
		await expect(mbp.locator(".diag-check")).toHaveCount(0);
		await expect(v.locator('[data-machine="desk"] .diag-error')).toContainText(
			"upgrade pulsar on desk to see its checks",
		);
		// Then it says why it has no report.
		await expect(mbp.locator(".diag-error")).toContainText(
			"mbp-a did not answer within 35 s",
			{ timeout: 10_000 },
		);
		await expect(mbp.locator(".diag-health")).toHaveText("No report");
		await expect(mbp.getByRole("status")).toHaveCount(0);
	});

	test(`every machine's checks, fixes, facts and version skew (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		const machines = v.locator(".diag-machine");
		await expect(machines).toHaveCount(4);
		await expect(machines.locator("h2")).toHaveText([
			"studioThis machine",
			"mbp-a",
			"mbp-b",
			"desk",
		]);

		// The skew notice names each machine behind the newest version.
		const skew = v.getByRole("note", { name: "Version skew" });
		await expect(skew).toContainText("newest 2.1.0");
		await expect(skew).toContainText("Upgrade pulsar on mbp-a.");
		await expect(skew).toContainText("Upgrade pulsar on desk.");

		const studio = v.locator('[data-machine="studio"]');
		await expect(studio.locator(".diag-health")).toHaveText("1 note");
		await expect(studio.locator(".diag-facts")).toContainText("Uptime3d 4h");
		await expect(studio.locator(".diag-facts")).toContainText(
			"TailscaleRunning · 1.104.7",
		);
		await expect(studio.locator(".diag-facts")).toContainText(
			"CertificateExpires in 71 days",
		);
		await expect(studio.locator(".diag-facts")).toContainText(
			"Claude Code2.1.328",
		);
		await expect(studio.getByRole("heading", { level: 3 })).toHaveText([
			"Daemon",
			"Harnesses",
			"Approvals",
			"Remote access",
			"Agent mesh",
		]);

		// A problem: its level in words (not color alone) and its fix.
		const mbp = v.locator('[data-machine="mbp-a"]');
		await expect(mbp.locator(".diag-health")).toHaveText("1 problem");
		await expect(mbp.locator(".diag-upgrade")).toContainText(
			"upgrade pulsar on mbp-a (2.0.3; newest is 2.1.0)",
		);
		const bad = mbp.locator('.diag-check[data-level="bad"]');
		await expect(bad).toHaveCount(1);
		await expect(bad).toContainText("Problem: background service not loaded");
		await expect(bad.locator(".diag-fix")).toHaveText(
			"Fix: run pulsar mesh on",
		);
		await expect(bad.locator(".diag-fix code")).toHaveText("pulsar mesh on");
		await expect(mbp.locator(".diag-facts")).toContainText(
			"Event loopp99 240 ms, max 1900 ms, 3 stalls",
		);
		await expect(mbp.locator(".diag-facts")).toContainText("piVersion unknown");

		// No report: asleep, or too old to answer.
		await expect(v.locator('[data-machine="mbp-b"] .diag-error')).toContainText(
			"asleep 14m",
		);
		await expect(v.locator('[data-machine="desk"] .diag-error')).toContainText(
			"upgrade pulsar on desk to see its checks",
		);
		await expect(v.locator('[data-machine="desk"] .diag-health')).toHaveText(
			"No report",
		);
		expect(await contrastFailures(page, ".diag *")).toEqual([]);
	});

	test(`no Check again button: it says when it last checked (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		const v = view(page, phone);
		await expect(v.locator(".diag-machine")).toHaveCount(4);
		await expect(page.getByTestId("diag-checked")).toHaveText(
			/^Checked (now|\d+s ago)$/,
		);
		await expect(
			page.getByRole("button", { name: /check again/i }),
		).toHaveCount(0);
	});

	test(`Settings opens Diagnostics (${platform})`, async ({ page }) => {
		await ready(page);
		if (phone) {
			await page.evaluate(() => {
				location.hash = "#/settings";
			});
			const row = page.locator('[data-setting="diagnostics"]');
			await expect(row).toContainText("Check Every Machine");
			await row.tap();
		} else {
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			await page
				.getByRole("navigation", { name: "Settings sections" })
				.getByRole("button", { name: "Diagnostics" })
				.click();
			const section = page.locator(
				'section[aria-labelledby="set-x-diagnostics"]',
			);
			await expect(section).toContainText("Check every machine");
			await section.getByRole("button", { name: "Open diagnostics" }).click();
		}
		await expect(page).toHaveURL(/#\/diagnostics$/);
		await expect(view(page, phone).locator(".diag-machine")).toHaveCount(4);
	});
}
