/**
 * The daemon unreachable under an open app (the phone off Tailscale): the
 * shell and its loaded chunks keep running, every request to the machine
 * fails. A screen whose chunk did not load, or an event stream that can't
 * reconnect, says "Can't reach studio" (never "Importing a module script
 * failed"), waits without reloading, and comes back by itself into the
 * same screen once the machine answers.
 */
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Every request to the machine fails. `chunks`: the app's files too (a
 * chunk the service worker has not cached); else they still load (cached).
 */
async function goOffTailnet(page: Page, chunks: boolean | RegExp = true) {
	await page.route("**/api/v1/**", (r) => r.abort("failed"));
	if (chunks)
		await page.route(chunks === true ? "**/_app/**" : chunks, (r) =>
			r.abort("failed"),
		);
}
/** The network is back: the app notices at once (`online`). */
async function backOnTailnet(page: Page) {
	await page.unrouteAll();
	await page.evaluate(() => dispatchEvent(new Event("online")));
}

/** Counts full page loads, and whether a load-failure screen ever showed. */
async function watch(page: Page) {
	const seen = { loads: 0, failed: false };
	page.on("load", () => seen.loads++);
	await page.exposeFunction("__sawFailure", () => {
		seen.failed = true;
	});
	const observe = () =>
		new MutationObserver(() => {
			if (
				document.querySelector("#boot-error:not([hidden])") ||
				[...document.querySelectorAll(".st-fail")].some((e) =>
					/didn't load/.test(e.textContent ?? ""),
				)
			)
				(window as unknown as { __sawFailure: () => void }).__sawFailure();
		}).observe(document, {
			childList: true,
			subtree: true,
			attributes: true,
			characterData: true,
		});
	await page.addInitScript(observe);
	await page.evaluate(observe);
	return seen;
}

/** The app loaded, its background chunk prefetch done. */
async function settled(page: Page) {
	await page.waitForFunction(
		() =>
			document.documentElement.hasAttribute("data-booted") &&
			((window as { __pulsarPrefetching?: number }).__pulsarPrefetching ??
				0) === 0,
	);
}

/** Drop what the requests the test cut off logged. */
function excuseCutRequests(errors: string[]) {
	const keep = errors.filter(
		(e) =>
			!/Failed to load resource|dynamically imported module|module script failed|Unable to preload|net::ERR_|EventSource/.test(
				e,
			),
	);
	errors.splice(0, errors.length, ...keep);
}

const H = { "X-Pulsar": "1" };
const loadReports = async (request: APIRequestContext) =>
	(await (
		await request.get("/api/v1/__mock/client-errors", { headers: H })
	).json()) as {
		report: { kind: string };
	}[];

export function unreachableSpecs(o: {
	/** "Can't Reach studio" on the phone, "Can't reach studio" on the desktop. */
	title: string;
	/** The Tailscale line (the phone names the app). */
	body: string;
	/** Opens a screen whose chunk the first screen never loads. */
	openLazy: (page: Page) => Promise<void>;
	/** That screen, loaded. */
	lazyShown: (page: Page) => ReturnType<Page["locator"]>;
	/** A part of the first screen, to see it back. */
	home: (page: Page) => ReturnType<Page["locator"]>;
}) {
	test.describe("the daemon unreachable under an open app", () => {
		test("a screen whose chunk can't load says the machine is unreachable, then recovers by itself", async ({
			page,
			request,
			errors,
		}) => {
			await request.post("/api/v1/__mock/client-errors", { headers: H });
			await page.goto("/");
			await expect(o.home(page)).toBeVisible();
			await settled(page);
			const seen = await watch(page);

			await goOffTailnet(page);
			await o.openLazy(page);
			const off = page.getByText(o.title, { exact: true }).first();
			await expect(off).toBeVisible();
			await expect(page.getByText(o.body).first()).toBeVisible();
			// The load report waits for the machine (no beacon into the void).
			await expect
				.poll(() =>
					page.evaluate(() =>
						(
							JSON.parse(
								sessionStorage.getItem("pulsar:load-errors") || "[]",
							) as string[]
						).map((b) => JSON.parse(b).kind),
					),
				)
				.toContain("chunk");
			expect(seen).toEqual({ loads: 0, failed: false });

			await backOnTailnet(page);
			// Back into the screen it was on, in the current build: one reload.
			await expect(o.lazyShown(page)).toBeVisible();
			expect(seen).toEqual({ loads: 1, failed: false });
			await expect
				.poll(async () =>
					(await loadReports(request)).map((r) => r.report.kind),
				)
				.toContain("chunk");
			excuseCutRequests(errors);
		});

		test("an app that can't load at all says the machine is unreachable, then starts by itself", async ({
			page,
			errors,
		}) => {
			// A visit before: the machine's name is known.
			await page.goto("/");
			await expect(o.home(page)).toBeVisible();
			const seen = await watch(page);

			// The stylesheet stays (the service worker's copy), the scripts fail.
			await goOffTailnet(page, /\/_app\/.*\.js$/);
			await page.reload();
			// The boot screen; or, when the browser ran the entry from its
			// memory cache, the app's own.
			const screen = page
				.locator("#boot-offline:not([hidden]), .st-fail")
				.first();
			await expect(screen).toBeVisible();
			await expect(screen).toContainText(o.title, { useInnerText: true });
			await expect(screen).toContainText(o.body, { useInnerText: true });

			await backOnTailnet(page);
			await expect(o.home(page)).toBeVisible();
			// The test's reload, then the one into the app: never the error screen.
			expect(seen).toEqual({ loads: 2, failed: false });
			excuseCutRequests(errors);
		});

		test("an event stream that can't reconnect says the machine is unreachable, then recovers by itself", async ({
			page,
			request,
			errors,
		}) => {
			await page.goto("/");
			await expect(o.home(page)).toBeVisible();
			await settled(page);
			await o.openLazy(page);
			await expect(o.lazyShown(page)).toBeVisible();
			const seen = await watch(page);

			await goOffTailnet(page, false);
			// The open stream ends (as when the network goes); reconnects fail.
			await request.post("/api/v1/__mock/restart", { headers: H });
			await expect(
				page.getByText(o.title, { exact: true }).first(),
			).toBeVisible();
			await expect(page.getByText(o.body).first()).toBeVisible();

			await backOnTailnet(page);
			// Back on the screen it was on.
			await expect(o.lazyShown(page)).toBeVisible();
			await expect(page.getByText(o.title, { exact: true })).toHaveCount(0);
			// In place: no reload, no failure screen.
			expect(seen).toEqual({ loads: 0, failed: false });
			excuseCutRequests(errors);
		});
	});
}
