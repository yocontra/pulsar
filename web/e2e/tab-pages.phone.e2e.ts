/**
 * The Needs You and Settings tabs, the Diagnostics page and the status
 * screens on Konsta (mobile/NeedsPage.tsx, SettingsPage.tsx, StatusScreens.tsx,
 * features/diagnostics/PhonePage.tsx), on iOS (WebKit) and Android
 * (Chromium, Material).
 */
import { expect, ready, test } from "./fixtures.ts";

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
				const where = `${width} px, ${font} px text, row ${i}`;
				// All in one go: the list is live, and a needs item that lands
				// between two reads moves every row down by one (a row's height
				// apart, in a run under load).
				const m = await rows.nth(i).evaluate((row) => {
					const box = (sel: string) =>
						row.querySelector(sel)!.getBoundingClientRect();
					// The y of an element's first text baseline (as ui-audit's
					// baselineY): a zero-size inline-block in front of the text.
					const baseline = (sel: string) => {
						const el = row.querySelector(sel)!;
						const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
							acceptNode: (n) =>
								n.textContent?.trim()
									? NodeFilter.FILTER_ACCEPT
									: NodeFilter.FILTER_SKIP,
						});
						const text = walk.nextNode()!;
						const wrap = document.createElement("span");
						const probe = document.createElement("span");
						probe.style.cssText =
							"display:inline-block;width:0;height:0;vertical-align:baseline";
						text.parentNode!.insertBefore(wrap, text);
						wrap.append(probe, text);
						const y = probe.getBoundingClientRect().top;
						wrap.replaceWith(text);
						return y;
					};
					const t = box(".p-trail .p-quiet");
					const c = box(".p-attn-wrap > svg");
					const line = box(".p-line1");
					return {
						baselines: Math.abs(
							baseline(".p-trail .p-quiet") - baseline(".p-title"),
						),
						timeEnd: t.right,
						timeHeight: t.height,
						chevronX: c.left,
						chevronMid: c.top + c.height / 2,
						lineMid: line.top + line.height / 2,
						lineHeight: line.height,
					};
				});
				// Same line and baseline as the agent's name.
				expect(m.baselines, where).toBeLessThanOrEqual(1);
				// Right-aligned, ending before the chevron, on one line.
				expect(m.timeEnd, where).toBeLessThanOrEqual(m.chevronX);
				expect(m.chevronX - m.timeEnd, where).toBeLessThan(24);
				expect(m.timeHeight, where).toBeLessThan(m.lineHeight + 1);
				// The chevron sits on that line, not centred on the row.
				expect(Math.abs(m.chevronMid - m.lineMid), where).toBeLessThanOrEqual(
					2,
				);
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

	test("Settings: an off switch shows 3:1 against its row, light and dark", async ({
		page,
	}, info) => {
		const material = info.project.name === "android";
		await ready(page);
		await page.getByTestId("tab-settings").tap();
		const row = page
			.getByTestId("settings")
			.locator('[data-setting="show-finished-subagents"]');
		await expect(
			row.getByRole("checkbox", { name: "Show Finished Subagents" }),
		).not.toBeChecked();
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const ratio = await row.evaluate((el, material) => {
				const cv = document.createElement("canvas");
				cv.width = cv.height = 1;
				const cx = cv.getContext("2d")!;
				// A CSS color as 0-255 RGBA (the canvas resolves any syntax).
				const rgba = (c: string) => {
					cx.clearRect(0, 0, 1, 1);
					cx.fillStyle = c;
					cx.fillRect(0, 0, 1, 1);
					return [...cx.getImageData(0, 0, 1, 1).data];
				};
				const over = (top: number[], under: number[]) => {
					const a = top[3]! / 255;
					return [0, 1, 2].map((i) => top[i]! * a + under[i]! * (1 - a));
				};
				// What the switch sits on: every background up to the page.
				const behind = (from: Element | null): number[] => {
					const layers: number[][] = [];
					for (let n = from; n; n = n.parentElement) {
						const c = rgba(getComputedStyle(n).backgroundColor);
						if (c[3]! > 0) layers.push(c);
						if (c[3] === 255) break;
					}
					let out = [255, 255, 255];
					for (const l of layers.reverse()) out = over(l, out);
					return out;
				};
				const lum = (c: number[]) => {
					const [r, g, b] = c.map((v) => {
						const x = v / 255;
						return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
					});
					return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
				};
				const toggle = el.querySelector(".k-toggle")!;
				const surface = behind(toggle.parentElement);
				// iOS: the off track (Konsta's second span). Material: the outline.
				const edge = material
					? rgba(getComputedStyle(toggle).borderTopColor)
					: rgba(
							getComputedStyle(toggle.querySelectorAll(":scope > span")[1]!)
								.backgroundColor,
						);
				const a = lum(over(edge, surface));
				const b = lum(surface);
				return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
			}, material);
			expect(
				ratio,
				`${scheme}: off switch against its row`,
			).toBeGreaterThanOrEqual(3);
		}
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
	}) => {
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.goto("/");
		const f = page.locator("[data-failure=offline]");
		// No visit before: no machine name yet.
		await expect(f.getByRole("alert")).toContainText(
			"Can't Reach Your Machines",
		);
		await expect(f.getByRole("alert")).toContainText(
			"Check that the Tailscale app is on, then try again.",
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
