import {
	type APIRequestContext,
	test as base,
	expect,
	type Page,
} from "@playwright/test";

/**
 * Every test fails on a console error, an uncaught exception, a CSP
 * violation (they log as console errors) or a dialog (an XSS `alert`).
 * Tests that render Mermaid allow its style-src violations (see below).
 */
export const test = base.extend<{ errors: string[]; proveSends: boolean }>({
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
		async ({ page }, use) => {
			const errors: string[] = [];
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
				if (
					/Content Security Policy/.test(m.text()) &&
					/\/(mermaid|d3-)[^/]*\.js/.test(url)
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
