/**
 * The installed phone app on a notched iPhone: every bar, sheet and page
 * keeps its text and controls clear of the status bar / Dynamic Island, the
 * home indicator and, in landscape, the side insets. WebKit emulation
 * reports zero safe-area insets, so the app's inset variables (styles/ios.css
 * --sat/--sab/--sal/--sar, which every safe-area rule reads) are set to an
 * iPhone 15/16 Pro's values. NOTCH_SHOTS_DIR saves a screenshot per screen.
 */
import type { Page } from "@playwright/test";
import { agentId, expect, ready, test } from "./fixtures.ts";
import { animationsDone } from "./ui-audit.ts";

type Insets = { top: number; bottom: number; left: number; right: number };

const LAYOUTS: [name: string, w: number, h: number, ins: Insets][] = [
	["portrait", 393, 852, { top: 59, bottom: 34, left: 0, right: 0 }],
	["landscape", 852, 393, { top: 0, bottom: 21, left: 59, right: 59 }],
];

async function setInsets(page: Page, ins: Insets) {
	await page.addInitScript((ins) => {
		const apply = () => {
			const r = document.documentElement?.style;
			if (!r) return;
			// macOS WebKit reports 13px for -apple-system-body; iPhones use 17px.
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

/**
 * Text and controls on top at their spot (not scrolled under a header) that
 * reach into an inset. Text is measured by its glyphs, not its box, so a
 * full-width block padded by the inset passes. The bottom inset applies only
 * outside scrolling content: a list row may scroll under the home indicator.
 */
function insetViolations(page: Page, ins: Insets) {
	return page.evaluate((ins) => {
		const vw = document.documentElement.clientWidth;
		const vh = innerHeight;
		// Measured by their box: fields, icons and images, and buttons with no
		// element inside (their label is in a shadow root). A button that holds
		// elements may span the screen (a full-bleed row): its contents count.
		const BOXES =
			"input,textarea,select,img,svg,ion-icon,ion-toggle,ion-checkbox";
		const BUTTONS =
			"button,ion-button,ion-back-button,ion-segment-button,[role=button],[role=tab],[role=radio]";
		// The scroll area that moves `el`, if any (Ionic's is in a shadow root).
		const scroller = (el: Element): Element | null => {
			for (let e: Element | null = el; e; e = e.parentElement) {
				if (e.getAttribute("slot") === "fixed") return null;
				if (e.tagName === "ION-CONTENT")
					return e.shadowRoot?.querySelector(".inner-scroll") ?? e;
				const oy = getComputedStyle(e).overflowY;
				if (
					(oy === "auto" || oy === "scroll") &&
					e.scrollHeight > e.clientHeight
				)
					return e;
			}
			return null;
		};
		const scrolls = (el: Element) => scroller(el) !== null;
		const problems = new Set<string>();
		for (const el of document.body.querySelectorAll<HTMLElement>("*")) {
			if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
			if (el.id === "__device") continue;
			const control =
				el.matches(BOXES) ||
				(el.matches(BUTTONS) && el.childElementCount === 0);
			const texts = [...el.childNodes].filter(
				(n) => n.nodeType === 3 && (n.textContent ?? "").trim(),
			);
			if (!control && !texts.length) continue;
			if (
				!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })
			)
				continue;
			let b: DOMRect;
			if (control) b = el.getBoundingClientRect();
			else {
				const range = document.createRange();
				range.setStartBefore(texts[0]!);
				range.setEndAfter(texts[texts.length - 1]!);
				b = range.getBoundingClientRect();
			}
			// What is painted: clipped by every overflow box around it (an
			// ellipsis, a scroller, screen-reader-only text).
			const r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
			for (let e: Element | null = el; e; e = e.parentElement) {
				const s = getComputedStyle(e);
				if (s.overflowX === "visible" && s.overflowY === "visible") continue;
				const c = e.getBoundingClientRect();
				if (s.overflowX !== "visible") {
					r.left = Math.max(r.left, c.left);
					r.right = Math.min(r.right, c.right);
				}
				if (s.overflowY !== "visible") {
					r.top = Math.max(r.top, c.top);
					r.bottom = Math.min(r.bottom, c.bottom);
				}
			}
			// Under 2 px: clipped away, or screen-reader-only text.
			if (r.right - r.left < 2 || r.bottom - r.top < 2) continue;
			const width = r.right - r.left;
			const height = r.bottom - r.top;
			// Off screen (a page parked by a transition, a list below the fold).
			if (r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh)
				continue;
			// Hit-test the centre (clamped to the viewport): text scrolled under
			// a translucent header is covered, not misplaced.
			const x = Math.min(vw - 1, Math.max(0, r.left + width / 2));
			const y = Math.min(vh - 1, Math.max(0, r.top + height / 2));
			const hit = document.elementFromPoint(x, y);
			if (!hit || !(hit === el || el.contains(hit) || hit.contains(el)))
				continue;
			const name = `${el.tagName.toLowerCase()}${el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/)[0]}` : ""} "${(el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30)}"`;
			const box = `(${Math.round(r.left)},${Math.round(r.top)})-(${Math.round(r.right)},${Math.round(r.bottom)})`;
			// Scrolled content passes under the top bar by design (the bar is
			// glass); content under the notch while its scroller is at rest is
			// misplaced. A tall paragraph half under the bar has its centre
			// below it, so the hit test above does not catch that case.
			if (r.top < ins.top - 0.5 && !((scroller(el)?.scrollTop ?? 0) > 0))
				problems.add(`${name} under the top inset ${box}`);
			if (r.left < ins.left - 0.5)
				problems.add(`${name} under the left inset ${box}`);
			if (r.right > vw - ins.right + 0.5)
				problems.add(`${name} under the right inset ${box}`);
			if (r.bottom > vh - ins.bottom + 0.5 && !scrolls(el))
				problems.add(`${name} under the bottom inset ${box}`);
		}
		return [...problems];
	}, ins);
}

type Screen = [name: string, open: (page: Page, ids: Ids) => Promise<void>];
type Ids = { codex: string; auth: string };

const SCREENS: Screen[] = [
	["home", async (page) => void (await ready(page))],
	[
		"agent",
		async (page, { codex }) => {
			await page.goto(`/#/a/${encodeURIComponent(codex)}`);
			await page.locator(".transcript .ev").first().waitFor();
			await page.locator(".m-composer").waitFor();
		},
	],
	[
		"agent with approval",
		async (page, { auth }) => {
			await page.goto(`/#/a/${encodeURIComponent(auth)}`);
			await page.locator(".prompt-inline").first().waitFor();
			// The banner shows while the inline prompt is scrolled off screen.
			// Content that loads after a scroll can bring the conversation back
			// to its end (and the prompt on screen): scroll to the top until the
			// banner shows.
			const banner = page.locator(".p-approval-banner");
			await expect
				.poll(async () => {
					await page.locator(".p-agent-body").evaluate((body) => {
						for (const el of body.querySelectorAll("*"))
							if (
								el.scrollHeight > el.clientHeight + 5 &&
								/auto|scroll/.test(getComputedStyle(el).overflowY)
							)
								el.scrollTo(0, 0);
					});
					return banner.isVisible();
				})
				.toBe(true);
		},
	],
	[
		"subagent",
		async (page, { auth }) => {
			const sub = `${auth}/sub:a4mate`;
			await page.goto(`/#/s/${encodeURIComponent(sub)}`);
			await page.locator(`[data-subagent-page="${sub}"]`).waitFor();
		},
	],
	[
		"needs you",
		async (page) => {
			await page.goto("/#/needs");
			await page.locator(".p-attn").first().waitFor();
		},
	],
	[
		"settings",
		async (page) => {
			await page.goto("/#/settings");
			await page.getByRole("radiogroup", { name: "Appearance" }).waitFor();
		},
	],
	[
		"broadcast",
		async (page) => {
			await ready(page);
			await page.getByRole("button", { name: "Broadcast…" }).tap();
			await page.getByTestId("match-count").waitFor();
		},
	],
	[
		"search",
		async (page) => {
			await ready(page);
			await page.evaluate(() => {
				location.hash = "#/search";
			});
			await page.locator("#p-search-q").fill("fake timers");
			await page
				.getByRole("region", { name: "Messages" })
				.locator(".msr-row")
				.first()
				.waitFor();
		},
	],
	[
		"files",
		async (page, { auth }) => {
			await page.goto(`/#/file/${encodeURIComponent(auth)}`);
			await page.getByRole("group", { name: "Files" }).last().waitFor();
		},
	],
	[
		"file",
		async (page, { auth }) => {
			await page.goto(
				`/#/file/${encodeURIComponent(auth)}?path=${encodeURIComponent("src/auth/refresh.ts")}`,
			);
			await page.locator(".ds-code").last().waitFor();
		},
	],
	[
		"approval",
		async (page, { auth }) => {
			await page.goto(`/#/approval/${encodeURIComponent(auth)}`);
			await page.locator(".prompt-inline .approval-card").waitFor();
		},
	],
	[
		"changes",
		async (page, { auth }) => {
			await page.goto(`/#/changes/${encodeURIComponent(auth)}`);
			await page.locator("ion-title").last().waitFor();
		},
	],
	[
		"git sheet",
		async (page, { auth }) => {
			await page.goto(`/#/a/${encodeURIComponent(auth)}`);
			await page.getByRole("button", { name: /^Git: / }).click();
			await page
				.getByTestId("git-sheet")
				.getByRole("button", { name: /PR #1402/ })
				.waitFor();
		},
	],
	[
		"pr review",
		async (page, { auth }) => {
			await page.goto(`/#/pr/${encodeURIComponent(auth)}`);
			await page.locator(".prv-phone .prv-title h2").waitFor();
		},
	],
	[
		"new agent",
		async (page) => {
			await ready(page);
			await page.getByRole("button", { name: "New agent" }).click();
			await page.getByTestId("launch-draft").waitFor();
		},
	],
	[
		"prove human",
		async (page) => {
			await ready(page);
			await page.getByTestId("tab-settings").tap();
			await page.getByRole("button", { name: /^Prove Human/ }).tap();
			await page.getByRole("dialog", { name: "Prove Human" }).waitFor();
		},
	],
];

/** The theme-color meta that applies now, and the body's painted colour, as hex. */
function barColors(page: Page) {
	return page.evaluate(() => {
		const cv = document.createElement("canvas");
		cv.width = cv.height = 1;
		const cx = cv.getContext("2d")!;
		const hex = (c: string) => {
			cx.clearRect(0, 0, 1, 1);
			cx.fillStyle = c;
			cx.fillRect(0, 0, 1, 1);
			const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
			return `#${[r, g, b].map((x) => x!.toString(16).padStart(2, "0")).join("")}`;
		};
		const meta = [
			...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
		].find((m) => !m.media || matchMedia(m.media).matches);
		return {
			meta: meta ? hex(meta.content) : null,
			body: hex(getComputedStyle(document.body).backgroundColor),
		};
	});
}

test("the browser bar colour matches the page in each theme, live", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto("/#/settings");
	const group = page.getByRole("radiogroup", { name: "Appearance" });
	await group.waitFor();
	const same = async (what: string) => {
		const c = await barColors(page);
		expect(c.meta, what).toBe(c.body);
		return c.body;
	};
	expect(await same("system light")).toBe("#f4f3f1");
	// System: the phone flips to dark while the app stays open.
	await page.emulateMedia({ colorScheme: "dark" });
	expect(await same("system dark")).toBe("#0b0b0a");
	// Forced themes beat the system one.
	await group.getByRole("radio", { name: "Light" }).tap();
	expect(await same("forced light")).toBe("#f4f3f1");
	await group.getByRole("radio", { name: "Dark" }).tap();
	await page.emulateMedia({ colorScheme: "light" });
	expect(await same("forced dark")).toBe("#0b0b0a");
	await group.getByRole("radio", { name: "System" }).tap();
});

test("the installed app hides the Add to Home Screen tip", async ({ page }) => {
	// A Safari tab shows it (no saved dismissal in a fresh context)...
	await ready(page);
	await expect(page.getByRole("complementary", { name: "Tip" })).toBeVisible();
	// ...the Home Screen app does not: iOS 27 reports navigator.standalone
	// there, and display-mode: standalone does not match.
	await page.addInitScript(() =>
		Object.defineProperty(navigator, "standalone", { get: () => true }),
	);
	// A current install: content runs under the status bar (a top inset).
	await setInsets(page, LAYOUTS[0]![3]);
	await page.goto("about:blank");
	await ready(page);
	await expect(page.getByRole("complementary", { name: "Tip" })).toHaveCount(0);
});

test("an install with the old status bar asks to be added again", async ({
	page,
}) => {
	await page.addInitScript(() =>
		Object.defineProperty(navigator, "standalone", { get: () => true }),
	);
	const tip = page.getByRole("complementary", { name: "Tip" });
	// The old key: iOS draws its own bar and reports no top inset.
	await setInsets(page, { top: 0, bottom: 34, left: 0, right: 0 });
	await ready(page);
	await expect(tip).toContainText("Add Pulsar to your Home Screen again");
	await tip.getByRole("button", { name: "Dismiss tip" }).tap();
	await expect(tip).toHaveCount(0);
	await page.reload();
	await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
	await expect(tip).toHaveCount(0);
});

test("a current install under the status bar shows no tip", async ({
	page,
}) => {
	await page.addInitScript(() =>
		Object.defineProperty(navigator, "standalone", { get: () => true }),
	);
	await setInsets(page, LAYOUTS[0]![3]);
	await ready(page);
	await expect(page.getByRole("complementary", { name: "Tip" })).toHaveCount(0);
});

test.describe("notch and home indicator", () => {
	for (const [layout, w, h, ins] of LAYOUTS)
		for (const scheme of ["light", "dark"] as const)
			test(`every screen clears the safe areas, ${layout} ${scheme}`, async ({
				page,
				request,
				errors,
			}) => {
				test.setTimeout(120_000);
				await page.setViewportSize({ width: w, height: h });
				await page.emulateMedia({ colorScheme: scheme });
				await setInsets(page, ins);
				const ids = {
					codex: await agentId(request, "name=codex@apparish"),
					auth: await agentId(request, "name=apparish-auth"),
				};
				const dir = process.env.NOTCH_SHOTS_DIR;
				for (const [name, open] of SCREENS) {
					// The fixture approval expires 10 min into a worker's mock (and
					// stays listed): late in a full run its banner never shows. Each
					// approval screen gets a fresh one.
					if (name === "agent with approval" || name === "approval") {
						const res = await request.post("/api/v1/__mock/realtime", {
							headers: { "X-Pulsar": "1" },
							data: { action: "needs-you", id: ids.auth, tool: "Bash" },
						});
						expect(res.ok()).toBe(true);
					}
					// A fresh document: an open sheet would cover the next screen.
					await page.goto("about:blank");
					await open(page, ids);
					// Ionic's page and sheet transitions: measure at rest.
					await animationsDone(page);
					if (dir) {
						// WebKit screenshots inject a stylesheet the CSP refuses.
						const before = errors.length;
						await page.screenshot({
							path: `${dir}/${layout}-${scheme}-${name.replace(/ /g, "-")}.png`,
						});
						const during = errors.splice(before);
						errors.push(
							...during.filter(
								(e) => !/^Refused to apply a stylesheet/.test(e),
							),
						);
					}
					// Soft: one run lists every screen that overlaps an inset.
					expect.soft(await insetViolations(page, ins), name).toEqual([]);
				}
			});
});
