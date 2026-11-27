import {
	type APIRequestContext,
	test as base,
	expect,
	type Page,
} from "@playwright/test";
import { type E2EWorkerOptions, startServer } from "./infra.ts";

/**
 * Every test fails on a console error, an uncaught exception, a CSP
 * violation (they log as console errors) or a dialog (an XSS `alert`).
 * Tests that render Mermaid allow its style-src violations (see below).
 */
export const test = base.extend<
	{ errors: string[]; proveSends: boolean },
	E2EWorkerOptions & { serverProcess: undefined }
>({
	/**
	 * The server this worker's tests talk to (the config's `server` option):
	 * every worker starts its own on its own port (infra.ts workerPort, which
	 * the config's baseURL uses), so tests that change server state never see
	 * another worker's changes. Configs with a shared webServer leave it null.
	 */
	server: [null, { scope: "worker", option: true }],
	serverProcess: [
		async ({ server }, use, workerInfo) => {
			if (!server) return use(undefined);
			const stop = await startServer(server, workerInfo.workerIndex);
			try {
				await use(undefined);
			} finally {
				await stop();
			}
		},
		{ scope: "worker", auto: true, timeout: 60_000 },
	],
	/**
	 * Unproven sends open Prove Human once per tab. Tests that aren't about
	 * it start as if the operator chose "Send without proving".
	 */
	proveSends: [false, { option: true }],
	page: async ({ page, proveSends }, use) => {
		if (!proveSends)
			await page.addInitScript(() => {
				try {
					sessionStorage.setItem("pulsar.sendUnproven", "1");
				} catch {}
			});
		await use(page);
	},
	errors: [
		async ({ page, browserName }, use) => {
			const errors: string[] = [];
			// WebKit names the page, not the script, in a CSP report on the console,
			// and logs a style attribute even in an inert parsed document (Mermaid's
			// DOMPurify pass, d3 on its scratch nodes), where nothing is applied. The
			// page's securitypolicyviolation event names the real source: count the
			// events from Mermaid and the libraries it loads that hit no element on
			// the page, and excuse that many of WebKit's refused-style reports. Any
			// other report (app code, a style the page really lost) still fails.
			const webkit = browserName === "webkit";
			let mermaidStyleEvents = 0;
			if (webkit) {
				await page.exposeFunction("__pulsarMermaidStyle", () => {
					mermaidStyleEvents++;
				});
				await page.addInitScript(() => {
					document.addEventListener(
						"securitypolicyviolation",
						(e) => {
							if (!/^style-src-(attr|elem)$/.test(e.violatedDirective)) return;
							if (
								!/\/(mermaid|d3-|cytoscape|purify)[^/]*\.js$/.test(e.sourceFile)
							)
								return;
							if (e.target instanceof Element && e.target.isConnected) return;
							void (
								window as unknown as {
									__pulsarMermaidStyle: () => Promise<void>;
								}
							).__pulsarMermaidStyle();
						},
						true,
					);
				});
			}
			// WebKit reports a request that a navigation (a reload) cancelled
			// as an access-control failure. Same-origin API calls can't fail
			// CORS here.
			const cancelledFetch = (text: string) =>
				/\/api\/v1\/\S* due to access control checks\.$/.test(text) &&
				text.includes(new URL(page.url()).host);
			page.on("console", (m) => {
				if (m.type() !== "error") return;
				// Mermaid measures text in a scratch element with a <style> and a
				// style attribute; CSP blocks both there (the inserted diagram is
				// restyled through CSSOM). Everything else must be clean.
				const url = m.location().url;
				// Review screenshots only (PULSAR_BLOCK_SHOTS): WebKit element
				// screenshots add Playwright's own stylesheet, which the CSP refuses.
				if (
					process.env.PULSAR_BLOCK_SHOTS &&
					/^Refused to apply a stylesheet/.test(m.text())
				)
					return;
				// Linux WebKit doesn't know the viewport's interactive-widget key
				// (Safari and Chromium do); it says so and ignores it.
				if (/Viewport argument key "interactive-widget"/.test(m.text())) return;
				// Linux WebKit logs a cancelled request as a console error.
				if (cancelledFetch(m.text())) return;
				// Mermaid and the libraries it loads (d3, and cytoscape for some
				// diagram kinds) try inline styles; the CSP refuses them, by design.
				if (
					/Content Security Policy/.test(m.text()) &&
					/\/(mermaid|d3-|cytoscape)[^/]*\.js/.test(url)
				)
					return;
				errors.push(m.text());
			});
			page.on("pageerror", (e) => {
				// macOS WebKit logs the same message as a JavaScript error, which
				// Playwright reports as a page error split at its first colon
				// (name "Fetch API cannot load http", message "/127.0.0.1:…").
				if (
					e.name.startsWith("Fetch API cannot load") &&
					cancelledFetch(`${e.name}:${e.message}`)
				)
					return;
				errors.push(e.message);
			});
			page.on("dialog", (d) => {
				errors.push(`dialog: ${d.message()}`);
				void d.dismiss();
			});
			await use(errors);
			if (webkit) {
				// Violation events are queued tasks: let any still pending arrive.
				await page
					.evaluate(() => new Promise((r) => setTimeout(r, 0)))
					.catch(() => {});
				// The reports stay in `errors` until now, so a test that drops the
				// ones its own screenshots cause (see ui.ios) still finds them.
				for (let i = errors.length - 1; i >= 0 && mermaidStyleEvents > 0; i--)
					if (/^Refused to apply a stylesheet/.test(errors[i] ?? "")) {
						errors.splice(i, 1);
						mermaidStyleEvents--;
					}
			}
			expect(errors, "console errors / CSP violations / dialogs").toEqual([]);
		},
		{ auto: true },
	],
});

export { expect };

export async function agentId(
	request: APIRequestContext,
	selector: string,
): Promise<string> {
	const res = await request.get(
		`/api/v1/agents?selector=${encodeURIComponent(selector)}&limit=1`,
		{
			headers: { "X-Pulsar": "1" },
		},
	);
	const body = (await res.json()) as { items: { id: string }[] };
	const id = body.items[0]?.id;
	if (!id) throw new Error(`no agent for ${selector}`);
	return id;
}

export async function ready(page: Page) {
	await page.goto("/");
	await expect(page.locator('[data-node="m:studio"]')).toBeVisible();
	// The phone's Home search paints as a plain input and swaps in Konsta's
	// once its chunk loads: text typed during that swap goes to the input
	// that is removed. Wait for the swap (no plain input on the desktop).
	await expect(page.locator(".p-search-plain")).toHaveCount(0);
}

export const SHOTS = new URL("../screenshots/", import.meta.url).pathname;

/**
 * A virtual platform authenticator (stands in for Touch ID) with a passkey
 * registered for this page's origin, through the API (no code: any device
 * of the operator's may register). Open the page on `localhost` first:
 * WebAuthn needs a host name.
 */
export async function withPasskey(
	page: Page,
	request: APIRequestContext,
	context: import("@playwright/test").BrowserContext,
	/** `mock: false` on the real daemon (no mock reset endpoint). */
	opts: { mock?: boolean } = {},
) {
	if (opts.mock !== false) await resetPasskeys(request);
	await addAuthenticator(page, context);
	await registerPasskey(page);
}

/** Register with the authenticator installed on this page, verified by the server. */
export async function registerPasskey(page: Page) {
	const ok = await page.evaluate(async () => {
		const b64 = (s: string) =>
			Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
				c.charCodeAt(0),
			);
		const enc = (b: ArrayBuffer) =>
			btoa(String.fromCharCode(...new Uint8Array(b)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		const h = { "X-Pulsar": "1", "Content-Type": "application/json" };
		const o = await (
			await fetch("/api/v1/passkeys/register/options", {
				method: "POST",
				headers: h,
				body: JSON.stringify({ label: "Mac" }),
			})
		).json();
		const opts = o.options;
		const cred = (await navigator.credentials.create({
			publicKey: {
				...opts,
				challenge: b64(opts.challenge),
				user: { ...opts.user, id: b64(opts.user.id) },
				excludeCredentials: (opts.excludeCredentials ?? []).map(
					(c: { id: string }) => ({ ...c, id: b64(c.id) }),
				),
			},
		})) as PublicKeyCredential;
		const r = cred.response as AuthenticatorAttestationResponse;
		const res = await fetch("/api/v1/passkeys/register/verify", {
			method: "POST",
			headers: h,
			body: JSON.stringify({
				response: {
					id: cred.id,
					rawId: enc(cred.rawId),
					type: cred.type,
					clientExtensionResults: {},
					response: {
						clientDataJSON: enc(r.clientDataJSON),
						attestationObject: enc(r.attestationObject),
						transports: r.getTransports?.() ?? ["internal"],
					},
				},
			}),
		});
		// What the app notes once this browser has a passkey.
		if (res.ok) localStorage.setItem("pulsar.passkey", "1");
		return res.ok;
	});
	expect(ok).toBe(true);
}

/** A virtual platform authenticator (Face ID / Touch ID) for this page; Chromium only. */
export async function addAuthenticator(
	page: Page,
	context: import("@playwright/test").BrowserContext,
) {
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await cdp.send(
		"WebAuthn.addVirtualAuthenticator",
		{
			options: {
				protocol: "ctap2",
				transport: "internal",
				hasUserVerification: true,
				isUserVerified: true,
				hasResidentKey: true,
			},
		},
	);
	return { cdp, authenticatorId };
}

/** Proves the operator is human in the open Prove Human sheet (one tap; Face ID is virtual). */
export async function proveInSheet(page: Page) {
	const sheet = page.getByRole("dialog", { name: "Prove Human" });
	await expect(sheet).toBeVisible();
	await sheet.getByRole("button", { name: /^Prove with/ }).click();
	await expect(sheet).toHaveCount(0);
}

/** The mock's base URL on `localhost` (WebAuthn refuses IP addresses). */
export function localhostBase() {
	return test.info().project.use.baseURL!.replace("127.0.0.1", "localhost");
}

/** Mock only: no passkeys and no passkey sessions (tests start clean). */
export async function resetPasskeys(request: APIRequestContext) {
	await request.post("/api/v1/__mock/reset-passkeys", {
		headers: { "X-Pulsar": "1" },
	});
}
