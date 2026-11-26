/**
 * The phone agent page's bar and dock (mobile/AgentPage.tsx, AgentBar.tsx),
 * on iOS (`ios`) and Android (`android`): the actions (git, Find, Changes,
 * More) in the top toolbar; at 400 px or
 * less Find is in More, and at 360 px or less git too; the title never
 * runs under the actions, and on a 375 px iPhone a name like
 * "apparish-auth" and "Needs approval" show whole; the composer floats in a dock above the home
 * indicator and the keyboard.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

const bar = (page: Page) => page.getByTestId("agent-bar").last();
const actions = (page: Page) => bar(page).getByTestId("agent-actions");
const git = (page: Page) =>
	actions(page).getByRole("button", { name: /^Git: / });
const find = (page: Page) =>
	actions(page).getByRole("button", { name: "Find in messages", exact: true });
const changes = (page: Page) =>
	actions(page).getByRole("button", { name: /^Changes/ });
const more = (page: Page) =>
	actions(page).getByRole("button", { name: "More" });

async function open(page: Page, id: string, width?: number) {
	if (width) {
		const vp = page.viewportSize()!;
		await page.setViewportSize({ width, height: vp.height });
	}
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	await expect(bar(page).locator("h1")).toHaveText("apparish-auth");
	await expect(changes(page)).toBeVisible();
}

/** The title ends before the actions, and the actions end on screen. */
async function fits(page: Page) {
	const width = page.viewportSize()!.width;
	const h1 = (await bar(page).locator("h1").boundingBox())!;
	const act = (await actions(page).boundingBox())!;
	expect(h1.x + h1.width).toBeLessThanOrEqual(act.x + 1);
	expect(act.x + act.width).toBeLessThanOrEqual(width);
}

/**
 * The shown actions, left to right. By role: Ionic moves an ion-button's
 * aria-label into its shadow button once it upgrades.
 */
async function shownActions(page: Page): Promise<string[]> {
	const all = [
		["Git", git(page)],
		["Find", find(page)],
		["Changes", changes(page)],
		["More", more(page)],
	] as const;
	const shown: [string, number][] = [];
	for (const [name, loc] of all) {
		// A lazy button can swap for its loaded self between two reads.
		const box = (await loc.isVisible()) ? await loc.boundingBox() : null;
		if (box) shown.push([name, box.x]);
	}
	return shown.sort((a, b) => a[1] - b[1]).map(([n]) => n);
}

test.describe("agent page bar", () => {
	test("all four actions share a solid header on iOS and Android", async ({
		page,
		request,
	}, info) => {
		const md = info.project.name === "android";
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id, 430);
		await expect(git(page)).toBeVisible();
		await expect(find(page)).toBeVisible();
		await expect(more(page)).toBeVisible();
		await expect
			.poll(() => shownActions(page))
			.toEqual(["Git", "Find", "Changes", "More"]);
		if (md) {
			// Material: the back arrow alone, no previous title, no capsule.
			const back = bar(page).locator(".p-back");
			await expect(back).toHaveClass(/is-md/);
			await expect(back).toHaveText("");
		}
		await expect(bar(page).locator(".p-bar-bg, .k-glass")).toHaveCount(0);
		if (!md)
			await expect(bar(page)).not.toHaveCSS(
				"background-color",
				"rgba(0, 0, 0, 0)",
			);
		// The title ends before the actions start.
		const h1 = await bar(page).locator("h1").boundingBox();
		const act = await actions(page).boundingBox();
		expect(h1!.x + h1!.width).toBeLessThanOrEqual(act!.x + 1);
	});

	for (const width of [320, 360])
		test(`at ${width} px: Changes and More, with git and Find in More`, async ({
			page,
			request,
		}) => {
			const id = await agentId(request, "name=apparish-auth");
			await open(page, id, width);
			await expect(more(page)).toBeVisible();
			await expect(git(page)).toBeHidden();
			await expect(find(page)).toBeHidden();
			await expect.poll(() => shownActions(page)).toEqual(["Changes", "More"]);
			// The title still fits before the actions.
			const h1 = await bar(page).locator("h1").boundingBox();
			const act = await actions(page).boundingBox();
			expect(h1!.x + h1!.width).toBeLessThanOrEqual(act!.x + 1);
			expect(act!.x + act!.width).toBeLessThanOrEqual(width);

			// More → Find in Messages opens the find bar.
			await more(page).click();
			const menu = page.getByRole("menu");
			await expect(menu.getByRole("menuitem", { name: "Git" })).toBeVisible();
			await menu.getByRole("menuitem", { name: "Find in Messages" }).click();
			await expect(
				page.getByRole("search", { name: "Find in messages" }),
			).toBeVisible();
			await page.keyboard.press("Escape");

			// More → Git opens the git sheet.
			await more(page).click();
			await page
				.getByRole("menu")
				.getByRole("menuitem", { name: "Git" })
				.click();
			await expect(page.getByRole("dialog", { name: "Git" })).toBeVisible();
		});

	for (const width of [361, 375, 400])
		test(`at ${width} px: git, Changes and More, with Find in More`, async ({
			page,
			request,
		}) => {
			const id = await agentId(request, "name=apparish-auth");
			await open(page, id, width);
			await expect(git(page)).toBeVisible();
			await expect(find(page)).toBeHidden();
			await expect
				.poll(() => shownActions(page))
				.toEqual(["Git", "Changes", "More"]);
			await fits(page);
			await more(page).click();
			const menu = page.getByRole("menu");
			await expect(menu.getByRole("menuitem", { name: "Git" })).toHaveCount(0);
			await menu.getByRole("menuitem", { name: "Find in Messages" }).click();
			await expect(
				page.getByRole("search", { name: "Find in messages" }),
			).toBeVisible();
		});

	test("at 401 px all four actions show, and More lists neither git nor Find", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id, 401);
		await expect(git(page)).toBeVisible();
		await expect(find(page)).toBeVisible();
		await fits(page);
		await more(page).click();
		const menu = page.getByRole("menu");
		await expect(
			menu.getByRole("menuitem", { name: "Copy Name" }),
		).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Git" })).toHaveCount(0);
		await expect(
			menu.getByRole("menuitem", { name: "Find in Messages" }),
		).toHaveCount(0);
	});

	test("at 375 px with iPhone text size, the name and 'Needs approval' show whole", async ({
		page,
		request,
	}) => {
		// An iPhone's body text is 17 px (macOS WebKit reports 13).
		await page.addInitScript(() => {
			const set = () =>
				document.documentElement.style.setProperty("font-size", "17px");
			if (document.documentElement) set();
			else document.addEventListener("DOMContentLoaded", set);
		});
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id, 375);
		const sub = bar(page).locator(".p-nav-sub .ds-status-text");
		await expect(sub).toHaveText("Needs approval");
		await fits(page);
		const clipped = await page.evaluate(() =>
			[".p-nav-title h1", ".p-nav-sub .ds-status-text", ".p-nav-sub"]
				.map((q) => document.querySelectorAll(q))
				.flatMap((l) => [...l].slice(-1))
				.filter((e) => e.scrollWidth > e.clientWidth + 0.5)
				.map((e) => e.className || e.tagName),
		);
		expect(clipped).toEqual([]);
	});
});

test.describe("agent page bar with a limit warning", () => {
	test.afterEach(async ({ request }) => {
		await request.post("/api/v1/__mock/usage", {
			headers: { "X-Pulsar": "1" },
			data: { reset: true },
		});
	});

	for (const width of [320, 361, 375])
		test(`the limit chip fits at ${width} px`, async ({ page, request }) => {
			const id = await agentId(request, "name=codex@apparish");
			const res = await request.post("/api/v1/__mock/usage", {
				headers: { "X-Pulsar": "1" },
				data: {
					limits: [
						{
							machine: "studio",
							harness: "codex",
							account: "codex",
							window: "m10080",
							label: "Weekly",
							usedPercent: 88,
							reached: false,
							resetsAt: Date.now() + 2 * 86_400_000,
							at: Date.now() - 60_000,
							plan: null,
						},
					],
				},
			});
			expect(res.ok()).toBe(true);
			await page.setViewportSize({
				width,
				height: page.viewportSize()!.height,
			});
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await expect(bar(page).locator("h1")).toHaveText("codex@apparish");
			const chip = actions(page).getByTestId("limit-chip");
			await expect(chip).toHaveText("88%");
			await expect(more(page)).toBeVisible();
			await fits(page);
		});
});

test("every More item has an icon, like the + menu's", async ({
	page,
	request,
}) => {
	const id = await agentId(request, "name=apparish-auth");
	// 320 px: git and Find are in More too.
	await open(page, id, 320);
	await more(page).click();
	const menu = page.getByRole("menu", { name: "apparish-auth actions" });
	const items = menu.getByRole("menuitem");
	await expect(items.first()).toBeVisible();
	const labels = await items.allInnerTexts();
	expect(labels.length).toBeGreaterThan(5);
	expect(labels.map((l) => l.trim())).toEqual(
		expect.arrayContaining(["Git", "Find in Messages", "Copy Name"]),
	);
	const sizes = await items.evaluateAll((els) =>
		els.map((el) => {
			// Computed, not the box: the popover scales in.
			const svg = el.querySelector("svg");
			const cs = svg && getComputedStyle(svg);
			return cs ? `${cs.width}x${cs.height}` : "none";
		}),
	);
	await page.keyboard.press("Escape");
	await page.mouse.click(5, 300);
	// The + menu's icons, for the size.
	await page
		.locator(".p-agent .m-composer")
		.last()
		.getByRole("button", { name: /^Message options/ })
		.click();
	const plus = page.getByRole("menu", { name: "Message options" });
	await expect(plus.getByRole("menuitem").first()).toBeVisible();
	const plusSize = await plus
		.getByRole("menuitem")
		.first()
		.evaluate((el) => {
			const cs = getComputedStyle(el.querySelector("svg")!);
			return `${cs.width}x${cs.height}`;
		});
	expect(sizes).toEqual(labels.map(() => plusSize));
});

test.describe("composer dock", () => {
	test("floats above the home indicator and rides up with the keyboard", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id);
		await page.evaluate(() =>
			document.documentElement.style.setProperty("--sab", "34px"),
		);
		const dock = page.locator(".p-agent .m-composer").last();
		await expect(dock).toBeVisible();
		const vh = page.viewportSize()!.height;
		const radius = await dock.evaluate(
			(el) => Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0,
		);
		expect(radius).toBeGreaterThanOrEqual(20);
		let box = (await dock.boundingBox())!;
		// Inset from the sides, and clear of the home indicator.
		expect(box.x).toBeGreaterThanOrEqual(6);
		expect(vh - (box.y + box.height)).toBeGreaterThanOrEqual(34);
		// A 300 px keyboard: the dock sits on it.
		await page.evaluate(() =>
			document.documentElement.style.setProperty("--kb", "300px"),
		);
		await expect
			.poll(async () => {
				box = (await dock.boundingBox())!;
				return vh - (box.y + box.height);
			})
			.toBeGreaterThanOrEqual(300);
		expect(vh - (box.y + box.height)).toBeLessThan(330);
	});

	test("the keyboard keeps the top bar on screen", async ({
		page,
		request,
	}, info) => {
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id);
		const SAT = 47;
		await page.evaluate(
			(sat) => document.documentElement.style.setProperty("--sat", `${sat}px`),
			SAT,
		);
		const field = page.locator(".p-agent .m-composer textarea").last();
		// A tap focuses the field (main.tsx focuses it itself, without
		// Safari's scroll to it), and nothing scrolls.
		if (info.project.name === "ios") await field.tap();
		else await field.focus();
		await expect(field).toBeFocused();
		/** The keyboard as iOS reports it: the visual viewport `h` px tall,
		 *  moved down `pan` px. The layout viewport stays as it was. */
		const keyboard = (h: number | null, pan: number) =>
			page.evaluate(
				([h, pan]) => {
					const vv = window.visualViewport!;
					const height = h ?? innerHeight;
					Object.defineProperty(vv, "height", {
						configurable: true,
						get: () => height,
					});
					Object.defineProperty(vv, "offsetTop", {
						configurable: true,
						get: () => pan,
					});
					vv.dispatchEvent(new Event("resize"));
					vv.dispatchEvent(new Event("scroll"));
				},
				[h, pan] as const,
			);
		// Where things show on the screen: the visual viewport's coordinates.
		const onScreen = () =>
			page.evaluate(() => {
				const vv = window.visualViewport!;
				const bars = [
					...document.querySelectorAll<HTMLElement>("[data-testid=agent-bar]"),
				];
				const barEl = bars[bars.length - 1]!;
				const title = barEl.querySelector("h1")!.getBoundingClientRect();
				const back = barEl
					.querySelector<HTMLElement>("[aria-label^='Back']")
					?.getBoundingClientRect();
				const docks = [
					...document.querySelectorAll<HTMLElement>(".p-agent .m-composer"),
				];
				const dock = docks[docks.length - 1]!.getBoundingClientRect();
				return {
					barTop: barEl.getBoundingClientRect().top - vv.offsetTop,
					titleTop: title.top - vv.offsetTop,
					backTop: back ? back.top - vv.offsetTop : null,
					dockBottom: dock.bottom - vv.offsetTop,
					vvHeight: vv.height,
					scrollTop: document.scrollingElement!.scrollTop,
					scrollY: window.scrollY,
				};
			});
		const vh = page.viewportSize()!.height;
		// iOS 27 Safari, measured: a 339 px keyboard, no pan once the field is
		// focused without the scroll; and the pan iOS adds when it scrolls.
		for (const pan of [0, 220]) {
			await keyboard(vh - 300, pan);
			await expect
				.poll(async () => (await onScreen()).dockBottom, `pan ${pan}`)
				.toBeLessThanOrEqual(vh - 300);
			const s = await onScreen();
			expect(s.barTop, `pan ${pan}: bar on screen`).toBeGreaterThanOrEqual(0);
			expect(
				s.titleTop,
				`pan ${pan}: title under the status bar`,
			).toBeGreaterThanOrEqual(SAT);
			if (s.backTop !== null) expect(s.backTop).toBeGreaterThanOrEqual(SAT - 1);
			// The dock sits on the keyboard (an 8 px gap at most 20).
			expect(s.dockBottom, `pan ${pan}: dock on the keyboard`).toBeGreaterThan(
				s.vvHeight - 20,
			);
			// The document never scrolled.
			expect(s.scrollTop).toBe(0);
			expect(s.scrollY).toBe(0);
		}
		// The keyboard goes: everything back in place.
		await keyboard(null, 0);
		await expect
			.poll(() =>
				page.evaluate(() => document.documentElement.hasAttribute("data-vv")),
			)
			.toBe(false);
		const after = await onScreen();
		expect(after.titleTop).toBeGreaterThanOrEqual(SAT);
		expect(after.titleTop).toBeLessThan(SAT + 44);
		expect(after.dockBottom).toBeGreaterThan(vh - 60);
	});
});
