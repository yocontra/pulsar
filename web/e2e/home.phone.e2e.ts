/**
 * The Agents tab (mobile/Home.tsx) on iOS and Android: New agent is the
 * header's "+" on iOS and a floating button above the bottom navigation on
 * Android; the one-line needs summary opens Needs You; the search field is
 * Konsta's once it loads; the pool footer counts the machines.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

async function expectSharpHeader(page: Page) {
	const header = page.locator("ion-header.p-bar:visible").last();
	await expect(header).toBeVisible();
	await expect(header).not.toHaveClass(/header-translucent/);
	const filters = await header.evaluate((el) =>
		[el, ...el.querySelectorAll("*")]
			.map((node) => {
				const style = getComputedStyle(node);
				return (
					style.getPropertyValue("backdrop-filter") ||
					style.getPropertyValue("-webkit-backdrop-filter")
				);
			})
			.filter((value) => value && value !== "none"),
	);
	expect(filters).toEqual([]);
}

test.describe("agents tab", () => {
	test("New agent: the header's + on iOS, a FAB on Android", async ({
		page,
	}, info) => {
		await ready(page);
		const md = info.project.name === "android";
		const add = page.getByRole("button", { name: "New agent" });
		await expect(add).toHaveCount(1);
		await expect(add).toBeVisible();
		// The match can be the native button in ion-button's shadow root.
		const inHeader = await add.evaluate((el) => {
			const host = (el.getRootNode() as ShadowRoot).host ?? el;
			return !!host.closest("ion-header");
		});
		expect(inHeader).toBe(!md);
		if (md) {
			// Above the bottom navigation, clear of it, at the right edge.
			const [fab, bar] = await Promise.all([
				add.boundingBox(),
				page.getByTestId("tabbar").boundingBox(),
			]);
			expect(fab!.y + fab!.height).toBeLessThanOrEqual(bar!.y - 8);
			const vw = page.viewportSize()!.width;
			expect(vw - (fab!.x + fab!.width)).toBeGreaterThanOrEqual(12);
			expect(fab!.width).toBeGreaterThanOrEqual(48);
			// It stays put while the list scrolls.
			const y = fab!.y;
			await page
				.locator("ion-nav > .ion-page:last-child ion-content")
				.evaluate(async (c) => {
					const el = await (
						c as unknown as { getScrollElement(): Promise<HTMLElement> }
					).getScrollElement();
					el.scrollTop = 400;
				});
			await expect.poll(async () => (await add.boundingBox())!.y).toBe(y);
		}
		await expect(page.locator(".p-home-search .k-searchbar")).toBeVisible();
		await expectSharpHeader(page);
		await add.click();
		await expect(page).toHaveURL(/#\/new$/);
		await expectSharpHeader(page);
	});

	test("the needs summary opens Needs You; it hides while searching", async ({
		page,
	}) => {
		await ready(page);
		const sum = page.getByTestId("needs-summary");
		await expect(sum).toBeVisible();
		// The row's native button (Ionic moves aria-label onto it) is named.
		await expect(
			sum.getByRole("button", { name: /^\d+ (needs|need) you$/ }),
		).toBeVisible();
		// One row, not the list of approvals.
		await expect(page.locator(".p-home ion-item.p-attn")).toHaveCount(0);
		const field = page.getByLabel("Search agents and messages");
		await field.fill("studio");
		await expect(sum).toHaveCount(0);
		await field.fill("");
		await expect(sum).toBeVisible();
		await sum.click();
		await expect(page).toHaveURL(/#\/needs$/);
		await expect(page.getByTestId("tab-needs")).toHaveAttribute(
			"aria-current",
			"page",
		);
	});

	test("the search field becomes Konsta's and keeps the text typed before", async ({
		page,
	}) => {
		await ready(page);
		await expect(page.locator(".p-home-search .k-searchbar input")).toHaveId(
			"p-home-q",
		);
		await expect(page.locator(".p-search-plain")).toHaveCount(0);
		const field = page.getByLabel("Search agents and messages");
		await field.fill("apparish");
		await expect(
			page.locator('[data-node="m:studio/p:apparish"]'),
		).toBeVisible();
		// The pool footer gives way to the results while searching.
		await expect(page.getByTestId("pool-footer")).toHaveCount(0);
		await field.fill("");
		await expect(page.getByTestId("pool-footer")).toContainText(/machines?$/);
	});

	test("a message to agents by id lists them, with N agents as the footer", async ({
		page,
		request,
	}) => {
		const a = await agentId(request, "name=apparish-auth");
		const b = await agentId(request, "name=codex@apparish");
		await ready(page);
		await page.evaluate(
			(ids) => {
				location.hash = `#/ids?ids=${ids.map(encodeURIComponent).join(",")}`;
			},
			[a, b],
		);
		const p = page.getByTestId("ids-page");
		await expect(
			page.locator("ion-nav > .ion-page:last-child ion-title").first(),
		).toHaveText("2 Agents");
		const list = page.getByRole("region", { name: "Agents" });
		await expect(list.locator(".p-ids-row")).toHaveCount(2);
		await expect(page.getByTestId("ids-footer")).toHaveText("2 agents");
		await expect(p).toBeVisible();
		await expect(page.getByRole("textbox").last()).toBeVisible();
		await list.locator(".p-ids-row").first().click();
		await expect(page).toHaveURL(/#\/a\//);
	});

	test("a tap before the lazy Ionic module loads has its ripple (no error)", async ({
		page,
	}) => {
		// Hold the lazy Ionic chunk: only the first route's code is in. The
		// fixture fails the test on any page error (Ionic's tap effect threw
		// "addRipple is not a function" on Android here).
		await page.route(/\/ionic-lazy\./, () => new Promise(() => {}));
		await page.goto("/");
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		expect(
			await page.evaluate(() => !!customElements.get("ion-ripple-effect")),
		).toBe(true);
		await expect(page.locator("ion-ripple-effect:not(:defined)")).toHaveCount(
			0,
		);
		await page.getByRole("treeitem", { name: /^apparish, project/ }).click();
		await expect(
			page.getByRole("treeitem", { name: /^apparish, project.*expanded/ }),
		).toBeVisible();
	});

	test("IonNav animates with the transition we hold, never its own import", async ({
		page,
		request,
	}) => {
		// Without nav.animation, IonNav imports its transition on each animated
		// push or swipe; a navigation that cancels that import throws
		// "Importing a module script failed." The push waits for the lazy
		// module, so IonNav has its transition from the first push on.
		const id = await agentId(request, "name=codex@apparish");
		await page.goto("/");
		await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
		await page.evaluate(
			(h) => {
				location.hash = h;
			},
			`#/a/${encodeURIComponent(id)}`,
		);
		await page.locator(".transcript .ev").first().waitFor();
		await expect
			.poll(() =>
				page.evaluate(
					() =>
						typeof (
							document.querySelector("ion-nav") as {
								animation?: unknown;
							} | null
						)?.animation,
				),
			)
			.toBe("function");
	});
});
