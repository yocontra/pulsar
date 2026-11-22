import type { APIRequestContext, Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";

/**
 * Where the conversation keeps the operator as it changes (scroll anchoring
 * plus use-stick-to-bottom): at the end, a new reply follows; scrolled up,
 * neither a new reply below nor earlier messages above move what they read.
 * Shared by anchoring.desktop.e2e.ts and anchoring.ios.e2e.ts.
 */

const scroller = (page: Page) => page.locator(".ds-scroller > div").first();

/** Pixels between the bottom of the scroller and the end of the conversation. */
const fromEnd = (page: Page) =>
	scroller(page).evaluate((s) => s.scrollHeight - s.scrollTop - s.clientHeight);

async function say(request: APIRequestContext, id: string, text: string) {
	const res = await request.post("/api/v1/__mock/realtime", {
		headers: { "X-Pulsar": "1" },
		data: { action: "transcript", id, text },
	});
	expect(res.ok()).toBe(true);
}

/** A reply long enough to change the conversation's height by several lines. */
const reply = (tag: string) =>
	`${tag}: ${"A reply that wraps over several lines so the conversation grows. ".repeat(6)}`;

/** The turns whose top is on screen (at most 6), marked with where it is. */
async function onScreen(page: Page): Promise<number[]> {
	return scroller(page).evaluate((s) => {
		const box = s.getBoundingClientRect();
		const turns = Array.from(s.querySelectorAll(".ds-conv > *"));
		const out = turns
			.map((el, i) => ({ i, r: el.getBoundingClientRect() }))
			.filter(({ r }) => r.top >= box.top && r.top < box.bottom)
			.slice(0, 6)
			.map(({ i, r }) => {
				turns[i]!.setAttribute("data-e2e-mark", String(r.top));
				return r.top;
			});
		if (!out.length) throw new Error("no turn on screen");
		return out;
	});
}

/** How far the reader's place moved since onScreen marked it. */
const moved = (page: Page) =>
	scroller(page).evaluate((s) => {
		// The topmost marked turn still there: the reader's place. (A turn
		// lower on screen moves when one above it on screen grows.)
		const mark = s.querySelector("[data-e2e-mark]");
		if (!mark) throw new Error("every marked turn was replaced");
		return Math.abs(
			mark.getBoundingClientRect().top -
				Number(mark.getAttribute("data-e2e-mark")),
		);
	});

/**
 * Scroll up as the operator does: a wheel turn up first, which
 * use-stick-to-bottom takes as leaving the end (a bare scrollTop change
 * during a resize is not), then to `y` (a function of the current scrollTop).
 */
const scrollUp = (page: Page, by: number | "top") =>
	scroller(page).evaluate((s, by) => {
		s.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true }));
		s.scrollTop = by === "top" ? 0 : Math.max(0, s.scrollTop - by);
	}, by);

async function open(
	page: Page,
	request: APIRequestContext,
	selector: string,
	atEnd = true,
) {
	await ready(page);
	const id = await agentId(request, selector);
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	await expect(page.locator(".transcript .ev").first()).toBeVisible();
	// Settled at the end: images, code and diagrams in view have their size.
	if (atEnd) await expect.poll(() => fromEnd(page)).toBeLessThan(2);
	await page.waitForTimeout(800);
	if (atEnd) await expect.poll(() => fromEnd(page)).toBeLessThan(2);
	return id;
}

export function anchoringSuite(platform: "desktop" | "phone") {
	test(`at the end, a new reply follows the end (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await open(page, request, "status=idle machine=edge-19");
		const text = reply(`follow ${Date.now().toString(36)}`);
		await say(request, id, text);
		await expect(page.locator(".transcript")).toContainText(text.slice(0, 40));
		await expect.poll(() => fromEnd(page)).toBeLessThan(2);
		await expect(
			page.locator(".ev", { hasText: text.slice(0, 40) }),
		).toBeInViewport();
	});

	test(`scrolled up, a new reply below leaves the reader in place (${platform})`, async ({
		page,
		request,
	}) => {
		const id = await open(page, request, "status=idle machine=edge-19");
		await scrollUp(page, 1200);
		await page.waitForTimeout(400);
		await onScreen(page);
		const text = reply(`below ${Date.now().toString(36)}`);
		await say(request, id, text);
		await expect(page.locator(".transcript")).toContainText(text.slice(0, 40));
		await page.waitForTimeout(400);
		expect(await moved(page)).toBeLessThan(2);
		expect(await fromEnd(page)).toBeGreaterThan(400);
	});

	test(`scrolled up, content that grows above leaves the reader in place (${platform})`, async ({
		page,
		request,
	}) => {
		await open(page, request, "status=idle machine=edge-19");
		await scrollUp(page, 1200);
		await page.waitForTimeout(400);
		await onScreen(page);
		// A turn above the screen grows (as a turn's changes or an image load).
		await scroller(page).evaluate(async (s) => {
			const box = s.getBoundingClientRect();
			const above = Array.from(
				s.querySelectorAll<HTMLElement>(".ds-conv > *"),
			).filter((el) => el.getBoundingClientRect().bottom < box.top);
			const el = above.at(-1);
			if (!el) throw new Error("no turn above the screen");
			el.style.paddingBottom = "300px";
			await new Promise((r) => requestAnimationFrame(() => r(null)));
		});
		await page.waitForTimeout(200);
		expect(await moved(page)).toBeLessThan(2);
	});

	test(`"Load earlier messages" keeps the reader's place (${platform})`, async ({
		page,
		request,
	}) => {
		// Not waiting for the end: this session's inline approval can leave
		// the phone short of it, which is not what this test is about.
		await open(page, request, "name=apparish-auth", false);
		const earlier = page.locator(".load-earlier");
		await scrollUp(page, "top");
		await expect(earlier).toBeInViewport();
		await page.waitForTimeout(400);
		await onScreen(page);
		const count = await page.locator(".transcript .ev").count();
		await earlier.click();
		await expect
			.poll(() => page.locator(".transcript .ev").count())
			.not.toBe(count);
		await page.waitForTimeout(400);
		expect(await moved(page)).toBeLessThan(2);
	});
}
