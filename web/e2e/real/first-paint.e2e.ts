import type { Hello } from "../../src/api/types.ts";
import { expect, test } from "../fixtures.ts";
import { revisitPaintsFromSnapshot } from "./first-paint.shared.ts";

/**
 * The load path against the real daemon: the first reads start while the
 * app's JS still downloads (public/preload.js), boot asks for each of them
 * once, and a revisit paints the last screen before the network answers
 * (src/lib/snapshot.ts).
 */

const H = { "X-Pulsar": "1" };
const READS = [
	"/api/v1/hello",
	"/api/v1/tree?",
	"/api/v1/attention",
	"/api/v1/recent",
];

test.describe("load path @real", () => {
	test("the first reads start before the app's JS has loaded, each once @real", async ({
		page,
		request,
	}) => {
		const h = (await (
			await request.get("/api/v1/hello", { headers: H })
		).json()) as Hello;
		// The app's JS is slow to arrive; the reads must not wait for it.
		await page.route("**/_app/*.js", async (route) => {
			await new Promise((ok) => setTimeout(ok, 400));
			await route.continue();
		});
		const events: string[] = [];
		const seen: string[] = [];
		page.on("request", (r) => {
			const u = new URL(r.url());
			const path = u.pathname + u.search;
			if (path.startsWith("/api/v1/")) {
				seen.push(path);
				events.push(`request ${path}`);
			}
		});
		page.on("requestfinished", (r) => {
			if (/\/_app\/.*\.js$/.test(r.url())) events.push("app js loaded");
		});
		await page.goto("/");
		await expect(page.locator(`[data-node="m:${h.machineId}"]`)).toBeVisible();
		const firstJs = events.indexOf("app js loaded");
		for (const read of READS) {
			const i = events.findIndex((e) => e.startsWith(`request ${read}`));
			expect(i, `${read} requested`).toBeGreaterThanOrEqual(0);
			expect(i, `${read} before any app JS loaded`).toBeLessThan(firstJs);
			// Boot asks once (the app took the preloaded response).
			expect(
				seen.filter((p) => p.startsWith(read)),
				`${read} once`,
			).toHaveLength(1);
		}
		// A first visit: the open machine's projects came with the tree.
		expect(seen.find((p) => p.startsWith("/api/v1/tree?"))).toContain(
			"expand=default",
		);
		await expect(
			page.locator(`[data-node="m:${h.machineId}/p:demo"]`),
		).toBeVisible();
		expect(seen.filter((p) => p.includes("/children"))).toEqual([]);
	});

	test("a revisit paints the last screen before the network answers (desktop) @real", async ({
		page,
		request,
	}) => {
		await revisitPaintsFromSnapshot(page, request);
	});
});

test.describe("session open @real", () => {
	test("a session's messages don't wait for its subscription round trip @real", async ({
		page,
		request,
	}) => {
		const ids = (await (
			await request.get(
				`http://127.0.0.1:${Number(process.env.PULSAR_REAL_CONTROL_PORT ?? Number(process.env.PULSAR_REAL_PORT ?? 47392) + 1)}/agents`,
			)
		).json()) as { fixer: string };
		await page.goto("/");
		await expect(page.locator(".d-card-row").first()).toBeVisible();
		// Every subscription change answers 3 s late from here on.
		let held = 0;
		await page.route("**/api/v1/subscriptions/*", async (route) => {
			held++;
			await new Promise((ok) => setTimeout(ok, 3000));
			await route.continue().catch(() => {});
		});
		const pages: string[] = [];
		page.on("request", (r) => {
			if (r.url().includes("/transcript")) pages.push(r.url());
		});
		const start = Date.now();
		await page.goto(`/#/a/${encodeURIComponent(ids.fixer)}`);
		await expect(
			page.locator(".ds-turn--assistant").filter({ hasText: /\w/ }).first(),
		).toBeVisible({ timeout: 2500 });
		expect(Date.now() - start).toBeLessThan(2500);
		// The subscription went out too, and is still held.
		await expect.poll(() => held).toBeGreaterThan(0);
		// The page subscribed the open stream itself.
		expect(pages[0]).toContain("stream=");
	});
});
