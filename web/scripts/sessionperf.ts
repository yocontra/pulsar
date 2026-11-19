/**
 * Session-open benchmark: how long opening an agent's chat takes until the
 * first message, the header and the composer show, on a real throwaway
 * daemon behind a latency proxy (perf-harness.ts).
 *
 *   bun web/scripts/sessionperf.ts --log <claude.jsonl> [--rtt 150] [--runs 3] [--out f.json]
 *
 * The agent is "bigchat", a Claude session copied from --log (a long real
 * log times parsing and rendering honestly). Per profile (desktop Chromium,
 * WebKit iPhone 13 Mini): a deep link cold (fresh context) and warm (new page,
 * same context), then a tap from the home screen with the app loaded.
 */
import { writeFileSync } from "node:fs";
import { chromium, devices, type Page, webkit } from "@playwright/test";
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
const LOG = arg("log", "");
const ONLY = arg("only", "");
if (!LOG) throw new Error("--log <claude transcript.jsonl> is required");

const MARKS = `
(() => {
	performance.setResourceTimingBufferSize(5000);
	window.__marks = {};
	window.__t0 = 0;
	const vis = (sel) => {
		for (const el of document.querySelectorAll(sel)) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) return true;
		}
		return false;
	};
	// A message with text (the loading skeleton's turns are empty).
	const text = (sel) => {
		for (const el of document.querySelectorAll(sel)) {
			const r = el.getBoundingClientRect();
			if (r.width > 0 && r.height > 0 && el.textContent.trim()) return true;
		}
		return false;
	};
	const check = () => {
		const m = window.__marks;
		const at = performance.now() - window.__t0;
		if (!m.first && text('.ds-turn--assistant, .ds-turn--user')) m.first = at;
		if (!m.header && vis('.session-header h1, .p-agent-header .p-nav-title')) m.header = at;
		if (!m.composer && vis('.composer-input')) m.composer = at;
	};
	new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
	const tick = () => { check(); requestAnimationFrame(tick); };
	requestAnimationFrame(tick);
})();
`;

type Marks = Record<string, number>;
interface Run {
	profile: string;
	visit: string;
	marks: Marks;
	requests: Array<{ name: string; start: number; end: number }>;
}

const ready = (page: Page) =>
	page.waitForFunction(
		() => {
			const m = (window as unknown as { __marks: Marks }).__marks;
			return m.first && m.header && m.composer;
		},
		undefined,
		{ timeout: 60_000 },
	);

async function collect(page: Page, since = 0) {
	await page.waitForTimeout(300);
	return page.evaluate((since) => {
		const marks = (window as unknown as { __marks: Marks }).__marks;
		const requests = (
			performance.getEntriesByType("resource") as PerformanceResourceTiming[]
		)
			.filter((e) => e.startTime >= since)
			.map((e) => ({
				name: new URL(e.name).pathname.slice(0, 80),
				start: Math.round(e.startTime - since),
				end: Math.round(e.responseEnd - since),
			}));
		return {
			marks: Object.fromEntries(
				Object.entries(marks).map(([k, v]) => [k, Math.round(v)]),
			),
			requests,
		};
	}, since);
}

async function measure(
	profile: "desktop" | "phone",
	id: string,
): Promise<Run[]> {
	const browser = await (profile === "desktop" ? chromium : webkit).launch();
	const context = await browser.newContext({
		...(profile === "desktop"
			? { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }
			: devices["iPhone 13 Mini"]),
		baseURL: `http://127.0.0.1:${PROXY_PORT}`,
		serviceWorkers: "allow",
	});
	await context.addInitScript(MARKS);
	const out: Run[] = [];
	for (const visit of ["cold", "warm"]) {
		const page = await context.newPage();
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await ready(page).catch(async (e) => {
			await page.screenshot({
				path: `${process.env.LISTPERF_DEBUG ?? "/tmp"}/session-${profile}.png`,
			});
			console.error(
				await page.evaluate(() =>
					JSON.stringify((window as unknown as { __marks: Marks }).__marks),
				),
			);
			throw e;
		});
		out.push({ profile, visit: `link-${visit}`, ...(await collect(page)) });
		if (visit === "cold")
			await page
				.waitForFunction(
					async () => Boolean((await navigator.serviceWorker?.ready)?.active),
					undefined,
					{ timeout: 20_000 },
				)
				.catch(() => {});
		await page.close();
	}
	// A tap from home, the app already running.
	const page = await context.newPage();
	await page.goto("/");
	const row = page
		.locator("[data-agent], .d-card-row")
		.filter({ hasText: "bigchat" })
		.first();
	await row.waitFor({ timeout: 30_000 });
	await page.waitForTimeout(1500);
	const since = await page.evaluate(() => {
		const w = window as unknown as { __marks: Marks; __t0: number };
		w.__marks = {};
		w.__t0 = performance.now();
		return w.__t0;
	});
	await row.click();
	await ready(page);
	out.push({ profile, visit: "tap", ...(await collect(page, since)) });
	await browser.close();
	return out;
}

const daemon = await startDaemon({ PULSAR_REAL_BIG_TRANSCRIPT: LOG });
const proxy = await startProxy(RTT / 2);
const all: Run[] = [];
try {
	const ids = (await (
		await fetch(`http://127.0.0.1:${DAEMON_PORT + 1}/agents`)
	).json()) as { bigchat: string };
	for (const profile of ["desktop", "phone"] as const) {
		if (ONLY && profile !== ONLY) continue;
		for (let i = 0; i < RUNS; i++)
			all.push(...(await measure(profile, ids.bigchat)));
	}
} finally {
	proxy.close();
	daemon.kill("SIGTERM");
}
const median = (xs: number[]) => {
	const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)]! : Number.NaN;
};
console.log(
	`RTT ${RTT} ms, ${RUNS} runs, medians (ms; link: from navigation, tap: from the tap)`,
);
console.log("profile  visit        first  header  composer");
const groups = new Map<string, Run[]>();
for (const r of all)
	groups.set(`${r.profile}|${r.visit}`, [
		...(groups.get(`${r.profile}|${r.visit}`) ?? []),
		r,
	]);
for (const [k, rs] of groups) {
	const [p, v] = k.split("|");
	const m = (n: string) =>
		String(median(rs.map((r) => r.marks[n] ?? Number.NaN)));
	console.log(
		`${p!.padEnd(8)} ${v!.padEnd(11)} ${m("first").padStart(6)} ${m("header").padStart(7)} ${m("composer").padStart(9)}`,
	);
}
for (const [k, rs] of groups) {
	const r = rs[rs.length - 1]!;
	console.log(`\n${k}  first=${r.marks.first}`);
	for (const q of r.requests
		.filter((q) => q.start <= (r.marks.first ?? 0) + 50)
		.slice(0, 45))
		console.log(
			`  ${String(q.start).padStart(5)} → ${String(q.end).padStart(5)}  ${q.name}`,
		);
}
if (OUT) writeFileSync(OUT, JSON.stringify({ rtt: RTT, runs: all }, null, 1));
process.exit(0);
