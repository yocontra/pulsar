import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

/**
 * Every dialog, sheet and viewer closes the same way: one X in its corner
 * (aria-label "Close"), a click or tap on the backdrop, and Escape on the
 * desktop. Shared by modals.desktop.e2e.ts and modals.ios.e2e.ts.
 */

export type Way = "x" | "backdrop" | "escape";

/** Opens a modal and returns its container (the surface the X belongs to). */
export type Open = (page: Page, request: APIRequestContext) => Promise<Locator>;
export type Modal = {
	name: string;
	open: Open;
	/** Full screen here: no backdrop to tap (the X is the way out). */
	noBackdrop?: boolean;
	/** Waits for the page below once the modal is gone (optional). */
	after?: (page: Page, way: Way) => Promise<void>;
};

/** What a point hits, through shadow roots (Ionic's backdrop is inside ion-modal). */
async function hitAt(page: Page, x: number, y: number): Promise<string> {
	return page.evaluate(
		([x, y]) => {
			let el = document.elementFromPoint(x, y);
			while (el?.shadowRoot) {
				const inner = el.shadowRoot.elementFromPoint(x, y);
				if (!inner || inner === el) break;
				el = inner;
			}
			if (!el) return "";
			// An Ionic sheet: outside its card is its backdrop.
			const card = el.shadowRoot?.querySelector(".modal-wrapper");
			if (card) {
				const r = card.getBoundingClientRect();
				const inside =
					x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
				return inside ? "ion-modal card" : "ion-backdrop";
			}
			const cls = typeof el.className === "string" ? el.className : "";
			return `${el.tagName.toLowerCase()} ${cls}`;
		},
		[x, y] as const,
	);
}

/** Closes the open modal one way and checks that it went. */
async function closeBy(
	page: Page,
	box: Locator,
	way: Way,
	mobile: boolean,
): Promise<void> {
	if (way === "x") {
		const x = box.getByRole("button", { name: "Close", exact: true });
		await expect(x, "exactly one close X").toHaveCount(1);
		await expect(x).toBeVisible();
		await expect(x).toBeEnabled();
		if (mobile) {
			// A 44 pt hit area: the button plus its ::after.
			const b = (await x.boundingBox())!;
			const hit = await x.evaluate((el) => {
				const a = getComputedStyle(el, "::after");
				return {
					w: el.getBoundingClientRect().width - 2 * Number.parseFloat(a.left),
					h: el.getBoundingClientRect().height - 2 * Number.parseFloat(a.top),
				};
			});
			expect(Math.min(hit.w, hit.h), "X hit area").toBeGreaterThanOrEqual(44);
			await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
		} else await x.click();
	} else if (way === "escape") {
		await page.keyboard.press("Escape");
	} else {
		// The top edge of the window is backdrop for every modal.
		const vw = page.viewportSize()!.width;
		const [x, y] = [mobile ? Math.round(vw / 2) : 6, 6];
		expect(await hitAt(page, x, y), "the point is backdrop").toMatch(
			/ion-backdrop|prove-backdrop|prove-overlay|d-overlay|ds-lightbox-overlay|ds-lightbox-stage/,
		);
		if (mobile) await page.touchscreen.tap(x, y);
		else await page.mouse.click(x, y);
	}
	await expect(box, `closed by ${way}`).toHaveCount(0);
}

/** Walks each modal: one X, and the X, the backdrop and (desktop) Escape close it. */
export function modalSuite(modals: Modal[], mobile: boolean) {
	const ways: Way[] = mobile ? ["x", "backdrop"] : ["x", "backdrop", "escape"];
	for (const m of modals)
		test(`${m.name}: one X; ${ways.join(", ")} close it`, async ({
			page,
			request,
		}) => {
			test.setTimeout(60_000);
			for (const way of ways) {
				if (way === "backdrop" && m.noBackdrop) continue;
				const box = await m.open(page, request);
				await expect(box).toBeVisible();
				// No leftover close-only buttons.
				await expect(
					box.getByRole("button", { name: /^(Done|Close)$/ }),
				).toHaveCount(1);
				await closeBy(page, box, way, mobile);
				await m.after?.(page, way);
			}
		});
}

/** The mock's realtime switch (an interaction prompt, then restore). */
export async function mockRealtime(request: APIRequestContext, data: object) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data,
	});
	expect(res.ok()).toBe(true);
}

/** The blocks fixture's conversation, for the image and PDF viewers. */
export async function blocksConversation(
	page: Page,
	request: APIRequestContext,
): Promise<Locator> {
	const id = await agentId(request, "fixture=blocks");
	await page.goto(`/#/a/${encodeURIComponent(id)}`);
	const conv = page.locator(".ds-conv").first();
	await expect(conv).toBeVisible();
	return conv;
}
