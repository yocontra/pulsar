import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { current, DIST, serve, stageBuild } from "./builds.ts";
import { expect, test } from "./fixtures.ts";

/**
 * First load on a slow network, failed chunk downloads, service worker
 * build changes, and the static file headers (the mock serves dist/web
 * through the daemon's src/transport/static.ts).
 */

const H = { "X-Pulsar": "1" };
const app = (page: Page) => page.locator('[data-node="m:studio"]');
const errorScreen = (page: Page) => page.locator("#boot-error");

/** The biggest hashed script in the build (always precompressed). */
function largestScript() {
	const dir = join(DIST, "_app");
	const [name] = readdirSync(dir)
		.filter((f) => f.endsWith(".js"))
		.sort((a, b) => statSync(join(dir, b)).size - statSync(join(dir, a)).size);
	return `/_app/${name}`;
}

/** Drop the expected failed-download noise from the console-error check. */
function allow(errors: string[], re: RegExp) {
	const keep = errors.filter((e) => !re.test(e));
	errors.splice(0, errors.length, ...keep);
}
const DOWNLOAD_ERRORS =
	/Failed to load resource|dynamically imported module|Unable to preload/;

const usage = (page: Page) => page.getByRole("main", { name: "Usage" });
const screenFailed = (page: Page) => page.getByText("This screen didn't load");
/** Opens the usage page: a lazy chunk the first screen never loads. */
const openUsage = (page: Page) =>
	page.evaluate(() => {
		location.hash = "#/usage";
	});
/** Counts full page loads (not hash changes) from now on. */
function countLoads(page: Page) {
	const n = { loads: 0 };
	page.on("load", () => n.loads++);
	return n;
}

const loadedEntry = (page: Page) =>
	page.evaluate(() =>
		document.querySelector('script[type="module"]')?.getAttribute("src"),
	);
const cacheNames = (page: Page) => page.evaluate(() => caches.keys());

/** Waits until a service worker controls the page. */
async function controlled(page: Page) {
	await page.evaluate(async () => {
		await navigator.serviceWorker.ready;
		if (navigator.serviceWorker.controller) return;
		await new Promise((ok) =>
			navigator.serviceWorker.addEventListener("controllerchange", ok, {
				once: true,
			}),
		);
	});
}

async function throttle(context: BrowserContext, page: Page) {
	const cdp = await context.newCDPSession(page);
	await cdp.send("Network.enable");
	// ~400 kbps with a 400 ms round trip: a phone on a poor cellular link.
	await cdp.send("Network.emulateNetworkConditions", {
		offline: false,
		latency: 400,
		downloadThroughput: 50_000,
		uploadThroughput: 50_000,
	});
}

test.describe("first load", () => {
	test("a slow network shows the loading screen, then the app", async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await throttle(context, page);
		await page.goto("/", { waitUntil: "commit" });
		// The static shell's loading screen is up before any JS has run.
		await expect(page.getByText("Loading pulsar")).toBeVisible({
			timeout: 15_000,
		});
		await expect(app(page)).toBeVisible({ timeout: 60_000 });
		await expect(errorScreen(page)).toBeHidden();
	});

	test("without JavaScript the shell still shows the loading screen", async ({
		browser,
	}) => {
		const context = await browser.newContext({ javaScriptEnabled: false });
		const page = await context.newPage();
		await page.goto("/");
		await expect(page.getByText("Loading pulsar")).toBeVisible();
		await context.close();
	});

	test("an entry chunk that fails once reloads by itself", async ({
		page,
		errors,
	}) => {
		let requests = 0;
		await page.route(/\/_app\/index\.astro_[^/]+\.js$/, (route) =>
			requests++ === 0
				? route.fulfill({ status: 503, body: "busy" })
				: route.continue(),
		);
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		expect(requests).toBe(2);
		await expect(errorScreen(page)).toBeHidden();
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("a lazy chunk that fails once reloads by itself", async ({
		page,
		errors,
	}) => {
		let requests = 0;
		await page.route(/\/_app\/DesktopApp\.[^/]+\.js$/, (route) =>
			requests++ === 0 ? route.abort("failed") : route.continue(),
		);
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		expect(requests).toBe(2);
		await expect(errorScreen(page)).toBeHidden();
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("a screen whose chunk fails once in a running app recovers by itself", async ({
		page,
		errors,
	}) => {
		let requests = 0;
		await page.route(/\/_app\/UsageView\.[^/]+\.js$/, (route) =>
			requests++ === 0 ? route.abort("failed") : route.continue(),
		);
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		let failedShown = false;
		await page.exposeFunction("__sawFailure", () => {
			failedShown = true;
		});
		await page.addInitScript(() => {
			new MutationObserver(() => {
				if (document.querySelector(".st-fail"))
					(window as unknown as { __sawFailure: () => void }).__sawFailure();
			}).observe(document, { childList: true, subtree: true });
		});
		await page.evaluate(() => {
			new MutationObserver(() => {
				if (document.querySelector(".st-fail"))
					(window as unknown as { __sawFailure: () => void }).__sawFailure();
			}).observe(document, { childList: true, subtree: true });
		});
		const n = countLoads(page);
		await openUsage(page);
		await expect(usage(page)).toBeVisible();
		// One reload, into a screen that loads; never the failure screen.
		expect(n.loads).toBe(1);
		expect(requests).toBeGreaterThanOrEqual(2);
		expect(failedShown).toBe(false);
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("an app error from a dynamic import does not reload, and a working app is never covered", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		let navigations = 0;
		page.on("framenavigated", (f) => {
			if (f === page.mainFrame()) navigations++;
		});
		const preloadError = (message: string, name: string) =>
			page.evaluate(
				([message, name]) => {
					const e = new Event("vite:preloadError", { cancelable: true });
					Object.assign(e, { payload: new DOMException(message, name) });
					dispatchEvent(e);
				},
				[message, name] as const,
			);
		// Vite fires this for any rejected import, e.g. a passkey prompt the
		// app handles itself.
		await preloadError("127.0.0.1 is an invalid domain", "SecurityError");
		await page.waitForTimeout(700);
		expect(navigations).toBe(0);
		// A real download failure after the one automatic retry was spent:
		// the lazy view shows its Retry, the overlay stays hidden.
		await page.evaluate(() =>
			sessionStorage.setItem("pulsar:boot-retry", String(Date.now())),
		);
		await preloadError(
			"Failed to fetch dynamically imported module: /_app/x.js",
			"TypeError",
		);
		await page.waitForTimeout(700);
		expect(navigations).toBe(0);
		await expect(errorScreen(page)).toBeHidden();
		await expect(app(page)).toBeVisible();
	});

	test("a chunk that keeps failing shows the error screen; Retry recovers", async ({
		page,
		errors,
	}) => {
		let failing = true;
		let requests = 0;
		await page.route(/\/_app\/index\.astro_[^/]+\.js$/, (route) => {
			requests++;
			return failing
				? route.fulfill({ status: 503, body: "busy" })
				: route.continue();
		});
		await page.goto("/");
		await expect(errorScreen(page)).toBeVisible();
		await expect(page.getByText("pulsar didn't load")).toBeVisible();
		// One automatic retry before the error screen.
		expect(requests).toBe(2);
		failing = false;
		await page.getByRole("button", { name: "Retry" }).click();
		await expect(app(page)).toBeVisible();
		await expect(errorScreen(page)).toBeHidden();
		allow(errors, DOWNLOAD_ERRORS);
	});
});

test.describe("after a deploy", () => {
	const NO_UPDATE = "none";

	test("an open app on the old build still loads its lazy screens", async ({
		page,
		request,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		// Deploy: the server runs the current build; build A stays installed
		// next to it, as \`pulsar setup\` keeps older builds.
		await serve(request, { previous: [a.root], webBuild: NO_UPDATE });
		const n = countLoads(page);
		const fromA: number[] = [];
		page.on("response", (r) => {
			if (/\/_app\/UsageView\.[^/]+\.old\.js$/.test(r.url()))
				fromA.push(r.status());
		});
		await openUsage(page);
		await expect(usage(page)).toBeVisible();
		// Build A's own chunk, from A's folder: no reload, no failure screen.
		expect(fromA).toEqual([200]);
		expect(n.loads).toBe(0);
		expect(await loadedEntry(page)).toBe(a.entry);
		await expect(screenFailed(page)).toHaveCount(0);
		await expect(errorScreen(page)).toBeHidden();
	});
});

test.describe("service worker", () => {
	test.use({ serviceWorkers: "allow" });
	test.setTimeout(60_000);
	// These follow the worker alone: /hello reports no build id, so the app
	// doesn't reload itself into the new build (src/data/update.ts) mid-test.
	const NO_UPDATE = "none";

	test("a phone on the old pulsar-shell-v2 worker gets the current build", async ({
		page,
		request,
		errors,
	}) => {
		const old = stageBuild({ legacySw: true });
		await serve(request, { root: old.root, webBuild: NO_UPDATE });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		await controlled(page);
		await page.reload();
		await expect(app(page)).toBeVisible();
		expect(await cacheNames(page)).toEqual(["pulsar-shell-v2"]);

		// Deploy: the server has only the current build now.
		await serve(request, { webBuild: NO_UPDATE });
		await page.reload();
		await expect(app(page)).toBeVisible();
		expect(await loadedEntry(page)).toBe(current().entry);
		await expect
			.poll(() => cacheNames(page), { timeout: 15_000 })
			.toEqual(["pulsar-shell-v2", `pulsar-shell-${current().build}`]);
		await page.reload();
		await expect(app(page)).toBeVisible();
		expect(await loadedEntry(page)).toBe(current().entry);
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("a slow network gets the cached shell of the same build, then the deploy", async ({
		page,
		request,
		errors,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		await controlled(page);
		await expect
			.poll(() => cacheNames(page))
			.toEqual([`pulsar-shell-${a.build}`]);

		// The server moves to the current build and its HTML stalls: after
		// 3 s the worker answers with build A's shell and A's own assets.
		await serve(request, { htmlDelayMs: 8_000, webBuild: NO_UPDATE });
		const t0 = Date.now();
		await page.reload();
		await expect(app(page)).toBeVisible();
		expect(Date.now() - t0).toBeLessThan(7_000);
		expect(await loadedEntry(page)).toBe(a.entry);

		// The network recovers: the current build takes over.
		await serve(request, { webBuild: NO_UPDATE });
		await page.reload();
		await expect(app(page)).toBeVisible();
		await expect
			.poll(async () => {
				await page.reload();
				return loadedEntry(page);
			})
			.toBe(current().entry);
		await expect
			.poll(() => cacheNames(page), { timeout: 15_000 })
			.toEqual([`pulsar-shell-${a.build}`, `pulsar-shell-${current().build}`]);
		await expect(errorScreen(page)).toBeHidden();
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("a cached shell whose asset is gone reloads from the network", async ({
		page,
		context,
		request,
		errors,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		await controlled(page);
		await expect
			.poll(() => cacheNames(page))
			.toEqual([`pulsar-shell-${a.build}`]);
		// Build A's layout chunk is not in the cache (as for any lazy chunk).
		await page.evaluate(async (name) => {
			const cache = await caches.open(name);
			for (const req of await cache.keys())
				if (/DesktopApp/.test(req.url)) await cache.delete(req);
		}, `pulsar-shell-${a.build}`);
		// ...and not in the HTTP cache either.
		const cdp = await context.newCDPSession(page);
		await cdp.send("Network.clearBrowserCache");

		// The server moved on and its HTML is slow: the worker serves A's
		// shell, A's layout 404s, and the page reloads once from the network.
		await serve(request, { htmlDelayMs: 4_000, webBuild: NO_UPDATE });
		// The boot guard's own reload supersedes this one.
		await page.reload().catch((e: Error) => {
			if (!/ERR_ABORTED/.test(e.message)) throw e;
		});
		await expect(app(page)).toBeVisible({ timeout: 30_000 });
		expect(await loadedEntry(page)).toBe(current().entry);
		await expect(errorScreen(page)).toBeHidden();
		allow(errors, DOWNLOAD_ERRORS);
	});

	test("a cached shell of an older build loads its lazy screens from the cache", async ({
		page,
		request,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root, webBuild: NO_UPDATE });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		await controlled(page);
		await expect
			.poll(() => cacheNames(page))
			.toEqual([`pulsar-shell-${a.build}`]);

		// Deploy with no older builds kept, and the HTML stalls: after 3 s
		// the worker serves build A's shell, and none of A's files are on
		// the server any more.
		await serve(request, { htmlDelayMs: 8_000, webBuild: NO_UPDATE });
		await page.reload();
		await expect(app(page)).toBeVisible();
		expect(await loadedEntry(page)).toBe(a.entry);
		const n = countLoads(page);
		await openUsage(page);
		await expect(usage(page)).toBeVisible();

		// The held HTML arrives and the current build's worker takes over the
		// page, which still runs build A: A's cache stays for it.
		await expect
			.poll(
				() =>
					page.evaluate(async (name) => {
						const reg = await navigator.serviceWorker.getRegistration();
						// caches.open would create it: look first.
						const shell =
							(await caches.has(name)) &&
							(await (await caches.open(name)).match("/"));
						return !!shell && !reg?.installing && !reg?.waiting;
					}, `pulsar-shell-${current().build}`),
				{ timeout: 20_000 },
			)
			.toBe(true);
		await expect
			.poll(() => cacheNames(page), { timeout: 20_000 })
			.toEqual([`pulsar-shell-${a.build}`, `pulsar-shell-${current().build}`]);
		await page.evaluate(() => {
			location.hash = "#/diagnostics";
		});
		await expect(page.getByRole("main", { name: "Diagnostics" })).toBeVisible();
		expect(n.loads).toBe(0);
		expect(await loadedEntry(page)).toBe(a.entry);
		await expect(screenFailed(page)).toHaveCount(0);
		await expect(errorScreen(page)).toBeHidden();
	});

	test("an open app reloads itself into the new build after a daemon restart", async ({
		page,
		request,
		errors,
	}) => {
		const a = stageBuild();
		await serve(request, { root: a.root });
		await page.goto("/");
		await expect(app(page)).toBeVisible();
		await controlled(page);
		await expect
			.poll(() => cacheNames(page))
			.toEqual([`pulsar-shell-${a.build}`]);

		// Upgrade and restart: the stream drops and /hello names the new build.
		await serve(request);
		const restart = await request.post("/api/v1/__mock/restart", {
			headers: H,
		});
		expect(restart.ok()).toBe(true);
		// The worker installs the new build first, then the page reloads.
		await expect
			.poll(() => loadedEntry(page).catch(() => null), { timeout: 30_000 })
			.toBe(current().entry);
		await expect(app(page)).toBeVisible();
		await expect
			.poll(() => cacheNames(page).catch(() => []), { timeout: 15_000 })
			.toEqual([`pulsar-shell-${a.build}`, `pulsar-shell-${current().build}`]);
		await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
		allow(errors, DOWNLOAD_ERRORS);
	});
});

test("static headers: compressed, immutable /_app/, no-cache HTML and sw.js", async ({
	request,
}) => {
	const index = await request.get("/", {
		headers: { "Accept-Encoding": "gzip, br" },
	});
	const h = index.headers();
	expect(h["content-encoding"]).toBe("br");
	expect(h.vary).toBe("Accept-Encoding");
	expect(h["cache-control"]).toBe("no-cache");
	expect(h["content-security-policy"]).toContain("script-src 'self'");
	expect(await index.text()).toContain('<script src="/boot.js" defer>');

	// The entry module can be a few bytes (it only imports the app chunk), and
	// files under 1 KB are not precompressed; check the largest build script.
	const script = largestScript();
	const js = await request.get(script, {
		headers: { "Accept-Encoding": "gzip" },
	});
	expect(js.headers()["content-encoding"]).toBe("gzip");
	expect(js.headers()["cache-control"]).toBe(
		"public, max-age=31536000, immutable",
	);
	const etag = js.headers().etag!;
	const again = await request.get(script, {
		headers: { "Accept-Encoding": "gzip", "If-None-Match": etag },
	});
	expect(again.status()).toBe(304);

	for (const path of ["/sw.js", "/boot.js", "/manifest.webmanifest"])
		expect((await request.get(path)).headers()["cache-control"]).toBe(
			"no-cache",
		);
	const sw = await (await request.get("/sw.js")).text();
	expect(sw).toContain(`const BUILD = "${current().build}"`);
	expect(sw).not.toContain("__PULSAR_");
	expect(
		(await request.get("/_app/missing.js")).headers()["cache-control"] ?? "",
	).not.toContain("immutable");
	expect(
		(await request.get("/api/v1/hello", { headers: H })).headers()[
			"cache-control"
		],
	).toBe("no-store");
});
