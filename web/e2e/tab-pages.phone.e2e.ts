/**
 * The Needs You and Settings tabs, the Diagnostics page and the status
 * screens on Konsta (mobile/NeedsPage.tsx, SettingsPage.tsx, StatusScreens.tsx,
 * features/diagnostics/PhonePage.tsx), on iOS (WebKit) and Android
 * (Chromium, Material).
 */
import { expect, ready, test } from "./fixtures.ts";
import { baselineY, midY } from "./ui-audit.ts";

/** Chromium logs each request the test aborts on purpose. */
function dropNetErrors(errors: string[]) {
	for (let i = errors.length - 1; i >= 0; i--)
		if (/^Failed to load resource: net::/.test(errors[i] ?? ""))
			errors.splice(i, 1);
}

const top = (page: import("@playwright/test").Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();

test.describe("tab pages", () => {
	test("Needs You: groups as inset lists; a row opens the approval", async ({
		page,
	}) => {
		// An approval opens on its agent's page (or its own sheet, sessionless).
		await ready(page);
		await page.getByTestId("tab-needs").tap();
		const needs = page.getByTestId("needs");
		const approvals = needs.getByRole("region", { name: "Approvals" });
		await expect(approvals.locator(".k-list")).toBeVisible();
		const row = approvals.locator(".p-attn").first();
		await expect(row).toHaveAttribute("data-agent", /.+/);
		// The row is a button; its text is Home's needs row.
		await expect(row.getByRole("button")).toBeVisible();
		await expect(row.locator(".p-row.is-needs .p-title")).not.toBeEmpty();
		const id = await row.getAttribute("data-agent");
		await row.getByRole("button").tap();
		await expect(page).toHaveURL(
			new RegExp(`#/(a|approval)/${encodeURIComponent(id!)}$`),
		);
	});

	test("Needs You: the time ends the name's line, the chevron after it", async ({
		page,
	}) => {
		for (const [width, font] of [
			[320, 17],
			[375, 17],
			[430, 17],
			[320, 23],
			[430, 23],
		] as const) {
			await page.setViewportSize({ width, height: 800 });
			await page.goto("/#/needs");
			await page.evaluate(
				(px) =>
					document.documentElement.style.setProperty("font-size", `${px}px`),
				font,
			);
			const rows = page.getByTestId("needs").locator(".p-attn");
			await expect(rows.first()).toBeVisible();
			for (const i of [0, 1, 2]) {
				const row = rows.nth(i);
				const title = row.locator(".p-title");
				const time = row.locator(".p-trail .p-quiet");
				const chevron = row.locator(".p-attn-wrap > svg");
				const where = `${width} px, ${font} px text, row ${i}`;
				// Same line and baseline as the agent's name.
				expect(
					Math.abs((await baselineY(time)) - (await baselineY(title))),
					where,
				).toBeLessThanOrEqual(1);
				// Right-aligned, ending before the chevron, on one line.
				const t = (await time.boundingBox())!;
				const c = (await chevron.boundingBox())!;
				const line = (await row.locator(".p-line1").boundingBox())!;
				expect(t.x + t.width, where).toBeLessThanOrEqual(c.x);
				expect(c.x - (t.x + t.width), where).toBeLessThan(24);
				expect(t.height, where).toBeLessThan(line.height + 1);
				// The chevron sits on that line, not centred on the row.
				expect(
					Math.abs((await midY(chevron)) - (line.y + line.height / 2)),
					where,
				).toBeLessThanOrEqual(2);
			}
		}
	});

	test("Needs You: nothing waiting", async ({ page, errors }) => {
		await page.route("**/api/v1/attention**", (r) =>
			r.fulfill({ json: { items: [], total: 0 } }),
		);
		await page.route("**/api/v1/events**", (r) => r.abort());
		await page.goto("/#/needs");
		const empty = page.getByTestId("needs-empty");
		await expect(empty.getByRole("heading")).toHaveText("Nothing needs you.");
		await expect(page.getByTestId("needs").locator(".p-attn")).toHaveCount(0);
		await expect(page.getByTestId("tab-needs")).toHaveAttribute(
			"aria-label",
			"Needs You",
		);
		dropNetErrors(errors);
	});

	test("Settings: every group, Konsta rows and switches, under the CSP", async ({
		page,
	}, info) => {
		await ready(page);
		await page.getByTestId("tab-settings").tap();
		const s = page.getByTestId("settings");
		for (const name of [
			"Prove Human",
			"Appearance",
			"Subagents",
			"Signed-In Browsers",
			"Machines",
			"Agent activity",
			"Usage limits",
			"Diagnostics",
			"About",
		])
			await expect(s.getByRole("region", { name })).toBeVisible();
		await expect(s.getByRole("region", { name: "Appearance" })).toContainText(
			info.project.name === "android" ? "your phone's" : "your iPhone's",
		);
		// A switch row: the row's text names the checkbox; a tap on the row
		// flips it, and the setting stays on this device.
		const sub = s.getByRole("checkbox", { name: "Show Finished Subagents" });
		await expect(sub).not.toBeChecked();
		await s.locator('[data-setting="show-finished-subagents"]').tap();
		await expect(sub).toBeChecked();
		await page.reload();
		await expect(
			page
				.getByTestId("settings")
				.getByRole("checkbox", { name: "Show Finished Subagents" }),
		).toBeChecked();
		// No CSP report from Konsta's rows and switches: the errors fixture.
	});

	test("Diagnostics: pushed from Settings with a back button", async ({
		page,
	}) => {
		await ready(page);
		await page.getByTestId("tab-settings").tap();
		await page.locator('[data-setting="diagnostics"]').tap();
		await expect(page).toHaveURL(/#\/diagnostics$/);
		const d = top(page);
		await expect(d.getByTestId("diagnostics")).toBeVisible();
		await expect(d.locator("ion-title").first()).toHaveText("Diagnostics");
		await expect(d.locator(".diag-machine").first()).toBeVisible();
		// A pushed page covers the tab bar.
		await expect(page.getByTestId("tabbar")).not.toBeInViewport();
		await d.locator(".p-back").first().tap();
		await expect(page).toHaveURL(/#\/settings$/);
	});

	test("status screens: offline and the first run", async ({
		page,
		errors,
	}, info) => {
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.goto("/");
		const f = page.locator("[data-failure=offline]");
		await expect(f.getByRole("alert")).toContainText(
			info.project.name === "android"
				? "This phone can't reach"
				: "This iPhone can't reach",
		);
		await expect(f.getByRole("button", { name: "Try Again" })).toBeVisible();
		await page.unroute("**/api/v1/**");
		await page.route("**/api/v1/hello**", async (r) => {
			const res = await r.fetch();
			await r.fulfill({ json: { ...(await res.json()), firstRun: true } });
		});
		await page.goto("/");
		const steps = page.getByRole("region", { name: "Get Started" });
		await expect(steps.locator(".k-list-item")).toHaveCount(3);
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(
			"Welcome to Pulsar",
		);
		dropNetErrors(errors);
	});
});
