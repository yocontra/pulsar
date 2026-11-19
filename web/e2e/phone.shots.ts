/**
 * Design-review screenshots of every phone screen (see playwright.shots.config.ts).
 * Not a test suite: each step only waits for its screen and saves a PNG.
 */
import { type Page, type Route, test } from "@playwright/test";
import { agentId } from "./fixtures.ts";

const DIR =
	process.env.SHOTS_DIR ??
	new URL("../screenshots/mobile/", import.meta.url).pathname;

const shot = (page: Page, name: string) =>
	page.screenshot({
		path: `${DIR}${name}-${test.info().project.name}.png`,
	});

/**
 * Standalone PWA on an iPhone 13 mini: emulation reports zero safe-area
 * insets, so set the app's inset variables (50 top, 34 bottom) and draw the
 * status bar, notch and home indicator over the page.
 */
// SHOTS_SAT / SHOTS_SAB: the safe-area insets (0 drops the drawn status bar
// or home indicator), for the opaque-status-bar and Safari-tab layouts.
const SAT = Number(process.env.SHOTS_SAT ?? 50);
const SAB = Number(process.env.SHOTS_SAB ?? 34);

test.beforeEach(async ({ page }) => {
	await page.addInitScript(
		([sat, sab]) => {
			const apply = () => {
				const r = document.documentElement.style;
				// macOS WebKit reports 13px for -apple-system-body; an iPhone uses 17px.
				if (!r.fontSize) r.setProperty("font-size", "17px");
				r.setProperty("--sat", `${sat}px`);
				r.setProperty("--sab", `${sab}px`);
				try {
					localStorage.setItem("pulsar.installHint", "1");
				} catch {}
				if (document.getElementById("__device")) return;
				const dark = matchMedia("(prefers-color-scheme: dark)").matches;
				const fg = dark ? "#fff" : "#000";
				const bar = document.createElement("div");
				bar.id = "__device";
				bar.setAttribute("aria-hidden", "true");
				Object.assign(bar.style, {
					position: "fixed",
					inset: "0",
					pointerEvents: "none",
					zIndex: "10000",
				});
				const time = document.createElement("div");
				time.textContent = "9:41";
				Object.assign(time.style, {
					position: "absolute",
					top: "15px",
					left: "34px",
					font: "600 16px -apple-system",
					color: fg,
				});
				const notch = document.createElement("div");
				Object.assign(notch.style, {
					position: "absolute",
					top: "0",
					left: "50%",
					width: "154px",
					height: "31px",
					marginLeft: "-77px",
					background: "#000",
					borderRadius: "0 0 20px 20px",
				});
				const batt = document.createElement("div");
				Object.assign(batt.style, {
					position: "absolute",
					top: "18px",
					right: "28px",
					width: "24px",
					height: "11px",
					borderRadius: "3px",
					background: fg,
				});
				const home = document.createElement("div");
				Object.assign(home.style, {
					position: "absolute",
					bottom: "8px",
					left: "50%",
					width: "134px",
					height: "5px",
					marginLeft: "-67px",
					borderRadius: "3px",
					background: fg,
				});
				if (sat) bar.append(time, notch, batt);
				if (sab) bar.append(home);
				document.body.append(bar);
			};
			if (document.body) apply();
			else addEventListener("DOMContentLoaded", apply);
		},
		[SAT, SAB] as const,
	);
});

type Step = [string, number, number];

/** Touch events with `touches` set (WebKit's Touch constructor is closed). */
async function _touches(page: Page, steps: Step[]) {
	for (const [type, x, y] of steps) {
		await page.evaluate(
			([type, x, y]) => {
				const w = window as unknown as { __tt?: Element };
				if (type === "touchstart")
					w.__tt = document.elementFromPoint(x, y) ?? document.body;
				const target = w.__tt ?? document.body;
				const t = { identifier: 1, target, clientX: x, clientY: y };
				const e = new Event(type, { bubbles: true, cancelable: true });
				Object.defineProperty(e, "touches", {
					value: type === "touchend" ? [] : [t],
				});
				Object.defineProperty(e, "changedTouches", { value: [t] });
				target.dispatchEvent(e);
			},
			[type, x, y] as const,
		);
		await page.waitForTimeout(16);
	}
}

async function home(page: Page) {
	await page.goto("/");
	await page.locator('[data-node="m:studio"]').waitFor();
	await page.waitForTimeout(400);
}

/** Large text: the iOS "Larger Text" setting, approximated by the root size. */
async function largeText(page: Page) {
	await page.evaluate(() =>
		document.documentElement.style.setProperty("font-size", "23px"),
	);
}

/** A stand-in keyboard: --kb as visualViewport would set it, and a grey block. */
async function keyboard(page: Page) {
	await page.evaluate(() => {
		const h = 291;
		document.documentElement.style.setProperty("--kb", `${h}px`);
		const kb = document.createElement("div");
		kb.setAttribute("aria-hidden", "true");
		const dark = matchMedia("(prefers-color-scheme: dark)").matches;
		Object.assign(kb.style, {
			position: "fixed",
			left: "0",
			right: "0",
			bottom: "0",
			height: `${h}px`,
			background: dark ? "#2c2c2e" : "#d1d3d9",
			zIndex: "9999",
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			font: "15px -apple-system",
			color: dark ? "#8e8e93" : "#6b6b70",
		});
		kb.textContent = "keyboard";
		document.body.append(kb);
	});
}

test.describe("phone screens", () => {
	test("home", async ({ page }) => {
		await home(page);
		await shot(page, "01-home");
		await page.locator("ion-content.p-home").evaluate(async (c) => {
			await (
				c as unknown as {
					scrollToPoint(x: number, y: number, ms: number): Promise<void>;
				}
			).scrollToPoint(0, 420, 0);
		});
		await page.waitForTimeout(500);
		await shot(page, "01b-home-scrolled");
	});

	test("home skeleton", async ({ page }) => {
		await page.route(/\/api\/v1\/tree(\?|$)/, () => {});
		await page.goto("/");
		await page.locator("[data-sk=row]").first().waitFor();
		await page.waitForTimeout(600);
		await shot(page, "01d-home-skeleton");
	});

	test("home large text", async ({ page }) => {
		await home(page);
		await largeText(page);
		await page.waitForTimeout(500);
		await shot(page, "01c-home-large-text");
	});

	test("search", async ({ page }) => {
		await home(page);
		await page.locator("ion-searchbar input").first().fill("apparish");
		await page.waitForTimeout(1200);
		await shot(page, "02-search");
	});

	test("tree expanded", async ({ page }) => {
		await home(page);
		await page.locator('[data-tree-node="m:studio/p:apparish"] ion-item').tap();
		await page.waitForTimeout(800);
		await page.locator("ion-content.p-home").evaluate(async (c) => {
			await (
				c as unknown as {
					scrollToPoint(x: number, y: number, ms: number): Promise<void>;
				}
			).scrollToPoint(0, 380, 0);
		});
		await page.waitForTimeout(500);
		await shot(page, "03-tree-expanded");
	});

	test("needs you", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "See All" }).tap();
		await page.waitForTimeout(900);
		await shot(page, "04-needs-you");
	});

	test("needs you, empty", async ({ page }) => {
		await page.route("**/api/v1/attention**", (r) =>
			r.fulfill({ json: { items: [], total: 0 } }),
		);
		await page.route("**/api/v1/events**", (r) => r.abort());
		await page.goto("/#/needs");
		await page.locator(".p-empty").waitFor();
		await page.waitForTimeout(500);
		await shot(page, "04b-needs-you-empty");
	});

	test("group sheet", async ({ page }) => {
		await home(page);
		await page.goto("/#/n/m%3Astudio");
		await page.locator("ion-modal h1").waitFor();
		await page.waitForTimeout(900);
		await shot(page, "05-group-sheet");
	});

	test("agent", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.locator(".p-nav-title h1").waitFor();
		await page.waitForTimeout(2000);
		await shot(page, "06-agent");
		await largeText(page);
		await page.waitForTimeout(600);
		await shot(page, "06c-agent-large-text");
	});

	test("agent scrolled and message menu", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.locator(".p-nav-title h1").waitFor();
		await page.waitForTimeout(1500);
		await page.evaluate(() => {
			const s = document.querySelector<HTMLElement>(
				".p-agent [class*=ds-scroller]",
			);
			if (s) s.scrollTop = Math.max(0, s.scrollTop - 500);
		});
		await page.waitForTimeout(500);
		await shot(page, "06d-agent-scrolled");
		await page
			.locator(".p-agent .ds-turn--assistant .ds-parts")
			.last()
			.dispatchEvent("contextmenu");
		await page.locator("ion-action-sheet").waitFor();
		await page.waitForTimeout(500);
		await shot(page, "06e-message-menu");
	});

	test("agent with an approval", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.locator(".p-approval-banner").waitFor();
		await page.waitForTimeout(1800);
		await shot(page, "06b-agent-approval-banner");
	});

	test("composer with keyboard", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.locator(".p-nav-title h1").waitFor();
		await page.waitForTimeout(1200);
		await keyboard(page);
		await page.waitForTimeout(400);
		await shot(page, "07-composer-keyboard");
	});

	test("broadcast", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "Broadcast…" }).tap();
		await page.getByTestId("match-count").waitFor();
		await page.waitForTimeout(1200);
		await shot(page, "08-broadcast");
		await page.getByRole("button", { name: "Narrow it down" }).tap();
		await page.waitForTimeout(500);
		await shot(page, "08b-broadcast-who");
	});

	test("approval", async ({ page, request }) => {
		const id = await agentId(request, "name=apparish-auth");
		await home(page);
		await page.goto(`/#/approval/${encodeURIComponent(id)}`);
		await page.locator(".prompt-inline .approval-card").first().waitFor();
		await page.waitForTimeout(1500);
		await shot(page, "10-approval");
	});

	test("approval passkey step", async ({ page, request }) => {
		// Pretend this device has Face ID and the system prompt is up.
		await page.addInitScript(() => {
			const pkc = window.PublicKeyCredential as unknown as {
				isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
			};
			if (pkc)
				pkc.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
			try {
				localStorage.setItem("pulsar.passkey", "1");
			} catch {}
			navigator.credentials.get = () => new Promise(() => {});
			navigator.credentials.create = () => new Promise(() => {});
		});
		const id = await agentId(request, "name=apparish-auth");
		await home(page);
		// Hold the decision request open, as while the Face ID prompt is up.
		await page.route("**/api/v1/**", (r) =>
			r.request().method() === "POST" ? undefined : r.continue(),
		);
		await page.goto(`/#/approval/${encodeURIComponent(id)}`);
		await page.locator(".prompt-inline .approval-card").first().waitFor();
		const sheet = page.locator(".prompt-inline");
		await page.waitForTimeout(1200);
		await shot(page, "10b-approval-can-approve");
		await sheet.getByRole("button", { name: /Allow once/ }).tap();
		await sheet.locator(".passkey-step").waitFor();
		await page.waitForTimeout(600);
		await shot(page, "10c-approval-passkey");
	});

	test("settings", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "Settings" }).tap();
		await page.waitForTimeout(1200);
		await shot(page, "11-settings");
		await page.locator("ion-content.p-settings").evaluate(async (c) => {
			await (
				c as unknown as {
					scrollToPoint(x: number, y: number, ms: number): Promise<void>;
				}
			).scrollToPoint(0, 300, 0);
		});
		await page.waitForTimeout(500);
		await shot(page, "11b-settings-scrolled");
	});

	test("ask", async ({ page }) => {
		await home(page);
		await page.getByRole("button", { name: "Ask" }).tap();
		await page.waitForTimeout(900);
		await shot(page, "12-ask");
		await page
			.locator(".p-ask ion-searchbar input")
			.fill("who is editing src/auth/session.ts");
		await page.waitForTimeout(1500);
		await shot(page, "12b-ask-answer");
	});

	test("boot loading", async ({ page }) => {
		// WebKit can't screenshot while a script is pending: serve the page
		// without its scripts, which leaves the static boot shell up.
		const noScripts = (slow: boolean) => async (r: Route) => {
			const res = await r.fetch();
			let html = (await res.text()).replace(
				/<script\b[^>]*>[^<]*<\/script>/g,
				"",
			);
			if (slow) html = html.replace('id="boot-slow" hidden', 'id="boot-slow"');
			await r.fulfill({ response: res, body: html });
		};
		await page.route("**/", noScripts(false));
		await page.goto("/");
		await page.waitForTimeout(600);
		await shot(page, "13c-boot");
		await page.unroute("**/");
		await page.route("**/", noScripts(true));
		await page.goto("/");
		await page.waitForTimeout(600);
		await shot(page, "13d-boot-slow");
	});

	test("boot failed", async ({ page }) => {
		await page.route("**/_app/index.astro_*.js", (r) => r.abort("failed"));
		await page.goto("/");
		await page.locator("#boot-error").waitFor({ timeout: 15_000 });
		await page.waitForTimeout(400);
		await shot(page, "13e-boot-failed");
		await page.locator(".st-more summary").first().click();
		await page.waitForTimeout(300);
		await shot(page, "13e-boot-failed-open");
		await page.setViewportSize({ width: 375, height: 560 });
		await page.waitForTimeout(300);
		await shot(page, "13e-boot-failed-open-short");
	});

	test("chunk loading", async ({ page }) => {
		// A route chunk still downloading: the route-level fallback.
		await page.route("**/_app/NeedsPage.*.js", () => {});
		await page.goto("/#/needs");
		await page.locator(".st-wait").waitFor();
		await page.waitForTimeout(900);
		await shot(page, "13g-chunk-loading");
	});

	test("chunk failed, whole app", async ({ page }) => {
		await page.route("**/_app/PhoneApp.*.js", (r) => r.abort("failed"));
		await page.goto("/");
		await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(600);
		await shot(page, "13h-app-chunk-failed");
	});

	test("chunk failed", async ({ page }) => {
		await page.route("**/_app/NeedsPage.*.js", (r) => r.abort("failed"));
		await page.goto("/#/needs");
		await page.getByRole("alert").first().waitFor({ timeout: 15_000 });
		await page.waitForTimeout(600);
		await shot(page, "13f-chunk-failed");
		await page.locator(".st-more summary").first().click();
		await page.waitForTimeout(300);
		await shot(page, "13f-chunk-failed-open");
	});

	test("offline", async ({ page }) => {
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.goto("/");
		await page.locator("[data-failure=offline]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "13-offline");
	});

	test("daemon down", async ({ page }) => {
		await page.route("**/api/v1/**", (r) =>
			r.fulfill({ status: 502, body: "{}", contentType: "application/json" }),
		);
		await page.goto("/");
		await page.locator("[data-failure=daemon-down]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "13b-daemon-down");
		await page.locator(".st-more summary").first().click();
		await page.waitForTimeout(300);
		await shot(page, "13b-daemon-down-open");
	});

	test("offline, last known", async ({ page }) => {
		await home(page);
		await page.route("**/api/v1/**", (r) => r.abort("internetdisconnected"));
		await page.reload();
		await page.locator("[data-failure=offline]").waitFor();
		await page.waitForTimeout(400);
		await shot(page, "13i-offline-last-known");
	});

	test("search, empty", async ({ page }) => {
		await home(page);
		await page.locator("ion-searchbar input").first().fill("zzzz-nothing");
		await page.waitForTimeout(1200);
		await shot(page, "02b-search-empty");
	});

	test("first run", async ({ page }) => {
		await page.route("**/api/v1/hello", (r) =>
			r.fulfill({
				json: {
					version: "2.0.0",
					machineId: "m1",
					machine: "studio",
					fedProtocol: [1, 1],
					features: ["tree", "facets", "send", "events"],
					you: { login: "you", node: "studio" },
					machines: 1,
					agents: 0,
					appUrl: "https://studio.example.ts.net/",
					firstRun: true,
				},
			}),
		);
		await page.goto("/");
		await page.getByRole("heading", { name: "Welcome to Pulsar" }).waitFor();
		await page.waitForTimeout(400);
		await shot(page, "14-first-run");
	});
	test("long-press menu", async ({ page }) => {
		await home(page);
		await page
			.locator('[data-tree-node="m:studio"] ion-item')
			.dispatchEvent("contextmenu");
		await page.locator("ion-action-sheet").waitFor();
		await page.waitForTimeout(600);
		await shot(page, "15-long-press-menu");
	});
	test("prove human", async ({ page }) => {
		await home(page);
		// Prove Human leads the phone's Settings.
		await page.getByRole("button", { name: "Settings" }).tap();
		await page.getByRole("button", { name: /^Prove Human/ }).tap();
		await page.getByRole("dialog", { name: "Prove Human" }).waitFor();
		await page.waitForTimeout(600);
		await shot(page, "16-prove");
	});

	test("prove human, proven", async ({ page }) => {
		// WebKit has no virtual passkeys: the installed app keeps a token that
		// /hello reports as a live session.
		await page.addInitScript(() => {
			Object.defineProperty(navigator, "standalone", { value: true });
			try {
				localStorage.setItem("pulsar.session", "shot");
			} catch {}
		});
		await page.route("**/api/v1/hello", async (r) => {
			const res = await r.fetch();
			const now = Date.now();
			await r.fulfill({
				response: res,
				json: {
					...(await res.json()),
					persistSession: true,
					session: {
						id: "shot",
						device: "iPhone",
						node: "iphone",
						createdAt: now,
						expiresAt: now + 8 * 3600_000,
						lastUsedAt: now,
					},
				},
			});
		});
		await home(page);
		// Prove Human leads the phone's Settings.
		await page.getByRole("button", { name: "Settings" }).tap();
		await page.getByRole("button", { name: /^Prove Human/ }).tap();
		const sheet = page.getByRole("dialog", { name: "Prove Human" });
		await sheet.getByText(/Proven as/).waitFor();
		await page.waitForTimeout(600);
		await shot(page, "16b-prove-done");
	});
	for (const kind of [
		"question",
		"question-long",
		"plan",
		"confirm",
		"select",
	] as const)
		test(`interaction card: ${kind}`, async ({ page, request }) => {
			const id = await agentId(request, "name=apparish-auth");
			const post = (data: object) =>
				request.post("/api/v1/__mock/realtime", {
					headers: { "X-Pulsar": "1" },
					data,
				});
			await post({ action: "interaction", id, kind });
			try {
				await home(page);
				await page.goto(`/#/approval/${encodeURIComponent(id)}`);
				await page.locator(".interaction-card").waitFor();
				await page.waitForTimeout(1200);
				await shot(page, `22-ix-${kind}`);
			} finally {
				await post({ action: "restore" });
			}
		});
	for (const tool of ["Edit", "Write"] as const)
		test(`approval card: ${tool}`, async ({ page, request }) => {
			const id = await agentId(request, "name=apparish-auth");
			const post = (data: object) =>
				request.post("/api/v1/__mock/realtime", {
					headers: { "X-Pulsar": "1" },
					data,
				});
			await post({ action: "needs-you", id, tool });
			try {
				await home(page);
				await page.goto(`/#/approval/${encodeURIComponent(id)}`);
				await page.locator(".prompt-inline .approval-card").first().waitFor();
				await page.waitForTimeout(1500);
				await shot(page, `23-approval-${tool.toLowerCase()}`);
			} finally {
				await post({ action: "restore" });
			}
		});
	test("markdown table and thinking rows", async ({ page, request }) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		const table = page.locator('[data-streamdown="table-wrapper"]').first();
		await table.waitFor();
		await table.evaluate((el) => el.scrollIntoView({ block: "center" }));
		await page.waitForTimeout(800);
		await shot(page, "25-markdown-table");
		const thought = page.locator(".ds-reason.is-hidden").first();
		if (await thought.count()) {
			await thought.evaluate((el) => el.scrollIntoView({ block: "center" }));
			await thought.locator(".ds-reason-info").tap();
			await page.waitForTimeout(500);
			await shot(page, "25b-thinking");
		}
	});
	test("sent message: delivery state on the bubble", async ({
		page,
		request,
	}) => {
		const id = await agentId(request, "name=codex@apparish");
		await home(page);
		await page.goto(`/#/a/${encodeURIComponent(id)}`);
		await page.locator(".transcript .ev").first().waitFor();
		await page
			.getByRole("textbox")
			.last()
			.fill("hold refresh() for 10 minutes");
		await page.getByRole("button", { name: "Send" }).last().tap();
		// Unproven: Prove Human asks first; send without proving.
		await page
			.getByRole("dialog", { name: "Prove Human" })
			.getByRole("button", { name: "Send without proving" })
			.tap();
		await page.locator(".ds-delivery").last().waitFor({ timeout: 10_000 });
		await page.waitForTimeout(2500);
		await shot(page, "06f-sent-delivery");
		await page.locator(".ds-turn--user .ds-author").last().tap();
		await page.waitForTimeout(300);
		await shot(page, "06g-sent-detail");
	});
});
