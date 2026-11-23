/**
 * The collapsed large title (on Android, Material's bar title): scrolled down, the page's small title in the top
 * bar never sits under a toolbar button, on every page whose large title
 * condenses. Tab roots show no title (TabShell; tabs.phone.e2e.ts). At 320, 375 and 430 px, at
 * the default text size and at larger iOS text sizes (the phone root follows
 * -apple-system-body: 17 px, larger with Dynamic Type), with the buttons the
 * page has, with more end buttons than it has today, and with a long title
 * (it ends in an ellipsis).
 */
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

async function textSize(page: Page, px: number) {
	await page.addInitScript((px) => {
		const apply = () =>
			document.documentElement?.style.setProperty("font-size", `${px}px`);
		apply();
		document.addEventListener("DOMContentLoaded", apply);
		try {
			localStorage.setItem("pulsar.installHint", "1");
		} catch {}
	}, px);
}

type Screen = {
	name: string;
	title: string;
	open: (page: Page) => Promise<void>;
};

const SCREENS: Screen[] = [
	{
		name: "search",
		title: "Search",
		open: async (page) => {
			await page.goto("/#/search");
			await page.locator("ion-content.p-search-page").waitFor();
		},
	},
];

/** The visible page's top bar (the header outside its content). */
const BAR =
	".ion-page:not(.ion-page-hidden) > ion-header:not(.header-collapse-condense) ion-toolbar";

/** Scrolls the page until its large title has collapsed into the bar. */
async function collapse(page: Page) {
	await page.evaluate(async () => {
		const c = [
			...document.querySelectorAll<
				HTMLElement & { getScrollElement(): Promise<HTMLElement> }
			>(".ion-page:not(.ion-page-hidden) ion-content"),
		].find((e) => e.checkVisibility())!;
		const el = await c.getScrollElement();
		// Room to scroll the large title out, even on a short page.
		const pad = document.createElement("div");
		pad.style.height = "2000px";
		pad.dataset.pad = "";
		c.appendChild(pad);
		el.scrollTop = 240;
		el.dispatchEvent(new Event("scroll"));
	});
	const header = page
		.locator(
			".ion-page:not(.ion-page-hidden) > ion-header:not(.header-collapse-condense)",
		)
		.first();
	await expect(header).not.toHaveClass(/header-collapse-condense-inactive/);
	const title = page.locator(`${BAR} ion-title`).first();
	await expect
		.poll(() => title.evaluate((t) => getComputedStyle(t).opacity))
		.toBe("1");
	// Ionic fades the small title in.
	await expect
		.poll(() =>
			title.evaluate((t) => {
				const inner = t.shadowRoot?.querySelector(".toolbar-title");
				return inner ? getComputedStyle(inner).opacity : "1";
			}),
		)
		.toBe("1");
}

/** Adds end buttons, as more features register header actions. */
function addEndButtons(page: Page, n: number) {
	return page.evaluate(
		([bar, n]) => {
			const toolbar = document.querySelector(bar)!;
			const host =
				toolbar.querySelector(":scope > ion-buttons[slot=end]") ??
				toolbar.appendChild(
					Object.assign(document.createElement("ion-buttons"), {
						slot: "end",
					}),
				);
			const model =
				host.querySelector("ion-button") ??
				Object.assign(document.createElement("ion-button"), {
					textContent: "+",
				});
			for (let i = 0; i < n; i++) {
				const b = model.cloneNode(true) as HTMLElement;
				b.dataset.extra = "";
				host.appendChild(b);
			}
		},
		[BAR, n] as const,
	);
}

/** The small title's glyphs and every button's box, as painted. */
function measure(page: Page, text?: string) {
	return page.evaluate(
		([bar, text]) => {
			const toolbar = document.querySelector<HTMLElement>(bar)!;
			const title = toolbar.querySelector<HTMLElement>("ion-title")!;
			if (text) title.textContent = text;
			const inner =
				title.shadowRoot?.querySelector<HTMLElement>(".toolbar-title") ?? title;
			const tb = toolbar.getBoundingClientRect();
			const range = document.createRange();
			range.selectNodeContents(title);
			const glyphs = range.getBoundingClientRect();
			const clip = inner.getBoundingClientRect();
			const box = {
				left: Math.max(glyphs.left, clip.left),
				right: Math.min(glyphs.right, clip.right),
				top: Math.max(glyphs.top, clip.top),
				bottom: Math.min(glyphs.bottom, clip.bottom),
			};
			const buttons = [
				...toolbar.querySelectorAll<HTMLElement>(
					"ion-buttons > *, ion-back-button",
				),
			]
				.filter((b) => b.checkVisibility())
				.map((b) => {
					const r = b.getBoundingClientRect();
					const side =
						b.closest("[slot]")?.getAttribute("slot") === "end"
							? "end"
							: "start";
					return {
						side,
						label:
							b.getAttribute("aria-label") ??
							b.textContent?.trim() ??
							b.tagName,
						left: r.left,
						right: r.right,
						top: r.top,
						bottom: r.bottom,
					};
				});
			const s = getComputedStyle(inner);
			const starts = buttons.filter((b) => b.side === "start");
			const ends = buttons.filter((b) => b.side === "end");
			const startEdge = starts.length
				? Math.max(...starts.map((b) => b.right))
				: tb.left;
			const endEdge = ends.length
				? Math.min(...ends.map((b) => b.left))
				: tb.right;
			return {
				box,
				shown: box.right - box.left,
				natural: glyphs.right - glyphs.left,
				/** Room between the button groups. */
				free: endEdge - startEdge,
				startEdge,
				endEdge,
				buttons,
				truncated: inner.scrollWidth > inner.clientWidth + 1,
				ellipsis: s.textOverflow === "ellipsis" && s.overflow === "hidden",
				center: (glyphs.left + glyphs.right) / 2,
				barCenter: (tb.left + tb.right) / 2,
				barLeft: tb.left,
				barRight: tb.right,
			};
		},
		[BAR, text] as const,
	);
}

type M = Awaited<ReturnType<typeof measure>>;

function expectClear(m: M, what: string) {
	// Hidden only when the buttons leave no room for it.
	if (m.free > 48)
		expect(
			m.shown,
			`${what}: title hidden (${m.free.toFixed(0)} px free)`,
		).toBeGreaterThan(20);
	expect(m.box.left, what).toBeGreaterThanOrEqual(m.barLeft);
	expect(m.box.right, what).toBeLessThanOrEqual(m.barRight);
	// No glyph painted (the buttons fill the bar): nothing to overlap.
	if (m.shown < 1) return;
	for (const b of m.buttons) {
		const overlaps =
			m.box.left < b.right - 0.5 &&
			b.left < m.box.right - 0.5 &&
			m.box.top < b.bottom &&
			b.top < m.box.bottom;
		expect(
			overlaps,
			`${what}: title [${m.box.left.toFixed(1)}, ${m.box.right.toFixed(1)}] under "${b.label}" [${b.left.toFixed(1)}, ${b.right.toFixed(1)}]`,
		).toBe(false);
	}
}

const LONG = "A very long page title that cannot fit in the bar";

for (const w of [320, 375, 430])
	for (const px of [17, 20, 23])
		test(`collapsed titles clear the toolbar buttons at ${w} px, ${px} px text`, async ({
			page,
		}) => {
			await page.setViewportSize({ width: w, height: 760 });
			await textSize(page, px);
			for (const s of SCREENS) {
				const what = `${s.name} at ${w} px, ${px} px text`;
				await s.open(page);
				await collapse(page);
				const m = await measure(page);
				expectClear(m, what);
				// The short title shows whole when the buttons leave the room...
				if (m.free > m.natural + 16)
					expect(
						m.truncated,
						`${what}: title truncated ${JSON.stringify({ ...m, buttons: undefined })}`,
					).toBe(false);
				// ...and centered when it has the room, as on iOS.
				const dump = JSON.stringify({ ...m, buttons: undefined });
				// (Material's title sits at the start, as on Android.)
				const ios = await page.evaluate(() =>
					document.documentElement.classList.contains("ios"),
				);
				if (
					ios &&
					m.barCenter - m.natural / 2 > m.startEdge + 8 &&
					m.barCenter + m.natural / 2 < m.endEdge - 8
				)
					expect(
						Math.abs(m.center - m.barCenter),
						`${what}: title off center ${dump}`,
					).toBeLessThan(2);
				// More header actions than today: the title still clears them.
				await addEndButtons(page, 2);
				await page.waitForTimeout(100);
				expectClear(await measure(page), `${what}, 2 more buttons`);
				// A long title ends in an ellipsis between the buttons.
				const long = await measure(page, LONG);
				await page.waitForTimeout(100);
				const l = await measure(page, LONG);
				expectClear(l, `${what}, long title`);
				if (l.free > 48)
					expect(long.ellipsis && l.truncated, `${what}: no ellipsis`).toBe(
						true,
					);
			}
		});

test("before and after shot of a collapsed bar", async ({
	page,
	errors,
}, info) => {
	const dir = process.env.COLLAPSED_TITLE_SHOTS_DIR;
	test.skip(!dir, "set COLLAPSED_TITLE_SHOTS_DIR to save the shot");
	await page.setViewportSize({ width: 375, height: 760 });
	await textSize(page, 17);
	await SCREENS[0]?.open(page);
	await collapse(page);
	// WebKit screenshots inject Playwright's own stylesheet, which the app's
	// CSP refuses: drop exactly those reports, made during the shot.
	const box = (await page.locator(BAR).first().boundingBox())!;
	const before = errors.length;
	await page.screenshot({
		path: `${dir}/search-collapsed-375-${info.project.name}.png`,
		clip: { x: 0, y: 0, width: box.width, height: box.y + box.height },
		caret: "initial",
	});
	const during = errors.splice(before);
	errors.push(
		...during.filter((e) => !/^Refused to apply a stylesheet/.test(e)),
	);
});
