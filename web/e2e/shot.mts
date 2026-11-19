// Ad-hoc phone screenshots: bun web/e2e/shot.mts <port> <outdir> <name> <hash> [light|dark] [stepsJS]
import { devices, webkit } from "@playwright/test";

const [port, out, name, hash, scheme = "light", steps = ""] =
	process.argv.slice(2);
const browser = await webkit.launch();
const ctx = await browser.newContext({
	...devices["iPhone 13 Mini"],
	viewport: { width: 375, height: 812 },
	colorScheme: scheme as "light" | "dark",
	serviceWorkers: "block",
});
const page = await ctx.newPage();
const errs: string[] = [];
page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
page.on("pageerror", (e) => errs.push(`${e.message}\n${e.stack}`));
await page.addInitScript(() => {
	const apply = () => {
		const r = document.documentElement?.style;
		if (!r) return;
		r.setProperty("font-size", "17px");
		r.setProperty("--sat", "50px");
		r.setProperty("--sab", "34px");
	};
	apply();
	document.addEventListener("DOMContentLoaded", apply);
	try {
		localStorage.setItem("pulsar.installHint", "1");
	} catch {}
});
await page.goto(`http://127.0.0.1:${port}/${hash}`);
await page.waitForTimeout(1500);
const { readFileSync } = await import("node:fs");
const code = steps.startsWith("@")
	? readFileSync(steps.slice(1), "utf8")
	: steps;
if (code)
	await new Function(
		"page",
		"readFileSync",
		`return (async () => { ${code} })()`,
	)(page, readFileSync);
await page.waitForTimeout(600);
await page.screenshot({ path: `${out}/${name}-${scheme}.png` });
if (errs.length) console.log("ERRORS", errs);
await browser.close();
