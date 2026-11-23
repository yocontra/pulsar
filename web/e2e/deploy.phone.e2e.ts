/**
 * A deploy under an open phone app (the installed home-screen app, which
 * stays open for days): the page still runs the older build when the daemon
 * moves on, then opens a tab whose chunk it has not loaded yet. On iOS this
 * runs in WebKit, whose failed import reads "Importing a module script
 * failed".
 */
import type { Page } from "@playwright/test";
import { current, serve, stageBuild } from "./builds.ts";
import { expect, test } from "./fixtures.ts";

// /hello reports no build id: the app does not reload itself into the new
// build (src/data/update.ts) mid-test.
const NO_UPDATE = "none";

const top = (page: Page) =>
	page.locator("ion-nav > .ion-page:not(.ion-page-hidden)").last();
const usageTotal = (page: Page) => top(page).getByTestId("usage-total");
const loadedEntry = (page: Page) =>
	page.evaluate(() =>
		document.querySelector('script[type="module"]')?.getAttribute("src"),
	);

/** The app open on build A, its background chunk prefetch done. */
async function openApp(page: Page) {
	await page.goto("/");
	await expect(page.getByTestId("tab-usage")).toBeVisible();
	// PhoneApp prefetches the lazy Ionic module and the page chunks 200 ms
	// after it mounts; a deploy in the middle of that is a different test.
	await page.waitForFunction(
		() =>
			performance
				.getEntriesByType("resource")
				.some((e) => /\/_app\/ionic-lazy\./.test(e.name)) &&
			((window as { __pulsarPrefetching?: number }).__pulsarPrefetching ??
				0) === 0,
	);
}

/** Counts full page loads from now on, and whether a failure screen showed. */
async function watch(page: Page) {
	const seen = { loads: 0, failed: false };
	page.on("load", () => seen.loads++);
	await page.exposeFunction("__sawFailure", () => {
		seen.failed = true;
	});
	const observe = () =>
		new MutationObserver(() => {
			if (document.querySelector(".st-fail, #boot-error:not([hidden])"))
				(window as unknown as { __sawFailure: () => void }).__sawFailure();
		}).observe(document, { childList: true, subtree: true, attributes: true });
	await page.addInitScript(observe);
	await page.evaluate(observe);
	return seen;
}

test.describe("a deploy under an open phone app", () => {
	test("its lazy tabs still load from the older build", async ({
		page,
		request,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await openApp(page);
		// Deploy: the daemon runs the current build; build A stays installed
		// next to it, as `pulsar setup` keeps older builds.
		await serve(request, { previous: [a.root], webBuild: NO_UPDATE });
		const seen = await watch(page);
		await page.getByTestId("tab-usage").click();
		await expect(usageTotal(page)).toHaveText(/^\$[\d,.]+$/);
		expect(seen).toEqual({ loads: 0, failed: false });
		expect(await loadedEntry(page)).toBe(a.entry);
	});

	test("with the older build gone, it reloads into the current one by itself", async ({
		page,
		request,
		errors,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await openApp(page);
		await serve(request, { webBuild: NO_UPDATE });
		const seen = await watch(page);
		await page.getByTestId("tab-usage").click();
		await expect(usageTotal(page)).toHaveText(/^\$[\d,.]+$/);
		// One reload into the current build; never "Try Again".
		expect(seen).toEqual({ loads: 1, failed: false });
		expect(await loadedEntry(page)).toBe(current().entry);
		// The 404 of build A's chunk before the reload.
		const keep = errors.filter(
			(e) =>
				!/Failed to load resource|dynamically imported module|module script failed|Unable to preload/.test(
					e,
				),
		);
		errors.splice(0, errors.length, ...keep);
	});
});
