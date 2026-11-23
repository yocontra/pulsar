/**
 * The phone agent page's bar and dock (mobile/AgentPage.tsx, AgentBar.tsx),
 * on iOS (`ios`) and Android (`android`): the actions (git, Find, Changes,
 * More) in iOS's glass capsule or as Material icon buttons; at 360 px or
 * less only Changes and More, with git and Find in More; the title never
 * runs under the actions; the composer floats in a dock above the home
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
	test("all four actions, in a glass capsule on iOS and icon buttons on Android", async ({
		page,
		request,
	}, info) => {
		const md = info.project.name === "android";
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id, 393);
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
			await expect(actions(page)).not.toHaveClass(/k-glass/);
		} else {
			await expect(actions(page)).toHaveClass(/k-glass/);
		}
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

	test("at 361 px all four actions show, and More lists neither git nor Find", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=apparish-auth");
		await open(page, id, 361);
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
});
