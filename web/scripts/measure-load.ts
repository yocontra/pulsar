/**
 * Bytes over the wire and timings for a cold first load and a warm reload of
 * the built app (dist/web), served by a real pulsar daemon (web/e2e/real/
 * daemon.ts: temp HOME and PULSAR_HOME, scanners off).
 *
 *   bun web/scripts/measure-load.ts            # unthrottled
 *   bun web/scripts/measure-load.ts --slow     # 400 kbps, 400 ms RTT
 *
 * Counts the encoded (compressed) body and header bytes of every non-API
 * request, the service worker's own fetches included (a response the
 * browser took from its HTTP cache counts as 0 body bytes). Runs twice: with the service worker blocked (HTTP caching only)
 * and allowed (the second reload is served by the service worker).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";

const slow = process.argv.includes("--slow");

function freePort(): Promise<number> {
	return new Promise((ok) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const a = s.address();
			s.close(() => ok(typeof a === "object" && a ? a.port : 0));
		});
	});
}

const port = await freePort();
const control = await freePort();
const daemon = spawn(
	process.execPath,
	[resolve(import.meta.dirname, "../e2e/real/daemon.ts")],
	{
		env: {
			...process.env,
			PULSAR_REAL_PORT: String(port),
			PULSAR_REAL_CONTROL_PORT: String(control),
			PULSAR_NO_SCAN: "1",
		},
		stdio: "ignore",
	},
);
const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
	try {
		if ((await fetch(`${base}/api/v1/hello`)).ok) break;
	} catch {}
	if (i > 200) throw new Error("daemon did not start");
	await new Promise((r) => setTimeout(r, 100));
}
const hello = (await (await fetch(`${base}/api/v1/hello`)).json()) as {
	machineId: string;
};

const browser = await chromium.launch();
try {
	for (const sw of ["block", "allow"] as const) {
		const context = await browser.newContext({ serviceWorkers: sw });
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Network.enable");
		if (slow)
			await cdp.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: 400,
				downloadThroughput: 50_000,
				uploadThroughput: 50_000,
			});
		// Page and service worker requests (Chromium reports both on the
		// context); a page request answered by the service worker cost nothing
		// on the wire, its own fetch (if any) is counted instead.
		let bytes = 0;
		let requests = 0;
		const pending: Promise<void>[] = [];
		context.on("requestfinished", (req) => {
			if (new URL(req.url()).pathname.startsWith("/api/")) return;
			pending.push(
				(async () => {
					const res = await req.response();
					if (!res || res.fromServiceWorker()) return;
					const sizes = await req.sizes();
					bytes += sizes.responseBodySize + sizes.responseHeadersSize;
					requests++;
				})(),
			);
		});
		const machine = page.locator(`[data-node="m:${hello.machineId}"]`);
		const run = async (label: string, go: () => Promise<unknown>) => {
			bytes = 0;
			requests = 0;
			const t0 = Date.now();
			await go();
			await machine.waitFor({ timeout: 120_000 });
			const ms = Date.now() - t0;
			await page.waitForTimeout(1500);
			await Promise.all(pending.splice(0));
			console.log(
				`${`sw ${sw}`.padEnd(9)} ${label.padEnd(9)} ${(bytes / 1024).toFixed(1).padStart(7)} KB in ${String(requests).padStart(2)} requests, app in ${ms} ms`,
			);
		};
		await run("cold", () => page.goto(`${base}/`));
		await run("reload", () => page.reload());
		await run("reload 2", () => page.reload());
		await context.close();
	}
} finally {
	await browser.close();
	daemon.kill();
}
