import { expect } from "bun:test";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";

/** A browser's side of Web Push in tests: its keys and RFC 8291 decryption. */

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, len: number) {
	const prk = createHmac("sha256", salt).update(ikm).digest();
	return createHmac("sha256", prk)
		.update(Buffer.concat([info, Buffer.from([1])]))
		.digest()
		.subarray(0, len);
}

/** Decrypts one aes128gcm record the way the browser does. */
export function decrypt(body: Buffer, uaPrivate: Buffer, auth: Buffer): Buffer {
	const salt = body.subarray(0, 16);
	const idlen = body[20]!;
	const asPublic = body.subarray(21, 21 + idlen);
	const ct = body.subarray(21 + idlen);
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(uaPrivate);
	const uaPublic = ecdh.getPublicKey();
	const secret = ecdh.computeSecret(asPublic);
	const ikm = hkdf(
		auth,
		secret,
		Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
		32,
	);
	const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);
	const d = createDecipheriv("aes-128-gcm", cek, nonce);
	d.setAuthTag(ct.subarray(ct.length - 16));
	const plain = Buffer.concat([
		d.update(ct.subarray(0, ct.length - 16)),
		d.final(),
	]);
	expect(plain[plain.length - 1]).toBe(2);
	return plain.subarray(0, plain.length - 1);
}

/** A browser's push subscription keys (and the private half to decrypt). */
export function browser() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = Buffer.from("0123456789abcdef");
	return {
		priv: ecdh.getPrivateKey(),
		auth,
		keys: {
			p256dh: ecdh.getPublicKey().toString("base64url"),
			auth: auth.toString("base64url"),
		},
	};
}
