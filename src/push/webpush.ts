import {
	createCipheriv,
	createECDH,
	createHmac,
	createPrivateKey,
	generateKeyPairSync,
	randomBytes,
	sign,
} from "node:crypto";

/**
 * Web Push with no dependencies: VAPID (RFC 8292) to identify this node to
 * the push service, and `aes128gcm` message encryption (RFC 8291, RFC 8188)
 * so the push service can't read the payload.
 */

export interface VapidKeys {
	/** Uncompressed P-256 point, base64url (the browser's `applicationServerKey`). */
	publicKey: string;
	/** The private key as a JWK (`d`, `x`, `y`). */
	privateJwk: { kty: "EC"; crv: "P-256"; d: string; x: string; y: string };
}

export interface Subscription {
	endpoint: string;
	keys: { p256dh: string; auth: string };
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const unb64u = (s: string) => Buffer.from(s, "base64url");

export function generateVapidKeys(): VapidKeys {
	const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const jwk = privateKey.export({ format: "jwk" }) as VapidKeys["privateJwk"];
	const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
	return {
		publicKey: b64u(pub),
		privateJwk: { kty: "EC", crv: "P-256", d: jwk.d, x: jwk.x, y: jwk.y },
	};
}

/** The `Authorization` header value for one push service origin. */
export function vapidAuthorization(
	keys: VapidKeys,
	endpoint: string,
	subject: string,
	now = Date.now(),
): string {
	const header = b64u(
		Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
	);
	const claims = b64u(
		Buffer.from(
			JSON.stringify({
				aud: new URL(endpoint).origin,
				// Push services accept at most 24 h.
				exp: Math.floor(now / 1000) + 12 * 3600,
				sub: subject,
			}),
		),
	);
	const key = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
	const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
		key,
		dsaEncoding: "ieee-p1363",
	});
	return `vapid t=${header}.${claims}.${b64u(signature)}, k=${keys.publicKey}`;
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number) {
	const prk = createHmac("sha256", salt).update(ikm).digest();
	return createHmac("sha256", prk)
		.update(Buffer.concat([info, Buffer.from([1])]))
		.digest()
		.subarray(0, length);
}

/**
 * Encrypts `payload` for one subscription: the request body for
 * `Content-Encoding: aes128gcm` (one record). `salt` and `asKey` are for
 * tests; both are random by default.
 */
export function encryptPayload(
	sub: Subscription,
	payload: Uint8Array,
	test?: { salt: Buffer; asPrivate: Buffer },
): Buffer {
	const uaPublic = unb64u(sub.keys.p256dh);
	const authSecret = unb64u(sub.keys.auth);
	if (uaPublic.length !== 65 || authSecret.length < 16)
		throw new Error("bad subscription keys");
	const ecdh = createECDH("prime256v1");
	if (test) ecdh.setPrivateKey(test.asPrivate);
	else ecdh.generateKeys();
	const asPublic = ecdh.getPublicKey();
	const secret = ecdh.computeSecret(uaPublic);
	const ikm = hkdf(
		authSecret,
		secret,
		Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
		32,
	);
	const salt = test?.salt ?? randomBytes(16);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	// One record: the payload, then the last-record delimiter (no padding).
	const body = Buffer.concat([
		cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])),
		cipher.final(),
		cipher.getAuthTag(),
	]);
	const rs = Buffer.alloc(4);
	rs.writeUInt32BE(4096);
	return Buffer.concat([
		salt,
		rs,
		Buffer.from([asPublic.length]),
		asPublic,
		body,
	]);
}

/** Push services pulsar sends to (no other hosts: a subscription can't make the daemon fetch arbitrary URLs). */
const PUSH_HOSTS = [
	/(^|\.)push\.apple\.com$/,
	/^fcm\.googleapis\.com$/,
	/^android\.googleapis\.com$/,
	/(^|\.)push\.services\.mozilla\.com$/,
	/(^|\.)notify\.windows\.com$/,
];

export function allowedEndpoint(endpoint: string): boolean {
	try {
		const u = new URL(endpoint);
		return (
			u.protocol === "https:" &&
			!u.port &&
			PUSH_HOSTS.some((re) => re.test(u.hostname))
		);
	} catch {
		return false;
	}
}
