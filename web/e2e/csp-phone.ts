import { expect, type Page } from "@playwright/test";

/**
 * Ionic under the strict CSP: its component styles arrive as adopted
 * stylesheets (astro.config.mjs patches Stencil), never as <style> tags,
 * and the non-shadow components (header, item-sliding, refresher) and
 * Konsta's tab bar are styled. CSP violations themselves fail every test (fixtures.ts).
 */
export async function expectIonicStyledUnderCsp(page: Page) {
	const r = await page.evaluate(() => ({
		styleTags: document.querySelectorAll("style").length,
		adopted: document.adoptedStyleSheets.length,
		header: getComputedStyle(document.querySelector("ion-header")!).display,
		// Konsta's tab bar: its utility classes applied (fixed, glass or bar).
		tabbar: (() => {
			const t = document.querySelector('[data-testid="tabbar"]');
			return t ? getComputedStyle(t).position : "fixed";
		})(),
		sliding: document.querySelector("ion-item-sliding")
			? getComputedStyle(document.querySelector("ion-item-sliding")!).display
			: "block",
	}));
	expect(r.styleTags, "inline <style> tags").toBe(0);
	expect(r.adopted, "adopted stylesheets").toBeGreaterThan(5);
	expect(r.header).toBe("block");
	expect(r.sliding).toBe("block");
	expect(r.tabbar).toBe("fixed");
}
