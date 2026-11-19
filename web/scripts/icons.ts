/**
 * Renders the PWA PNG icons from web/public/icon.svg (dev tool; the PNGs are
 * committed). `bun web/scripts/icons.ts` after changing the SVG.
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const pub = new URL("../public/", import.meta.url).pathname;
const svg = readFileSync(`${pub}icon.svg`, "utf8");
// Full-bleed squares: iOS and Android round the corners themselves.
// The maskable one keeps the art inside the 80% safe zone.
const out: [string, number, number][] = [
	["apple-touch-icon.png", 180, 1],
	["icon-192.png", 192, 1],
	["icon-512.png", 512, 1],
	["icon-maskable-512.png", 512, 0.8],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, scale] of out) {
	await page.setViewportSize({ width: size, height: size });
	const art = Math.round(size * scale);
	await page.setContent(
		`<body style="margin:0;background:#06070f;display:grid;place-items:center;width:${size}px;height:${size}px">${svg.replace("<svg ", `<svg width="${art}" height="${art}" `)}</body>`,
	);
	await page.screenshot({ path: `${pub}${name}`, omitBackground: false });
	console.log(name, size);
}
await browser.close();
