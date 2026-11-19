/**
 * Load-path benchmark: how long the app takes to show the machine tree and
 * agent rows, on a real throwaway daemon (web/e2e/real/daemon.ts: temp HOME
 * and PULSAR_HOME, scanners off, fake agents) behind a latency proxy.
 *
 *   bun web/scripts/listperf.ts [--rtt 150] [--runs 3] [--out file.json]
 *
 * Profiles: desktop Chromium and WebKit "iPhone 13 Mini"; cold (fresh
 * context) and warm (a reload in the same context: HTTP cache, service
 * worker, localStorage); with and without 4x CPU throttling (Chromium, CDP).
 * The proxy delays every chunk by RTT/2 each way (TCP-level, so connection
 * setup pays the RTT too); it works for WebKit, which has no CDP throttling.
 * Marks come from the page itself (performance.now() when the first row
 * appears) and requests from Resource Timing, all relative to navigation.
 */
import { writeFileSync } from "node:fs";
import { chromium, devices, webkit } from "@playwright/test";
import {
	arg,
	DAEMON_PORT,
	PROXY_PORT,
	startDaemon,
	startProxy,
} from "./perf-harness.ts";

const RTT = Number(arg("rtt", "150"));
const RUNS = Number(arg("runs", "3"));
const OUT = arg("out", "");
const ONLY = arg("only", "");
// --tls: the daemon's HTTPS server (HTTP/2; --h1: HTTP/1.1 only).
const TLS = process.argv.includes("--tls");
const H1 = process.argv.includes("--h1");
const TLS_PORT = DAEMON_PORT + 2;
const MARKS = `
(() => {
	performance.setResourceTimingBufferSize(5000);
	const marks = {};
	const check = () => {
		const at = performance.now();
		const vis = (sel) => {
			for (const el of document.querySelectorAll(sel)) {
				const r = el.getBoundingClientRect();
				if (r.width > 0 && r.height > 0) return true;
			}
			return false;
		};
		if (!marks.tree && vis('[data-node^="m:"]')) marks.tree = at;
		if (!marks.children && vis('[data-node*="/p:"]')) marks.children = at;
		if (!marks.agent && vis('[data-agent], .d-card-row')) marks.agent = at;
		if (!marks.shell && vis('.boot-shell, .shell-skeleton, ion-app')) marks.shell = at;
	};
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true });
	const tick = () => { check(); if (!(marks.tree && marks.agent && marks.children)) requestAnimationFrame(tick); };
	requestAnimationFrame(tick);
	window.__marks = marks;
})();
`;

interface Run {
	profile: string;
	visit: "cold" | "warm";
	cpu: number;
	marks: Record<string, number>;
	requests: Array<{
		name: string;
		start: number;
		ttfb: number;
		end: number;
	}>;
}

async function measure(
	profile: "desktop" | "phone",
	cpu: number,
): Promise<Run[]> {
	const browserType = profile === "desktop" ? chromium : webkit;
	const browser = await browserType.launch();
	const context = await browser.newContext({
		...(profile === "desktop"
			? { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
			: devices["iPhone 13 Mini"]),
		baseURL: TLS
			? `https://localhost:${PROXY_PORT}`
			: `http://127.0.0.1:${PROXY_PORT}`,
		ignoreHTTPSErrors: TLS,
		serviceWorkers: "allow",
	});
	await context.addInitScript(MARKS);
	const out: Run[] = [];
	for (const visit of ["cold", "warm"] as const) {
		// Warm: a new page in the same context (HTTP cache, the service
		// worker the cold visit installed, localStorage).
		const page = await context.newPage();
		if (cpu > 1 && profile === "desktop") {
			const cdp = await context.newCDPSession(page);
			await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
		}
		await page.goto("/");
		await page
			.waitForFunction(
				() => {
					const m = (window as unknown as { __marks: Record<string, number> })
						.__marks;
					return m?.tree && m.agent;
				},
				undefined,
				{ timeout: 60_000 },
			)
			.catch(async (e) => {
				await page.screenshot({
					path: `${process.env.LISTPERF_DEBUG ?? "/tmp"}/listperf-${profile}.png`,
				});
				console.error(
					await page.evaluate(() =>
						JSON.stringify((window as unknown as { __marks: unknown }).__marks),
					),
				);
				throw e;
			});
		await page
			.waitForFunction(
				() =>
					(window as unknown as { __marks: Record<string, number> }).__marks
						.children,
				undefined,
				{ timeout: 5000 },
			)
			.catch(() => {});
		// Let late requests (children, stream) land in Resource Timing.
		await page.waitForTimeout(300);
		if (visit === "cold")
			// The last-screen snapshot is written a second after the screen settles.
			await page
				.waitForFunction(
					() => localStorage.getItem("pulsar.snapshot"),
					undefined,
					{
						timeout: 5000,
					},
				)
				.catch(() => {});
		if (visit === "cold")
			// The service worker installs (precache) before the warm visit.
			await page
				.waitForFunction(
					async () => Boolean((await navigator.serviceWorker?.ready)?.active),
					undefined,
					{ timeout: 20_000 },
				)
				.catch(() => {});
		const r = await page.evaluate(() => {
			const marks = (window as unknown as { __marks: Record<string, number> })
				.__marks;
			const requests = (
				performance.getEntriesByType("resource") as PerformanceResourceTiming[]
			).map((e) => ({
				name: new URL(e.name).pathname + new URL(e.name).search,
				start: Math.round(e.startTime),
				ttfb: Math.round(e.responseStart || e.startTime),
				end: Math.round(e.responseEnd),
			}));
			const nav = performance.getEntriesByType(
				"navigation",
			)[0] as PerformanceNavigationTiming;
			requests.unshift({
				name: "(document)",
				start: 0,
				ttfb: Math.round(nav.responseStart),
				end: Math.round(nav.responseEnd),
			});
			return { marks: { ...marks }, requests };
		});
		out.push({
			profile,
			visit,
			cpu,
			marks: Object.fromEntries(
				Object.entries(r.marks).map(([k, v]) => [k, Math.round(v as number)]),
			),
			requests: r.requests,
		});
		await page.close();
	}
	await browser.close();
	return out;
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)] ?? Number.NaN;
};

const daemon = await startDaemon(
	TLS
		? {
				PULSAR_REAL_TLS_PORT: String(TLS_PORT),
				PULSAR_REAL_TLS_HOSTS: `localhost:${PROXY_PORT}`,
				PULSAR_REAL_TLS_H1: H1 ? "1" : "0",
			}
		: {},
);
const proxy = await startProxy(RTT / 2, TLS ? TLS_PORT : DAEMON_PORT);
const all: Run[] = [];
try {
	const configs: Array<["desktop" | "phone", number]> = [
		["desktop", 1],
		["desktop", 4],
		["phone", 1],
	];
	for (const [profile, cpu] of configs) {
		if (ONLY && !`${profile}x${cpu}`.includes(ONLY)) continue;
		for (let i = 0; i < RUNS; i++) all.push(...(await measure(profile, cpu)));
	}
} finally {
	proxy.close();
	daemon.kill("SIGTERM");
}

console.log(`RTT ${RTT} ms, ${RUNS} runs each, medians (ms from navigation):`);
console.log("profile          visit  shell   tree  children  agent");
const groups = new Map<string, Run[]>();
for (const r of all) {
	const k = `${r.profile} cpu${r.cpu}x|${r.visit}`;
	groups.set(k, [...(groups.get(k) ?? []), r]);
}
for (const [k, rs] of groups) {
	const [p, v] = k.split("|");
	const m = (n: string) =>
		String(median(rs.map((r) => r.marks[n] ?? Number.NaN)));
	console.log(
		`${p!.padEnd(16)} ${v!.padEnd(5)} ${m("shell").padStart(6)} ${m("tree").padStart(6)} ${m("children").padStart(9)} ${m("agent").padStart(6)}`,
	);
}
// One waterfall per group (the last run): what started when.
for (const [k, rs] of groups) {
	const r = rs[rs.length - 1]!;
	console.log(
		`\n${k}  tree=${r.marks.tree} children=${r.marks.children} agent=${r.marks.agent}`,
	);
	for (const q of r.requests
		.filter((q) => q.start <= (r.marks.agent ?? 0) + 50 || /api/.test(q.name))
		.slice(0, 40))
		console.log(
			`  ${String(q.start).padStart(5)} → ${String(q.end).padStart(5)}  ${q.name.slice(0, 70)}`,
		);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ rtt: RTT, runs: all }, null, 1));
process.exit(0);
