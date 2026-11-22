/**
 * Desktop UI invariants (Chromium): pointer cursors on everything
 * clickable, tab bars and segmented controls fully on screen at 1440, 1280
 * and 1024 px, one polished chip per keyboard shortcut, the Appearance
 * setting (System / Light / Dark, before first paint), and AA text contrast
 * on rendered screens in both themes, with a screenshot per screen.
 */
import type { Page } from "@playwright/test";
import {
	agentId,
	expect,
	localhostBase,
	ready,
	test,
	withPasskey,
} from "./fixtures.ts";
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

type Screen = [name: string, open: (page: Page, id: string) => Promise<void>];

const SCREENS: Screen[] = [
	["home", async (page) => ready(page)],
	[
		"session",
		async (page, id) => {
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.locator(".transcript .ev").first().waitFor();
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
		"palette",
		async (page) => {
			await ready(page);
			await page.keyboard.press("ControlOrMeta+k");
			await page.getByRole("dialog").first().waitFor();
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
		"broadcast",
		async (page) => {
			await ready(page);
			await page.keyboard.press("ControlOrMeta+Shift+b");
			await page.getByTestId("match-count").waitFor();
		},
	],
	[
		"shortcuts",
		async (page) => {
			await ready(page);
			await page.keyboard.press("?");
			await page.getByRole("dialog", { name: "Keyboard shortcuts" }).waitFor();
		},
	],
	[
		"prove human",
		async (page) => {
			await ready(page);
			await page.getByRole("button", { name: /^Prove Human/ }).click();
			await page.getByRole("dialog", { name: "Prove Human" }).waitFor();
		},
	],
	[
		"context menu",
		async (page) => {
			await ready(page);
			await page.locator('[data-node="m:studio"]').click({ button: "right" });
			await page.getByRole("menu").first().waitFor();
		},
	],
];

test.describe("desktop UI", () => {
	test("every clickable element shows the pointer cursor", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		for (const [name, open] of SCREENS) {
			await open(page, id);
			await page.waitForTimeout(300);
			await expectPointerCursors(page, name);
		}
	});

	test("disabled controls show not-allowed", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const send = page.getByRole("button", { name: "Send" });
		await expect(send).toBeDisabled();
		expect(await send.evaluate((e) => getComputedStyle(e).cursor)).toBe(
			"not-allowed",
		);
	});

	for (const [w, h] of [
		[1440, 900],
		[1280, 800],
		[1024, 700],
	] as const)
		test(`tab bars and the composer fit at ${w}×${h}`, async ({
			page,
			request,
		}) => {
			await page.setViewportSize({ width: w, height: h });
			const id = await agentId(request, "name=apparish-auth");
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.locator(".transcript .ev").first().waitFor();
			await expectBarInside(
				page.getByRole("radiogroup", { name: "Priority" }),
				"composer priority",
			);
			await expectBarInside(page.locator(".d-main .composer"), "composer");
			await page.keyboard.press("ControlOrMeta+k");
			await expectBarInside(
				page.getByRole("radiogroup", { name: "Mode" }),
				"palette Search/Ask",
			);
			await expectBarInside(page.locator(".d-pal-foot"), "palette footer");
			await page.keyboard.press("Escape");
			await page.getByRole("button", { name: "Settings" }).first().click();
			await expectBarInside(
				page.getByRole("navigation", { name: "Settings sections" }),
				"settings sections",
			);
			await expectBarInside(
				page.getByRole("radiogroup", { name: "Appearance" }),
				"appearance",
			);
		});

	test("settings: every card's rows share one inset; a clicked section stays current", async ({
		page,
		request,
		context,
	}) => {
		// A passkey, so the Proven devices card has rows (WebAuthn needs a host name).
		await page.goto(localhostBase());
		await withPasskey(page, request, context);
		await page.reload();
		await page.getByRole("button", { name: "Settings" }).first().click();
		const keys = page.locator('section[aria-labelledby="set-keys"] .d-set-row');
		await expect(keys.first()).toBeVisible();
		// Each row's first child, measured from its card's left edge.
		const insets = await page
			.locator(".d-settings .d-set-card > .d-set-row")
			.evaluateAll((rows) =>
				rows.map((r) => {
					const card = r.parentElement!.getBoundingClientRect();
					const first = r.firstElementChild!.getBoundingClientRect();
					return Math.round(first.left - card.left);
				}),
			);
		expect(insets.length).toBeGreaterThan(4);
		expect(new Set(insets)).toEqual(new Set([insets[0]]));
		// A section near the bottom can't scroll to the top: it stays current.
		const nav = page.getByRole("navigation", { name: "Settings sections" });
		await nav.getByRole("button", { name: "Machines" }).click();
		await page.mouse.move(0, 0);
		await expect(nav.locator('[aria-current="true"]')).toHaveText("Machines");
		// Once the smooth scroll has arrived (Machines at the top, or the
		// bottom when it can't get there), still Machines.
		const box = page.locator(".d-set-scroll");
		await expect
			.poll(() =>
				box.evaluate((el) => {
					const h = document.getElementById("set-machines")!;
					const off =
						h.getBoundingClientRect().top - el.getBoundingClientRect().top;
					return (
						off < 80 || el.scrollHeight - el.clientHeight - el.scrollTop <= 2
					);
				}),
			)
			.toBe(true);
		await expect(nav.locator('[aria-current="true"]')).toHaveText("Machines");
	});

	test("agent rows, needs badges and the header pill line up", async ({
		page,
		request,
	}) => {
		await ready(page);
		// Each pair is measured until the tree stops moving: rows that just
		// loaded can re-render between two measurements.
		const near = (gap: () => Promise<number>, max: number) =>
			expect.poll(gap).toBeLessThanOrEqual(max);
		await page.locator('[data-node="m:studio/p:apparish"] .chev').click();
		// Tree agent row: the avatar spans both lines and centres on the row;
		// the status shares the name's baseline.
		const row = page.locator(".d-row.agent:has(.ds-status--plain)").first();
		await row.waitFor();
		const av = row.locator(".ds-avatar");
		await expect
			.poll(async () => (await av.boundingBox())?.height ?? 0)
			.toBeGreaterThanOrEqual(30);
		await near(async () => Math.abs((await midY(av)) - (await midY(row))), 1);
		const name = row.locator(".d-name");
		await near(
			async () =>
				Math.abs(
					(await baselineY(name)) -
						(await baselineY(row.locator(".ds-status-text"))),
				),
			1,
		);
		// Needs-you sidebar rows: same avatar, time on the name's baseline.
		const attn = page.locator(".d-row.attn").first();
		await near(
			async () =>
				Math.abs((await midY(attn.locator(".ds-avatar"))) - (await midY(attn))),
			1,
		);
		await near(
			async () =>
				Math.abs(
					(await baselineY(attn.locator(".d-name"))) -
						(await baselineY(attn.locator(".d-trail"))),
				),
			1,
		);
		// Needs badges: small, bold, centred on their label.
		for (const [badge, label] of [
			[".d-section .ds-needs-badge", ".d-section > span:first-child"],
			[
				'[data-node="m:studio"] .ds-needs-badge',
				'[data-node="m:studio"] .d-name',
			],
		] as const) {
			const b = page.locator(badge).first();
			const box = (await b.boundingBox())!;
			expect(box.height, badge).toBeLessThanOrEqual(18);
			expect(box.height, badge).toBeGreaterThanOrEqual(14);
			expect(
				Number(await b.evaluate((el) => getComputedStyle(el).fontWeight)),
			).toBeGreaterThanOrEqual(600);
			await expect
				.poll(
					async () =>
						Math.abs(
							(await midY(b)) - (await midY(page.locator(label).first())),
						),
					{ message: badge },
				)
				.toBeLessThanOrEqual(1.5);
		}
		// Home card: the avatar centres on the row, the trail sits on the
		// title's baseline.
		const card = page.locator(".d-card-row:not(.attn)").first();
		const pad = await card.evaluate((el) => {
			const s = getComputedStyle(el);
			return parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
		});
		await near(
			async () =>
				Math.abs(
					(await midY(card.locator(".ds-avatar"))) -
						((await midY(card)) + pad / 2),
				),
			1,
		);
		await near(
			async () =>
				Math.abs(
					(await baselineY(card.locator(".d-card-title"))) -
						(await baselineY(card.locator(".d-card-meta"))),
				),
			1,
		);
		// Session header: the status pill's words share the title's baseline.
		const id = await agentId(request, "name=apparish-auth");
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const head = page.locator(".d-sh-line1");
		await head.locator(".ds-status").waitFor();
		await near(
			async () =>
				Math.abs(
					(await baselineY(head.locator("h1"))) -
						(await baselineY(head.locator(".ds-status-text"))),
				),
			1,
		);
	});

	test("one chip per shortcut, aligned with its label", async ({ page }) => {
		await ready(page);
		const broadcast = page.locator(".d-nav-item", { hasText: "Broadcast" });
		const chip = broadcast.locator(".ds-kbd");
		await expect(chip).toHaveCount(1);
		await expect(chip.locator(".ds-key")).toHaveCount(3);
		const mac = await page.evaluate(() =>
			/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
		);
		await expect(chip).toHaveText(mac ? "⌘⇧B" : "Ctrl+Shift+B");
		// Decorative next to a labelled control: the name stays "Broadcast".
		await expect(chip).toHaveAttribute("aria-hidden", "true");
		const [k, label] = await Promise.all([
			chip.boundingBox(),
			broadcast.locator("svg").first().boundingBox(),
		]);
		const mid = (b: { y: number; height: number }) => b.y + b.height / 2;
		expect(Math.abs(mid(k!) - mid(label!))).toBeLessThanOrEqual(2);
		expect(k!.height).toBe(20);
		// The shortcuts list speaks each combo.
		await page.keyboard.press("?");
		const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await expect(help.locator(".ds-kbd").first()).not.toHaveAttribute(
			"aria-hidden",
			"true",
		);
		await expect(help.locator(".ds-kbd .sr-only").first()).toHaveText(
			mac ? "Command K" : "Control K",
		);
	});

	test("Appearance follows the system, persists a choice, and applies before first paint", async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: "light" });
		await ready(page);
		const html = page.locator("html");
		await expect(html).not.toHaveAttribute("data-theme", /.*/);
		expect(await pageLuminance(page)).toBeGreaterThan(0.8);

		await page.getByRole("button", { name: "Settings" }).first().click();
		const group = page.getByRole("radiogroup", { name: "Appearance" });
		await expect(group.getByRole("radio", { name: "System" })).toHaveAttribute(
			"aria-checked",
			"true",
		);
		await group.getByRole("radio", { name: "Dark" }).click();
		await expect(html).toHaveAttribute("data-theme", "dark");
		expect(await pageLuminance(page)).toBeLessThan(0.05);
		await expect(
			page.locator('meta[name="theme-color"]').first(),
		).toHaveAttribute("content", "#000000");

		// Before first paint: hold the app's scripts and look at the boot shell.
		let release = () => {};
		const held = new Promise<void>((r) => {
			release = r;
		});
		await page.route("**/_app/*.js", async (route) => {
			await held;
			await route.continue();
		});
		await page.goto("/", { waitUntil: "commit" });
		await page.locator(".boot-shell").waitFor();
		await expect(html).toHaveAttribute("data-theme", "dark");
		expect(await pageLuminance(page)).toBeLessThan(0.05);
		release();
		await page.locator('[data-node="m:studio"]').waitFor();

		await page.getByRole("button", { name: "Settings" }).first().click();
		await group.getByRole("radio", { name: "System" }).click();
		await expect(html).not.toHaveAttribute("data-theme", /.*/);
		await page.emulateMedia({ colorScheme: "dark" });
		expect(await pageLuminance(page)).toBeLessThan(0.05);
		await group.getByRole("radio", { name: "Light" }).click();
		expect(await pageLuminance(page)).toBeGreaterThan(0.8);
	});

	test("the app still works when storage throws", async ({ page }) => {
		await page.addInitScript(() => {
			const fail = () => {
				throw new DOMException("blocked", "SecurityError");
			};
			Object.defineProperty(window, "localStorage", { get: fail });
		});
		await ready(page);
		await page.getByRole("button", { name: "Settings" }).first().click();
		await page
			.getByRole("radiogroup", { name: "Appearance" })
			.getByRole("radio", { name: "Dark" })
			.click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
	});

	for (const scheme of ["light", "dark"] as const)
		test(`AA contrast and a screenshot per screen, ${scheme}`, async ({
			page,
			request,
		}, info) => {
			await page.emulateMedia({ colorScheme: scheme });
			const id = await agentId(request, "name=apparish-auth");
			for (const [name, open] of SCREENS) {
				await open(page, id);
				await page.waitForTimeout(400);
				const lum = await pageLuminance(page);
				if (scheme === "dark") expect(lum, name).toBeLessThan(0.05);
				else expect(lum, name).toBeGreaterThan(0.8);
				expect(
					await contrastFailures(page, "body *"),
					`${name} contrast`,
				).toEqual([]);
				expect(await flatButtons(page), `${name} button fills`).toEqual([]);
				await info.attach(`${name}-${scheme}`, {
					// caret "initial": hiding the caret injects a stylesheet the CSP refuses in WebKit.
					body: await page.screenshot({ caret: "initial" }),
					contentType: "image/png",
				});
			}
		});

	test.describe("resizable sidebar", () => {
		const side = (page: Page) =>
			page
				.locator("aside.d-side")
				.first()
				.evaluate((e) => Math.round(e.getBoundingClientRect().width));
		const handle = (page: Page) =>
			page.getByRole("separator", { name: "Resize sidebar" });

		test("drag within bounds, keys, reset, and the col-resize cursor", async ({
			page,
		}) => {
			await ready(page);
			expect(await side(page)).toBe(296);
			const h = handle(page);
			expect(await h.evaluate((e) => getComputedStyle(e).cursor)).toBe(
				"col-resize",
			);
			const y = 450;
			const dragTo = async (dx: number) => {
				const b = (await h.boundingBox())!;
				const sx = b.x + b.width / 2;
				await page.mouse.move(sx, y);
				await page.mouse.down();
				await page.mouse.move(sx + dx / 2, y, { steps: 4 });
				// No text selection while dragging.
				expect(
					await page.evaluate(() => getComputedStyle(document.body).userSelect),
				).toBe("none");
				await page.mouse.move(sx + dx, y, { steps: 4 });
				await page.mouse.up();
			};
			await dragTo(100);
			expect(await side(page)).toBe(396);
			await dragTo(1000);
			expect(await side(page)).toBe(480); // max: 480 px (40 % of 1440 is 576)
			await dragTo(-1000);
			expect(await side(page)).toBe(220); // min
			expect(
				await page.evaluate(() => getComputedStyle(document.body).userSelect),
			).not.toBe("none");

			await h.focus();
			await page.keyboard.press("ArrowRight");
			expect(await side(page)).toBe(236);
			await expect(h).toHaveAttribute("aria-valuenow", "236");
			await page.keyboard.press("End");
			expect(await side(page)).toBe(480);
			await page.keyboard.press("ArrowLeft");
			expect(await side(page)).toBe(464);
			await page.keyboard.press("Home");
			expect(await side(page)).toBe(220);

			await h.dblclick();
			expect(await side(page)).toBe(296);
		});

		test("the width persists per device and applies with no layout shift", async ({
			page,
		}) => {
			// Record the sidebar's width the moment it first renders.
			await page.addInitScript(() => {
				const w = window as unknown as { __firstSide?: number };
				new MutationObserver((_, obs) => {
					const el = document.querySelector("aside.d-side");
					if (!el) return;
					w.__firstSide = Math.round(el.getBoundingClientRect().width);
					obs.disconnect();
				}).observe(document, { childList: true, subtree: true });
			});
			await ready(page);
			await handle(page).focus();
			for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
			expect(await side(page)).toBe(360);

			await settled(page);
			await page.reload();
			await page.locator('[data-node="m:studio"]').waitFor();
			expect(await side(page)).toBe(360);
			expect(
				await page.evaluate(
					() => (window as unknown as { __firstSide?: number }).__firstSide,
				),
			).toBe(360);

			// A narrower window caps it at 40 %; widening restores the choice.
			await page.setViewportSize({ width: 1024, height: 800 });
			await settled(page);
			await page.reload();
			await page.locator('[data-node="m:studio"]').waitFor();
			expect(await side(page)).toBe(360);
			await handle(page).focus();
			await page.keyboard.press("End");
			expect(await side(page)).toBe(410);
			await page.setViewportSize({ width: 1440, height: 900 });
			await expect.poll(() => side(page)).toBe(410);
		});
	});
});
