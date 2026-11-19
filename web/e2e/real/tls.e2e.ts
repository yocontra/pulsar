import type { Hello } from "../../src/api/types.ts";
import { expect, test } from "../fixtures.ts";

/**
 * The app over the daemon's HTTPS server, as on a real node (there with
 * Tailscale's certificate; here a throwaway one for localhost): HTTP/2 for
 * the page, its chunks, the API and the event stream, with the Host
 * (:authority) and Origin checks passing.
 */
const TLS = `https://localhost:${process.env.PULSAR_REAL_TLS_PORT}`;
const CONTROL = `http://127.0.0.1:${Number(process.env.PULSAR_REAL_CONTROL_PORT ?? Number(process.env.PULSAR_REAL_PORT ?? 47392) + 1)}`;

test.use({ ignoreHTTPSErrors: true });

test("the app loads and stays live over HTTP/2 @real", async ({
	page,
	request,
}) => {
	const h = (await (
		await request.get(`${TLS}/api/v1/hello`, { headers: { "X-Pulsar": "1" } })
	).json()) as Hello;
	await page.goto(`${TLS}/`);
	await expect(page.locator(`[data-node="m:${h.machineId}"]`)).toBeVisible();
	const protocols = await page.evaluate(() => {
		const nav = performance.getEntriesByType(
			"navigation",
		)[0] as PerformanceNavigationTiming;
		const api = (
			performance.getEntriesByType("resource") as PerformanceResourceTiming[]
		).filter((e) => e.name.includes("/api/v1/"));
		return {
			nav: nav.nextHopProtocol,
			api: [...new Set(api.map((e) => e.nextHopProtocol))],
		};
	});
	expect(protocols.nav).toBe("h2");
	expect(protocols.api).toEqual(["h2"]);
	// The event stream works over the same connection: a live transcript line.
	const { fixer } = (await (await request.get(`${CONTROL}/agents`)).json()) as {
		fixer: string;
	};
	await page.goto(`${TLS}/#/a/${encodeURIComponent(fixer)}`);
	await expect(page.locator(".session-header h1")).toHaveText("fixer");
	await expect(page.locator(".d-app")).toBeVisible();
	const text = `over h2 ${Date.now()}`;
	await request.post(`${CONTROL}/append?text=${encodeURIComponent(text)}`);
	await expect(page.getByText(text)).toBeVisible({ timeout: 10_000 });
});
