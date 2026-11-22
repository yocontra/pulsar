/**
 * The README's screenshots (see playwright.readme-shots.config.ts). Not a
 * test suite: each step waits for its screen and saves a PNG to
 * web/test-results/readme-png/ (SHOTS_DIR, with a trailing slash, overrides
 * it). Convert them into docs/assets/screenshots/ with
 *   cwebp -q 86 -resize 750 0 phone-x.png -o docs/assets/screenshots/phone-x.webp
 *   cwebp -q 88 desktop-x.png -o docs/assets/screenshots/desktop-x.webp
 */
import { type Page, test } from "@playwright/test";
import { agentId } from "./fixtures.ts";

const DIR =
	process.env.SHOTS_DIR ??
	new URL("../test-results/readme-png/", import.meta.url).pathname;

async function shot(page: Page, name: string) {
	// No hover state (copy buttons) in the picture.
	await page.mouse.move(1, 1);
	await page.waitForTimeout(300);
	await page.screenshot({ path: `${DIR}${name}.png` });
}

const only = (project: "phone" | "desktop") =>
	test.skip(test.info().project.name !== project);

/** The installed phone app: safe-area insets, the iOS text size and a status bar. */
async function phoneChrome(page: Page) {
	await page.addInitScript(() => {
		const apply = () => {
			const r = document.documentElement.style;
			r.setProperty("font-size", "17px");
			r.setProperty("--sat", "50px");
			r.setProperty("--sab", "34px");
			try {
				localStorage.setItem("pulsar.installHint", "1");
			} catch {}
			if (document.getElementById("__device")) return;
			const fg = matchMedia("(prefers-color-scheme: dark)").matches
				? "#fff"
				: "#000";
			const bar = document.createElement("div");
			bar.id = "__device";
			bar.setAttribute("aria-hidden", "true");
			// CSSOM, not style attributes: the app's CSP blocks inline styles.
			const el = (css: Partial<CSSStyleDeclaration>, text = "") => {
				const d = document.createElement("div");
				Object.assign(d.style, { position: "absolute", ...css });
				d.textContent = text;
				return d;
			};
			Object.assign(bar.style, {
				position: "fixed",
				inset: "0",
				pointerEvents: "none",
				zIndex: "10000",
			});
			bar.append(
				el(
					{
						top: "15px",
						left: "34px",
						font: "600 16px -apple-system",
						color: fg,
					},
					"9:41",
				),
				el({
					top: "0",
					left: "50%",
					width: "154px",
					height: "31px",
					marginLeft: "-77px",
					background: "#000",
					borderRadius: "0 0 20px 20px",
				}),
				el({
					top: "18px",
					right: "28px",
					width: "24px",
					height: "11px",
					borderRadius: "3px",
					background: fg,
				}),
				el({
					bottom: "8px",
					left: "50%",
					width: "134px",
					height: "5px",
					marginLeft: "-67px",
					borderRadius: "3px",
					background: fg,
				}),
			);
			document.body.append(bar);
		};
		if (document.body) apply();
		else addEventListener("DOMContentLoaded", apply);
	});
}

/** Pretend this device has Face ID and a passkey, so answer buttons are live. */
async function faceId(page: Page) {
	await page.addInitScript(() => {
		const pkc = window.PublicKeyCredential as unknown as {
			isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
		};
		if (pkc)
			pkc.isUserVerifyingPlatformAuthenticatorAvailable = async () => true;
		try {
			localStorage.setItem("pulsar.passkey", "1");
		} catch {}
	});
}

async function home(page: Page) {
	await page.goto("/");
	await page.locator('[data-node="m:studio"]').waitFor();
	await page.waitForTimeout(800);
}

test.describe("readme screens", () => {
	test("desktop session", async ({ page, request }) => {
		only("desktop");
		await faceId(page);
		const id = await agentId(request, "name=apparish-auth");
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			await home(page);
			await page.goto(`/#/a/${encodeURIComponent(id)}`);
			await page.locator(".transcript .ev").first().waitFor();
			await page.waitForTimeout(2000);
			// Open the last file write, then stay at the bottom of the session.
			const write = page.locator(".ev.tool[data-tool='Write']").last();
			if (!(await write.locator(".diff, pre").count()))
				await write.locator("button").first().click();
			await page.waitForTimeout(500);
			const jump = page.getByRole("button", { name: "Jump to latest" });
			if (await jump.isVisible()) await jump.click();
			await page.waitForTimeout(800);
			await shot(page, `desktop-session-${scheme}`);
		}
	});

	test("phone home", async ({ page }) => {
		only("phone");
		await phoneChrome(page);
		await faceId(page);
		// Home: Needs you and the machines, with no session chrome to truncate.
		await home(page);
		await page.getByText("Needs You").first().waitFor();
		await shot(page, "phone-home");
	});
});
