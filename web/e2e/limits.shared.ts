import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";
import { contrastFailures } from "./ui-audit.ts";

/**
 * Plan usage limits in the app (web/src/features/limits): the Usage page's
 * Limits section, the session header note past a threshold, the in-app
 * warning toast, and Settings → "Usage limits" (kept on the node with
 * `PUT /usage/limits`). Shared by limits.desktop.e2e.ts and limits.phone.e2e.ts.
 */

const DAY = 86_400_000;

async function post(request: APIRequestContext, path: string, body: object) {
	const res = await request.post(`/api/v1/__mock/${path}`, {
		headers: { "X-Pulsar": "1" },
		data: body,
	});
	expect(res.ok()).toBe(true);
}

const reading = (o: {
	machine: string;
	harness: string;
	window: string;
	label: string;
	used: number;
}) => ({
	machine: o.machine,
	harness: o.harness,
	account: o.harness === "codex" ? "codex" : "",
	window: o.window,
	label: o.label,
	usedPercent: o.used,
	reached: o.used >= 100,
	resetsAt: Date.now() + 2 * DAY,
	at: Date.now() - 60_000,
	plan: null,
});

const HIGH = [
	reading({
		machine: "studio",
		harness: "codex",
		window: "m10080",
		label: "Weekly",
		used: 88,
	}),
	reading({
		machine: "mbp-a",
		harness: "claude",
		window: "seven_day",
		label: "Weekly",
		used: 100,
	}),
];

/** The visible page: the phone's top Ionic page, or the desktop's main area. */
const view = (page: Page, phone: boolean) =>
	phone
		? page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last()
		: page.getByRole("main", { name: "Usage" });

async function openUsage(page: Page) {
	await page.evaluate(() => {
		location.hash = "#/usage";
	});
}

async function openSettings(page: Page, phone: boolean) {
	if (phone) {
		await page.evaluate(() => {
			location.hash = "#/settings";
		});
		const group = page.getByRole("region", { name: "Usage limits" });
		await expect(group).toBeVisible();
		return group;
	}
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page
		.getByRole("navigation", { name: "Settings sections" })
		.getByRole("button", { name: "Usage limits" })
		.click();
	const section = page.locator('section[aria-labelledby="set-x-usage-limits"]');
	await expect(section).toBeVisible();
	return section;
}

export function limitsSuite(platform: "desktop" | "phone") {
	const phone = platform === "phone";
	const tap = async (el: ReturnType<Page["locator"]>) =>
		phone ? el.tap() : el.click();

	test.afterEach(async ({ request }) => {
		await post(request, "usage", { reset: true });
	});

	test(`the Usage page lists each limit with its use and reset (${platform})`, async ({
		page,
		request,
	}) => {
		await ready(page);
		await openUsage(page);
		const u = view(page, phone);
		const rows = u.getByTestId("limit-row");
		// Default: Codex's weekly limit below the first threshold.
		await expect(rows).toHaveCount(1);
		await expect(rows.first()).toContainText("Codex · Weekly");
		await expect(rows.first()).toContainText("62% used");
		await expect(rows.first()).toHaveAttribute("data-level", "ok");
		await expect(rows.first()).toContainText(/Resets \w+/);

		await post(request, "usage", { limits: HIGH });
		await page.reload();
		await expect(rows).toHaveCount(2);
		const claude = rows.filter({ hasText: "Claude Code" });
		await expect(claude).toContainText("Limit reached");
		await expect(claude).toContainText(/Reached .+ · Resets /);
		await expect(claude).toContainText("on mbp-a");
		await expect(claude).toHaveAttribute("data-level", "reached");
		await expect(rows.filter({ hasText: "Codex" })).toHaveAttribute(
			"data-level",
			"near",
		);
		await expect(
			u.getByRole("meter", { name: "Codex weekly limit used" }),
		).toHaveAttribute("aria-valuenow", "88");
		await expect(u.locator(".limits-note")).toContainText(
			"pi and omp show here only when a limit is reached",
		);
		expect(await contrastFailures(page, ".limits *")).toEqual([]);
	});

	test(`Claude Code's cached /usage percentages and OpenCode Go's meters and stop show on Usage (${platform})`, async ({
		page,
		request,
	}) => {
		const now = Date.now();
		await post(request, "usage", {
			limits: [
				// Read from Claude Code's last /usage, a day ago.
				{
					...reading({
						machine: "studio",
						harness: "claude",
						window: "five_hour",
						label: "5-hour",
						used: 41,
					}),
					resetsAt: now + 3 * 3_600_000,
					at: now - DAY,
					plan: "Test Plan",
				},
				{
					...reading({
						machine: "studio",
						harness: "claude",
						window: "seven_day",
						label: "Weekly",
						used: 83,
					}),
					at: now - 5 * 60_000,
					plan: "Test Plan",
				},
				{
					...reading({
						machine: "studio",
						harness: "opencode",
						window: "rolling",
						label: "Rolling",
						used: 57,
					}),
					account: "opencode-go",
					plan: "Go",
				},
				{
					...reading({
						machine: "studio",
						harness: "opencode",
						window: "weekly",
						label: "Weekly",
						used: 100,
					}),
					account: "opencode-go",
				},
			],
		});
		await ready(page);
		await openUsage(page);
		const u = view(page, phone);
		const rows = u.getByTestId("limit-row");
		await expect(rows).toHaveCount(4);
		const rolling = rows.filter({ hasText: "OpenCode · Rolling" });
		await expect(rolling).toContainText("(Go)");
		await expect(rolling).toContainText("57% used");
		await expect(rolling).toHaveAttribute("data-level", "ok");
		const five = rows.filter({ hasText: "Claude Code · 5-hour" });
		await expect(five).toContainText("(Test Plan)");
		await expect(five).toContainText("41% used");
		await expect(five).toContainText(/As of \w+ .+ · Resets /);
		await expect(five).toHaveAttribute("data-level", "ok");
		const week = rows.filter({ hasText: "Claude Code · Weekly" });
		await expect(week).toContainText("83% used");
		await expect(week).not.toContainText("As of");
		await expect(week).toHaveAttribute("data-level", "near");
		await expect(
			u.getByRole("meter", { name: "Claude Code weekly limit used" }),
		).toHaveAttribute("aria-valuenow", "83");
		const go = rows.filter({ hasText: "OpenCode · Weekly" });
		await expect(go).toContainText("Limit reached");
		await expect(go).toContainText(/Reached .+ · Resets /);
		await expect(go).toHaveAttribute("data-level", "reached");
		expect(await contrastFailures(page, ".limits *")).toEqual([]);
		if (process.env.PULSAR_LIMIT_SHOTS)
			await u.locator(".limits").screenshot({
				path: `${process.env.PULSAR_LIMIT_SHOTS}/limits-${platform}.png`,
			});
	});

	test(`the session header notes a limit past a threshold and opens Usage (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const chip = page.getByTestId("limit-chip");
		// 62%: below 80%, nothing in the header.
		await expect(
			page.getByRole("button", { name: "More" }).first(),
		).toBeVisible();
		await page.waitForTimeout(300);
		await expect(chip).toHaveCount(0);

		await post(request, "usage", { limits: HIGH });
		await page.reload();
		await expect(chip).toBeVisible();
		await expect(chip).toHaveText(phone ? "88%" : "Weekly limit: 88%");
		await expect(chip).toHaveAttribute("title", /Codex · Weekly limit: 88%/);
		await tap(chip);
		await expect(page).toHaveURL(/#\/usage$/);
	});

	test(`a limit warning shows a toast that opens Usage (${platform})`, async ({
		page,
		request,
	}) => {
		await ready(page);
		await post(request, "realtime", {
			action: "limit",
			warning: {
				harness: "codex",
				label: "Weekly",
				level: 95,
				reached: false,
				usedPercent: 96,
				resetsAt: Date.now() + DAY,
			},
		});
		const card = page.locator("[data-sonner-toast]");
		await expect(card).toHaveCount(1);
		await expect(card).toContainText("Codex is at 96% of its weekly limit");
		await expect(card).toContainText(/Resets/);
		await tap(card.getByRole("button", { name: "Open usage" }));
		await expect(page).toHaveURL(/#\/usage$/);

		await post(request, "realtime", {
			action: "limit",
			warning: {
				harness: "claude",
				label: "Weekly",
				level: 100,
				reached: true,
				usedPercent: 100,
				resetsAt: null,
			},
		});
		await expect(
			card.filter({ hasText: "Claude Code hit its weekly limit" }),
		).toHaveCount(1);
	});

	test(`Settings: turn warnings off and change the thresholds (${platform})`, async ({
		page,
	}) => {
		await ready(page);
		const section = await openSettings(page, phone);
		const put = (match: (b: Record<string, unknown>) => boolean) =>
			page.waitForRequest(
				(r) =>
					r.url().endsWith("/api/v1/usage/limits") &&
					r.method() === "PUT" &&
					match(r.postDataJSON()),
			);
		// Phone: a Konsta switch row (a tap anywhere on it flips the switch).
		const toggle = phone
			? section.locator('[data-setting="usage-limits"]')
			: section.getByRole("switch", { name: "Usage limit warnings" });
		const state = phone
			? section.getByRole("checkbox", { name: "Usage Limit Warnings" })
			: toggle;
		await expect(state).toBeChecked();
		const off = put((b) => b.enabled === false);
		await tap(toggle);
		await off;
		await expect(state).not.toBeChecked();
		const on = put((b) => b.enabled === true);
		await tap(toggle);
		await on;
		await expect(state).toBeChecked();

		if (phone) {
			const row = section.locator('[data-setting="usage-limit-thresholds"]');
			await expect(row).toContainText("80%, 95%");
			const saved = put((b) => String(b.thresholds) === "70,90");
			await row.tap();
			await page
				.getByTestId("actions")
				.getByRole("button", { name: "70%, 90%" })
				.tap();
			await saved;
			await expect(row).toContainText("70%, 90%");
		} else {
			const input = section.getByRole("textbox", {
				name: "Warn at these percentages",
			});
			await expect(input).toHaveValue("80, 95");
			await input.fill("0, 120");
			await input.press("Enter");
			await expect(section.getByRole("alert")).toContainText(
				"Up to 3 values from 1 to 99",
			);
			const saved = put((b) => String(b.thresholds) === "70,90");
			await input.fill("90, 70");
			await input.press("Enter");
			await saved;
			await expect(section.getByRole("alert")).toHaveCount(0);
			await page.reload();
			const again = await openSettings(page, false);
			await expect(
				again.getByRole("textbox", { name: "Warn at these percentages" }),
			).toHaveValue("70, 90");
		}
	});
}
