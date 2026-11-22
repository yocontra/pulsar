/**
 * Phone UI invariants (WebKit, iPhone 13 mini, plus 390 and 430 px wide):
 * pointer cursors on everything clickable, every bar (composer dock,
 * segmented controls, broadcast dock, Ask bar) fully on screen and clear of
 * the safe areas in the installed app and in a Safari tab, keyboard hints
 * hidden on touch, the Appearance setting, and AA contrast in both themes
 * with a screenshot per screen.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";
import {
	baselineY,
	contrastFailures,
	expectBarInside,
	expectPointerCursors,
	flatButtons,
	midY,
	pageLuminance,
	settled,
} from "./ui-audit.ts";

/** The installed app's insets (status bar, home indicator), as on a device. */
async function insets(page: Page, sat: number, sab: number) {
	await page.addInitScript(
		([sat, sab]) => {
			const apply = () => {
				const r = document.documentElement?.style;
				if (!r) return;
				// macOS WebKit reports 13px for -apple-system-body; iPhones use 17px.
				r.setProperty("font-size", "17px");
				r.setProperty("--sat", `${sat}px`);
				r.setProperty("--sab", `${sab}px`);
			};
			apply();
			document.addEventListener("DOMContentLoaded", apply);
			try {
				localStorage.setItem("pulsar.installHint", "1");
			} catch {}
		},
		[sat, sab] as const,
	);
}

async function home(page: Page) {
	await page.goto("/");
	await page.locator('[data-node="m:studio"]').waitFor();
}

type Screen = [name: string, open: (page: Page, id: string) => Promise<void>];
const SCREENS: Screen[] = [
	["home", home],
	[
		"agent",
		async (page, id) => {
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.locator(".transcript .ev").first().waitFor();
		},
	],
	[
		"needs you",
		async (page) => {
			await page.goto("/#/needs");
			await page.locator("ion-item.p-attn").first().waitFor();
		},
	],
	[
		"settings",
		async (page) => {
			await page.goto("/#/settings");
			await page.getByRole("radiogroup", { name: "Appearance" }).waitFor();
		},
	],
	[
		"broadcast",
		async (page) => {
			await home(page);
			await page.getByRole("button", { name: "Broadcast…" }).tap();
			await page.getByTestId("match-count").waitFor();
		},
	],
];

test.describe("phone UI", () => {
	test("every clickable element shows the pointer cursor", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		for (const [name, open] of SCREENS) {
			await open(page, id);
			await page.waitForTimeout(500);
			await expectPointerCursors(page, name);
		}
	});

	for (const [w, h, sat, sab, mode] of [
		[375, 812, 50, 34, "installed"],
		[390, 844, 47, 34, "installed"],
		[430, 932, 59, 34, "installed"],
		[375, 629, 0, 0, "Safari tab"],
	] as const)
		test(`bars fit at ${w}×${h} (${mode})`, async ({ page, request }) => {
			await page.setViewportSize({ width: w, height: h });
			await insets(page, sat, sab);
			const ins = { top: sat, bottom: sab };
			const id = await agentId(request, "name=codex@apparish");

			await home(page);
			// No grouping switcher: the search field sits right above the list.
			await expect(page.locator("ion-segment")).toHaveCount(0);

			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.locator(".transcript .ev").first().waitFor();
			const dock = page.locator(".m-composer");
			await expectBarInside(dock, "agent composer", ins);
			// The field and its send button stay inside the dock's padding.
			const [d, field, send] = await Promise.all([
				dock.boundingBox(),
				dock.locator("textarea").boundingBox(),
				dock.getByRole("button", { name: "Send", exact: true }).boundingBox(),
			]);
			expect(field!.x + field!.width).toBeLessThanOrEqual(d!.x + d!.width - 9);
			expect(send!.x + send!.width).toBeLessThanOrEqual(
				field!.x + field!.width - 2,
			);

			await home(page);
			await page.getByRole("button", { name: "Broadcast…" }).tap();
			await page.getByTestId("match-count").waitFor();
			await page.waitForTimeout(600);
			const compose = page.locator(".bc-compose");
			await expectBarInside(compose, "broadcast dock", ins);
			await expectBarInside(
				compose.getByRole("radiogroup", { name: "Priority" }),
				"broadcast priority",
				ins,
			);
			// "Send to N" spans the dock, not one grid cell.
			const [c, sendAll] = await Promise.all([
				compose.boundingBox(),
				compose.getByRole("button", { name: /^Send to/ }).boundingBox(),
			]);
			expect(sendAll!.width).toBeGreaterThan(c!.width - 40);
		});

	test("agent rows and needs badges line up", async ({ page }) => {
		await home(page);
		// Each pair is measured until the list stops moving: rows that just
		// loaded can still shift between two measurements.
		const near = (gap: () => Promise<number>, max: number) =>
			expect.poll(gap).toBeLessThanOrEqual(max);
		// Needs rows: the icon centres on the row; the time shares the title's
		// baseline.
		const needs = page.locator(".p-row.is-needs").first();
		await needs.waitFor();
		await near(
			async () =>
				Math.abs((await midY(needs.locator(".p-lead"))) - (await midY(needs))),
			1,
		);
		await near(
			async () =>
				Math.abs(
					(await baselineY(needs.locator(".p-title"))) -
						(await baselineY(needs.locator(".p-trail .p-quiet"))),
				),
			1,
		);
		// The needs badge: bold, about as tall as the label's type size (18 pt
		// next to 17 pt), centred on the row's label.
		const group = page.locator('[data-tree-node="m:studio"] .p-row');
		const badge = group.locator(".ds-needs-badge");
		const box = (await badge.boundingBox())!;
		const size = await group
			.locator(".p-title")
			.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
		expect(box.height / size).toBeLessThanOrEqual(1.2);
		expect(box.height / size).toBeGreaterThanOrEqual(1);
		expect(
			Number(await badge.evaluate((el) => getComputedStyle(el).fontWeight)),
		).toBeGreaterThanOrEqual(600);
		await near(
			async () =>
				Math.abs((await midY(badge)) - (await midY(group.locator(".p-title")))),
			1.5,
		);
		// Agent rows: the 40 pt avatar centres on the row; the status shares
		// the name's baseline.
		await page.locator('[data-tree-node="m:studio/p:apparish"] ion-item').tap();
		const row = page.locator(".p-row.is-agent:has(.ds-status--plain)").first();
		await row.waitFor();
		await near(
			async () =>
				Math.abs((await midY(row.locator(".ds-avatar"))) - (await midY(row))),
			1,
		);
		await near(
			async () =>
				Math.abs(
					(await baselineY(row.locator(".p-title"))) -
						(await baselineY(row.locator(".ds-status-text"))),
				),
			1,
		);
	});

	for (const w of [375, 320])
		test(`a subagent's back button and title never overlap at ${w} px`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width: w, height: 700 });
			const auth = await agentId(request, "name=apparish-auth");
			// The mock's longest subagent name.
			const sub = `${auth}/sub:a1explore`;
			await page.goto(`/#/a/${encodeURIComponent(auth)}`);
			await expect(page.locator(".p-nav-title h1").last()).toHaveText(
				"apparish-auth",
			);
			await page.goto(`/#/s/${encodeURIComponent(sub)}`);
			const header = page.locator(".p-sub-header").last();
			const title = header.locator(".p-nav-title h1");
			await expect(title).toHaveText("Find other refresh callers");
			const back = header.locator("ion-button.p-back");
			await expect(back).toContainText(/\S/);
			await settled(page);
			const b = (await back.boundingBox())!;
			const t = (await title.boundingBox())!;
			// Side by side, never on top of each other, and inside the screen.
			expect(t.x).toBeGreaterThanOrEqual(b.x + b.width);
			expect(t.x + t.width).toBeLessThanOrEqual(w);
			// A name too long for the bar ends in an ellipsis.
			expect(
				await title.evaluate((el) => getComputedStyle(el).textOverflow),
			).toBe("ellipsis");
		});

	test("keyboard hints are hidden on touch", async ({ page }) => {
		await home(page);
		const display = await page.evaluate(() => {
			const k = document.createElement("kbd");
			k.className = "ds-kbd";
			k.textContent = "⌘K";
			document.body.append(k);
			return getComputedStyle(k).display;
		});
		expect(display).toBe("none");
	});

	test("a page chunk that fails to prefetch neither reloads nor errors", async ({
		page,
	}) => {
		// The background prefetch of one page fails (a network blip).
		await page.route(/\/_app\/IdsPage\.[^/]+\.js$/, (r) => r.abort());
		let navigations = 0;
		page.on("framenavigated", (f) => {
			if (f === page.mainFrame()) navigations++;
		});
		await page.goto("/");
		await expect(page.locator("#app [data-node]").first()).toBeVisible();
		// The other pages prefetched: the failed one has been tried by now.
		await page.waitForFunction(
			() =>
				performance
					.getEntriesByType("resource")
					.some((e) => e.name.includes("/_app/AskPage.")),
			undefined,
			{ timeout: 10_000 },
		);
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
		// No boot-guard reload, no error screen (the errors fixture checks the console).
		expect(navigations).toBe(1);
		await expect(page.locator("#boot-error")).toBeHidden();
	});

	test("Appearance: System, Light or Dark, saved on this device", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.goto("/#/settings");
		const group = page.getByRole("radiogroup", { name: "Appearance" });
		await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await group.getByRole("radio", { name: "Dark" }).tap();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		expect(await pageLuminance(page)).toBeLessThan(0.05);
		await expect(
			page.locator('meta[name="theme-color"]').first(),
		).toHaveAttribute("content", "#0b0b0a");
		await settled(page);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
		await expect(group.getByRole("radio", { name: "Dark" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		// The forced theme beats the system one in the phone's own palettes too.
		await page.emulateMedia({ colorScheme: "light" });
		const bar = await page
			.locator(".p-settings")
			.evaluate(() =>
				getComputedStyle(document.documentElement)
					.getPropertyValue("--m-bg")
					.trim(),
			);
		expect(bar).toBe("#000");
		await group.getByRole("radio", { name: "System" }).tap();
		await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
		expect(await pageLuminance(page)).toBeGreaterThan(0.8);
	});

	for (const scheme of ["light", "dark"] as const)
		test(`AA contrast and a screenshot per screen, ${scheme}`, async ({
			page,
			request,
			errors,
		}, info) => {
			await page.emulateMedia({ colorScheme: scheme });
			await insets(page, 50, 34);
			const id = await agentId(request, "name=codex@apparish");
			const approver = await agentId(request, "name=apparish-auth");
			const screens: Screen[] = [
				...SCREENS,
				[
					"prove human",
					async (page) => {
						await home(page);
						await page.getByTestId("tab-settings").tap();
						await page.getByRole("button", { name: /^Prove Human/ }).tap();
						await page.getByRole("dialog", { name: "Prove Human" }).waitFor();
					},
				],
				[
					"approval",
					async (page) => {
						await home(page);
						await page.goto(`/#/approval/${encodeURIComponent(approver)}`);
						await page.locator(".prompt-inline .approval-card").waitFor();
					},
				],
			];
			for (const [name, open] of screens) {
				await open(page, id);
				await page.waitForTimeout(700);
				const lum = await pageLuminance(page);
				if (scheme === "dark") expect(lum, name).toBeLessThan(0.05);
				else expect(lum, name).toBeGreaterThan(0.8);
				expect(
					await contrastFailures(page, "body *"),
					`${name} contrast`,
				).toEqual([]);
				expect(await flatButtons(page), `${name} button fills`).toEqual([]);
				// WebKit screenshots inject Playwright's own stylesheet, which the
				// app's CSP refuses: drop exactly those reports, made during the shot.
				const before = errors.length;
				const body = await page.screenshot({ caret: "initial" });
				const during = errors.splice(before);
				errors.push(
					...during.filter((e) => !/^Refused to apply a stylesheet/.test(e)),
				);
				await info.attach(`${name}-${scheme}`, {
					body,
					contentType: "image/png",
				});
			}
		});
});
