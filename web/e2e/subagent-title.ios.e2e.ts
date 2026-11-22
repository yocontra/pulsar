/**
 * The subagent page's top bar: the back button keeps its title ("‹ Agents",
 * "‹ Back", up to 12 letters), and the subagent's name and status start after
 * it and end in an ellipsis, never under it. Opened directly (a link or a
 * notification) and from an agent page, at 375 and 320 px, at the default
 * text size and at larger iOS text sizes (the phone root follows
 * -apple-system-body: 17 px, larger with Dynamic Type).
 */
import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

/** The mock's longest subagent name: "Check the test runner flags". */
const SUB = "sub:a3nested";
const NAME = "Check the test runner flags";

async function textSize(page: Page, px: number) {
	await page.addInitScript((px) => {
		const apply = () =>
			document.documentElement?.style.setProperty("font-size", `${px}px`);
		apply();
		document.addEventListener("DOMContentLoaded", apply);
	}, px);
}

/** The top bar's boxes, as painted (text by its glyphs). */
function topBar(page: Page, set?: string) {
	return page.evaluate((set) => {
		const bar = [
			...document.querySelectorAll<HTMLElement>(".p-sub-header ion-toolbar"),
		].find((b) => b.checkVisibility())!;
		const glyphs = (el: Element) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			const r = range.getBoundingClientRect();
			// What shows: clipped by the element's own box (the ellipsis).
			const box = el.getBoundingClientRect();
			return {
				left: Math.max(r.left, box.left),
				right: Math.min(r.right, box.right),
			};
		};
		const back = bar.querySelector(".p-back")!;
		const label = back.querySelector("span")!;
		if (set) label.textContent = set;
		const h1 = bar.querySelector<HTMLElement>(".p-nav-title h1")!;
		const sub = bar.querySelector(".p-nav-sub")!;
		const s = getComputedStyle(h1);
		return {
			label: label.textContent ?? "",
			back: back.getBoundingClientRect().right,
			labelGlyphs: glyphs(label),
			labelClipped: label.scrollWidth > label.clientWidth + 1,
			labelEllipsis: getComputedStyle(label).textOverflow === "ellipsis",
			title: glyphs(h1),
			sub: glyphs(sub),
			titleWidth: h1.clientWidth,
			truncated: h1.scrollWidth > h1.clientWidth + 1,
			ellipsis: s.textOverflow === "ellipsis" && s.overflow === "hidden",
			barRight: bar.getBoundingClientRect().right,
		};
	}, set);
}

type Open = [
	label: string,
	open: (page: Page, auth: string, sub: string) => Promise<void>,
	/** A back title set in place, after the page settles. */
	set?: string,
];

async function direct(page: Page, _auth: string, sub: string) {
	await page.goto("about:blank");
	await page.goto(`/#/s/${encodeURIComponent(sub)}`);
	await page.locator(`[data-subagent-page="${sub}"]`).waitFor();
}

const OPENS: Open[] = [
	// A link or a notification: Home is the page below.
	["Agents", direct],
	// From the parent's Subagents section: its name (13 letters) reads "Back".
	[
		"Back",
		async (page, auth, sub) => {
			await page.goto("about:blank");
			await page.goto(`/#/a/${encodeURIComponent(auth)}`);
			const section = page.locator(`[data-subs-section="${auth}"]`).last();
			await section.locator(".p-sa-toggle").click();
			await section
				.locator("[data-subagent]")
				.filter({ hasText: NAME })
				.click();
			await page.locator(`[data-subagent-page="${sub}"]`).waitFor();
		},
	],
	// The longest back titles shown whole (12 letters; longer ones read
	// "Back"): no mock page has one, so they are set in place.
	["claude@atlas", direct, "claude@atlas"],
	["MMMMMMMMMMMM", direct, "MMMMMMMMMMMM"],
];

for (const [w, px] of [
	[375, 17],
	[320, 17],
	[375, 20],
	[320, 20],
	[375, 23],
	[320, 23],
] as const)
	test(`the subagent's title clears its back button at ${w} px, ${px} px text`, async ({
		page,
		request,
	}) => {
		await page.setViewportSize({ width: w, height: 700 });
		await textSize(page, px);
		// The finished subagent shows in its parent's section.
		await page.addInitScript(() => {
			try {
				localStorage.setItem("pulsar.showFinishedSubagents", "1");
			} catch {}
		});
		const auth = await agentId(request, "name=apparish-auth");
		const sub = `${auth}/${SUB}`;
		for (const [label, open, set] of OPENS) {
			await open(page, auth, sub);
			await expect(page.locator(".p-sub-header h1").last()).toHaveText(NAME);
			// Ionic's push transition.
			await page.waitForTimeout(700);
			const bar = await topBar(page, set);
			const what = `${label} at ${w} px, ${px} px text`;
			expect(bar.label, what).toBe(label);
			// The back title shows whole; the widest one (12 capitals) ends in
			// an ellipsis at its 7.5rem cap...
			if (label.startsWith("M")) expect(bar.labelEllipsis, what).toBe(true);
			else expect(bar.labelClipped, `${what}: back title clipped`).toBe(false);
			// ...and the name and status start after the button.
			expect(
				bar.title.left,
				`${what}: title under the back button`,
			).toBeGreaterThanOrEqual(bar.back - 0.5);
			expect(
				bar.sub.left,
				`${what}: status under the back button`,
			).toBeGreaterThanOrEqual(bar.back - 0.5);
			expect(bar.title.right, what).toBeLessThanOrEqual(bar.barRight);
			// A long name ends in an ellipsis and keeps room to be read.
			expect(bar.ellipsis, what).toBe(true);
			// The widest back title leaves 320 px too narrow for the whole name.
			if (w === 320 && label.startsWith("M"))
				expect(bar.truncated, `${what}: not truncated`).toBe(true);
			expect(bar.titleWidth, `${what}: title squeezed`).toBeGreaterThan(80);
		}
	});
