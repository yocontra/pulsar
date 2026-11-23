/**
 * Appearance on the phone: switching System / Light / Dark in Settings
 * repaints every bar live, with no reload: the top bar under the status bar,
 * the tab bar, the page background and the theme-color meta. Also checks
 * that the real safe-area path is wired (WebKit emulation reports zero
 * insets, so the other tests set --sat/--sab/--sal/--sar directly).
 */
import type { Page } from "@playwright/test";
import { agentId, expect, test } from "./fixtures.ts";

type Insets = { top: number; bottom: number; left: number; right: number };
const PORTRAIT: Insets = { top: 59, bottom: 34, left: 0, right: 0 };
const LANDSCAPE: Insets = { top: 0, bottom: 21, left: 59, right: 59 };

async function setInsets(page: Page, ins: Insets) {
	await page.addInitScript((ins) => {
		const apply = () => {
			const r = document.documentElement?.style;
			if (!r) return;
			r.setProperty("font-size", "17px");
			r.setProperty("--sat", `${ins.top}px`);
			r.setProperty("--sab", `${ins.bottom}px`);
			r.setProperty("--sal", `${ins.left}px`);
			r.setProperty("--sar", `${ins.right}px`);
		};
		apply();
		document.addEventListener("DOMContentLoaded", apply);
		try {
			localStorage.setItem("pulsar.installHint", "1");
		} catch {}
	}, ins);
}

/** Median luminance (0-255) of what is painted in a screen region. */
async function painted(
	page: Page,
	errors: string[],
	clip: { x: number; y: number; width: number; height: number },
) {
	// WebKit screenshots inject a stylesheet the CSP refuses.
	const before = errors.length;
	const png = await page.screenshot({ clip, scale: "css" });
	const during = errors.splice(before);
	errors.push(
		...during.filter((e) => !/^Refused to apply a stylesheet/.test(e)),
	);
	// A Blob needs no URL, so the page's CSP does not apply.
	return page.evaluate(async (b64) => {
		const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const bmp = await createImageBitmap(new Blob([bytes]));
		const cv = new OffscreenCanvas(bmp.width, bmp.height);
		const cx = cv.getContext("2d")!;
		cx.drawImage(bmp, 0, 0);
		const d = cx.getImageData(0, 0, bmp.width, bmp.height).data;
		const lum: number[] = [];
		for (let i = 0; i < d.length; i += 4)
			lum.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
		lum.sort((a, b) => a - b);
		return Math.round(lum[lum.length >> 1]!);
	}, png.toString("base64"));
}

/** The theme-color that applies now and the body background, as luminance. */
function chrome(page: Page) {
	return page.evaluate(() => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = 1;
		const cx = cv.getContext("2d")!;
		const lum = (c: string) => {
			cx.clearRect(0, 0, 1, 1);
			cx.fillStyle = c;
			cx.fillRect(0, 0, 1, 1);
			const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
			return Math.round(0.2126 * r! + 0.7152 * g! + 0.0722 * b!);
		};
		const meta = [
			...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
		].find((m) => !m.media || matchMedia(m.media).matches);
		return {
			scheme:
				document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
					?.content ?? "",
			meta: meta ? lum(meta.content) : -1,
			body: lum(getComputedStyle(document.body).backgroundColor),
		};
	});
}

const isDark = (l: number) => l < 60;
const isLight = (l: number) => l > 190;

test("every bar follows the Appearance setting live", async ({
	page,
	errors,
}) => {
	const { width } = page.viewportSize()!;
	await setInsets(page, PORTRAIT);
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/#/settings");
	const group = page.getByRole("radiogroup", { name: "Appearance" });
	await group.waitFor();
	const tabbar = page.getByTestId("tabbar");
	await expect(tabbar).toBeVisible();

	const expectAll = async (
		what: string,
		ok: (l: number) => boolean,
		scheme: string,
	) => {
		// Colors change through CSS variables: no transition to wait for, but
		// the radio's own state settles on the next frame.
		await page.evaluate(
			() => new Promise((r) => requestAnimationFrame(() => r(null))),
		);
		const c = await chrome(page);
		expect(ok(c.body), `${what}: page background ${c.body}`).toBe(true);
		expect(ok(c.meta), `${what}: theme-color ${c.meta}`).toBe(true);
		expect(c.scheme, `${what}: color-scheme meta`).toBe(scheme);
		// The status bar strip and the top bar under it.
		const top = await painted(page, errors, {
			x: 0,
			y: 0,
			width,
			height: PORTRAIT.top + 44,
		});
		expect(ok(top), `${what}: top bar ${top}`).toBe(true);
		const tb = (await tabbar.boundingBox())!;
		const bar = await painted(page, errors, tb);
		expect(ok(bar), `${what}: tab bar ${bar}`).toBe(true);
	};

	await expectAll("system, OS light", isLight, "light dark");
	await group.getByRole("radio", { name: "Dark" }).tap();
	await expectAll("System → Dark, OS light", isDark, "dark");
	await group.getByRole("radio", { name: "Light" }).tap();
	await page.emulateMedia({ colorScheme: "dark" });
	await expectAll("Dark → Light, OS dark", isLight, "light");
	await group.getByRole("radio", { name: "System" }).tap();
	await expectAll("Light → System, OS dark", isDark, "light dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expectAll("System, OS turns light", isLight, "light dark");
	// Still the same document: no reload happened along the way.
	expect(
		await page.evaluate(
			() => performance.getEntriesByType("navigation").length,
		),
	).toBe(1);
});

test("a pushed page's top bar follows the setting live", async ({
	page,
	request,
	errors,
}) => {
	const { width } = page.viewportSize()!;
	await setInsets(page, PORTRAIT);
	await page.emulateMedia({ colorScheme: "light" });
	const id = await agentId(request, "name=codex@apparish");
	await page.goto("/#/settings");
	const group = page.getByRole("radiogroup", { name: "Appearance" });
	await group.getByRole("radio", { name: "Dark" }).tap();
	// Same document: the hash route, not a reload.
	await page.evaluate((id) => {
		location.hash = `#/a/${encodeURIComponent(id)}`;
	}, id);
	await page.locator(".m-composer").waitFor();
	const top = { x: 0, y: 0, width, height: PORTRAIT.top + 44 };
	await expect
		.poll(() => painted(page, errors, top), { message: "top bar, dark" })
		.toBeLessThan(60);
	const dock = (await page.locator(".m-composer").boundingBox())!;
	expect(await painted(page, errors, dock), "composer dock, dark").toBeLessThan(
		90,
	);
});

test("the real safe-area insets reach every component library", async ({
	page,
}) => {
	await page.goto("/#/settings");
	await page.getByRole("radiogroup", { name: "Appearance" }).waitFor();
	const wiring = await page.evaluate(() => {
		const viewport =
			document.querySelector<HTMLMetaElement>('meta[name="viewport"]')
				?.content ?? "";
		// Every stylesheet rule that sets an inset variable.
		const sets: Record<string, string[]> = {};
		const walk = (rules: CSSRuleList) => {
			for (const r of rules) {
				if ("cssRules" in r && (r as CSSGroupingRule).cssRules)
					walk((r as CSSGroupingRule).cssRules);
				if (!(r instanceof CSSStyleRule)) continue;
				for (const v of ["--sat", "--sab", "--sal", "--sar"]) {
					const val = r.style.getPropertyValue(v).trim();
					if (!val) continue;
					sets[v] ??= [];
					sets[v].push(`${r.selectorText}|${val}`);
				}
			}
		};
		for (const s of document.styleSheets)
			try {
				walk(s.cssRules);
			} catch {}
		const root = getComputedStyle(document.documentElement);
		const tabbar = document.querySelector("[data-testid=tabbar]");
		const k = tabbar ? getComputedStyle(tabbar) : root;
		return {
			viewport,
			sets,
			// Ionic's and Konsta's variables read the app's, which read env().
			ion: root.getPropertyValue("--ion-safe-area-bottom").trim(),
			konsta: k.getPropertyValue("--k-safe-area-bottom").trim(),
			sab: root.getPropertyValue("--sab").trim(),
		};
	});
	expect(wiring.viewport).toContain("viewport-fit=cover");
	// Only :root sets them, from env(). (Inside ion-content the side insets
	// are zeroed on purpose: ion-content pads by them itself.)
	for (const [v, side] of [
		["--sat", "top"],
		["--sab", "bottom"],
		["--sal", "left"],
		["--sar", "right"],
	] as const)
		expect(
			wiring.sets[v]
				?.map((x) => x.replace(/\s+/g, ""))
				.filter((x) => /^(:root|html)\|/.test(x)),
			v,
		).toEqual([`:root|env(safe-area-inset-${side},0px)`]);
	// Emulation reports 0: the chain resolves to the same value everywhere.
	expect(wiring.ion).toBe(wiring.sab);
	expect(wiring.konsta).toBe(wiring.sab);
});

test("landscape: bars clear the side insets and the home indicator", async ({
	page,
}, info) => {
	const ios = info.project.name === "ios";
	await page.setViewportSize({ width: 852, height: 393 });
	await setInsets(page, LANDSCAPE);
	await page.goto("/#/settings");
	await page.getByRole("radiogroup", { name: "Appearance" }).waitFor();
	const tabs = page.getByTestId("tabbar").locator("[data-testid^=tab-]");
	await expect(tabs).toHaveCount(4);
	const boxes = () =>
		tabs.evaluateAll((els) =>
			els.map((e) => e.getBoundingClientRect().toJSON() as DOMRect),
		);
	for (const b of await boxes()) {
		expect(b.left, "tab left of the left inset").toBeGreaterThanOrEqual(
			LANDSCAPE.left,
		);
		expect(b.right, "tab right of the right inset").toBeLessThanOrEqual(
			852 - LANDSCAPE.right,
		);
		// iOS 26's capsule sits inside the inset, clear of the indicator itself
		// (5 pt tall, 8 pt from the edge); Material's bar sits above the inset.
		expect(b.bottom, "tab over the home indicator").toBeLessThanOrEqual(
			393 - (ios ? 13 : LANDSCAPE.bottom),
		);
	}
	// The settings rows: text inside the side insets.
	const row = page.getByRole("radio", { name: "Dark" });
	const r = (await row.boundingBox())!;
	expect(r.x).toBeGreaterThanOrEqual(LANDSCAPE.left);
	expect(r.x + r.width).toBeLessThanOrEqual(852 - LANDSCAPE.right);
});
