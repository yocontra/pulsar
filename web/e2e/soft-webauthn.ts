// @ts-nocheck: browser-side byte juggling, checked by running it (the daemon verifies every response).
import type { Page } from "@playwright/test";

/**
 * A software platform authenticator inside the page, for browsers without
 * Playwright's virtual authenticator (WebKit). It answers
 * `navigator.credentials.create/get` like a passkey with user verification
 * (P-256, "none" attestation), so the daemon's real WebAuthn checks run.
 */
export async function softAuthenticator(page: Page) {
	await page.addInitScript(() => {
		const enc = new TextEncoder();
		const b64u = (b: ArrayBuffer | Uint8Array) =>
			btoa(String.fromCharCode(...new Uint8Array(b as ArrayBuffer)))
				.replace(/\+/g, "-")
				.replace(/\//g, "_")
				.replace(/=+$/, "");
		const cat = (...parts: Uint8Array[]) => {
			const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
			let o = 0;
			for (const p of parts) {
				out.set(p, o);
				o += p.length;
			}
			return out;
		};
		const head = (major: number, n: number) =>
			n < 24
				? new Uint8Array([(major << 5) | n])
				: n < 256
					? new Uint8Array([(major << 5) | 24, n])
					: new Uint8Array([(major << 5) | 25, n >> 8, n & 255]);
		type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;
		const cbor = (v: Cbor): Uint8Array => {
			if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
			if (typeof v === "string") {
				const b = enc.encode(v);
				return cat(head(3, b.length), b);
			}
			if (v instanceof Uint8Array) return cat(head(2, v.length), v);
			const parts = [head(5, v.size)];
			for (const [k, x] of v) parts.push(cbor(k), cbor(x));
			return cat(...parts);
		};
		const sha = async (b: Uint8Array) =>
			new Uint8Array(await crypto.subtle.digest("SHA-256", b));
		/** WebCrypto's raw r||s signature as DER, which WebAuthn expects. */
		const der = (raw: Uint8Array) => {
			const int = (x: Uint8Array) => {
				let i = 0;
				while (i < x.length - 1 && x[i] === 0) i++;
				let y = x.slice(i);
				if (y[0]! & 0x80) y = cat(new Uint8Array([0]), y);
				return cat(new Uint8Array([2, y.length]), y);
			};
			const body = cat(int(raw.slice(0, 32)), int(raw.slice(32)));
			return cat(new Uint8Array([0x30, body.length]), body);
		};
		const creds: Array<{
			id: Uint8Array;
			key: CryptoKey;
			rpId: string;
			user: Uint8Array;
			count: number;
		}> = [];
		const same = (a: Uint8Array, b: ArrayBuffer | ArrayBufferView) => {
			const c = new Uint8Array(
				b instanceof ArrayBuffer ? b : (b as ArrayBufferView).buffer,
			);
			return a.length === c.length && a.every((x, i) => x === c[i]);
		};
		const bytes = (b: BufferSource) =>
			new Uint8Array(
				b instanceof ArrayBuffer ? b : (b as ArrayBufferView).buffer,
			);
		// Flags: user present, user verified (Face ID / Touch ID / PIN).
		const UP_UV = 0x01 | 0x04;

		Object.defineProperty(window, "PublicKeyCredential", {
			configurable: true,
			value: Object.assign(function PublicKeyCredential() {}, {
				isUserVerifyingPlatformAuthenticatorAvailable: async () => true,
				isConditionalMediationAvailable: async () => false,
			}),
		});
		const credential = (id: Uint8Array, response: object) => ({
			id: b64u(id),
			rawId: id.buffer,
			type: "public-key",
			authenticatorAttachment: "platform",
			response,
			getClientExtensionResults: () => ({}),
		});

		// On the prototype: WebKit may hand out a fresh `navigator.credentials`
		// wrapper later, which drops own properties.
		CredentialsContainer.prototype.create = (async (
			o: CredentialCreationOptions,
		) => {
			const pk = o.publicKey!;
			const rpId = pk.rp.id ?? location.hostname;
			for (const ex of pk.excludeCredentials ?? [])
				if (creds.some((c) => same(c.id, ex.id as ArrayBuffer)))
					throw new DOMException("already registered", "InvalidStateError");
			const pair = (await crypto.subtle.generateKey(
				{ name: "ECDSA", namedCurve: "P-256" },
				false,
				["sign"],
			)) as CryptoKeyPair;
			const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
			const xy = (s: string) =>
				Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) =>
					c.charCodeAt(0),
				);
			const id = crypto.getRandomValues(new Uint8Array(16));
			const cose = cbor(
				new Map<number, Cbor>([
					[1, 2],
					[3, -7],
					[-1, 1],
					[-2, xy(jwk.x!)],
					[-3, xy(jwk.y!)],
				]),
			);
			const authData = cat(
				await sha(enc.encode(rpId)),
				new Uint8Array([UP_UV | 0x40, 0, 0, 0, 0]),
				new Uint8Array(16),
				new Uint8Array([0, id.length]),
				id,
				cose,
			);
			creds.push({
				id,
				key: pair.privateKey,
				rpId,
				user: bytes(pk.user.id),
				count: 0,
			});
			const clientDataJSON = enc.encode(
				JSON.stringify({
					type: "webauthn.create",
					challenge: b64u(bytes(pk.challenge)),
					origin: location.origin,
					crossOrigin: false,
				}),
			);
			const attestationObject = cbor(
				new Map<string, Cbor>([
					["fmt", "none"],
					["attStmt", new Map()],
					["authData", authData],
				]),
			);
			return credential(id, {
				clientDataJSON: clientDataJSON.buffer,
				attestationObject: attestationObject.buffer,
				getTransports: () => ["internal"],
			});
		}) as typeof CredentialsContainer.prototype.create;

		CredentialsContainer.prototype.get = (async (
			o: CredentialRequestOptions,
		) => {
			const pk = o.publicKey!;
			const rpId = pk.rpId ?? location.hostname;
			const allow = pk.allowCredentials ?? [];
			const cred = creds.find(
				(c) =>
					c.rpId === rpId &&
					(allow.length === 0 ||
						allow.some((a) => same(c.id, a.id as ArrayBuffer))),
			);
			if (!cred) throw new DOMException("no passkey", "NotAllowedError");
			cred.count++;
			const authData = cat(
				await sha(enc.encode(rpId)),
				new Uint8Array([
					UP_UV,
					(cred.count >> 24) & 255,
					(cred.count >> 16) & 255,
					(cred.count >> 8) & 255,
					cred.count & 255,
				]),
			);
			const clientDataJSON = enc.encode(
				JSON.stringify({
					type: "webauthn.get",
					challenge: b64u(bytes(pk.challenge)),
					origin: location.origin,
					crossOrigin: false,
				}),
			);
			const raw = new Uint8Array(
				await crypto.subtle.sign(
					{ name: "ECDSA", hash: "SHA-256" },
					cred.key,
					cat(authData, await sha(clientDataJSON)),
				),
			);
			return credential(cred.id, {
				clientDataJSON: clientDataJSON.buffer,
				authenticatorData: authData.buffer,
				signature: der(raw).buffer,
				userHandle: cred.user.buffer,
			});
		}) as typeof CredentialsContainer.prototype.get;
	});
}
