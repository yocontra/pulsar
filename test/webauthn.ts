import {
	createHash,
	generateKeyPairSync,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";

/**
 * A software platform authenticator for tests: makes WebAuthn registration
 * and assertion responses (P-256, "none" attestation) the way a browser hands
 * them to `@simplewebauthn/server`.
 */

type Cbor = number | string | Uint8Array | Map<number | string, Cbor>;

function head(major: number, n: number): Buffer {
	if (n < 24) return Buffer.from([(major << 5) | n]);
	if (n < 256) return Buffer.from([(major << 5) | 24, n]);
	if (n < 65536) {
		const b = Buffer.alloc(3);
		b[0] = (major << 5) | 25;
		b.writeUInt16BE(n, 1);
		return b;
	}
	const b = Buffer.alloc(5);
	b[0] = (major << 5) | 26;
	b.writeUInt32BE(n, 1);
	return b;
}

function cbor(v: Cbor): Buffer {
	if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
	if (typeof v === "string") {
		const b = Buffer.from(v, "utf8");
		return Buffer.concat([head(3, b.length), b]);
	}
	if (v instanceof Uint8Array)
		return Buffer.concat([head(2, v.length), Buffer.from(v)]);
	const parts = [head(5, v.size)];
	for (const [k, val] of v) parts.push(cbor(k), cbor(val));
	return Buffer.concat(parts);
}

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

export interface AuthenticatorOptions {
	origin: string;
	rpId: string;
	/** Clear to fake an authenticator without Face ID / Touch ID. */
	userVerified?: boolean;
}

export class SoftAuthenticator {
	readonly credentialId = randomBytes(16);
	private readonly key: KeyObject;
	private readonly pub: KeyObject;
	counter = 0;
	readonly opts: AuthenticatorOptions;
	constructor(opts: AuthenticatorOptions) {
		this.opts = opts;
		const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
		this.key = pair.privateKey;
		this.pub = pair.publicKey;
	}

	get id() {
		return b64u(this.credentialId);
	}

	private flags(attested: boolean) {
		// UP (0x01), UV (0x04), AT (0x40)
		return (
			0x01 |
			(this.opts.userVerified === false ? 0 : 0x04) |
			(attested ? 0x40 : 0)
		);
	}

	private clientData(type: string, challenge: string, origin?: string) {
		return Buffer.from(
			JSON.stringify({
				type,
				challenge,
				origin: origin ?? this.opts.origin,
				crossOrigin: false,
			}),
		);
	}

	/** Answers `navigator.credentials.create` for these options. */
	register(options: { challenge: string }) {
		const jwk = this.pub.export({ format: "jwk" });
		const cose = new Map<number, Cbor>([
			[1, 2],
			[3, -7],
			[-1, 1],
			[-2, Buffer.from(jwk.x!, "base64url")],
			[-3, Buffer.from(jwk.y!, "base64url")],
		]);
		const counter = Buffer.alloc(4);
		const idLen = Buffer.alloc(2);
		idLen.writeUInt16BE(this.credentialId.length);
		const authData = Buffer.concat([
			sha(this.opts.rpId),
			Buffer.from([this.flags(true)]),
			counter,
			Buffer.alloc(16),
			idLen,
			this.credentialId,
			cbor(cose),
		]);
		const att = cbor(
			new Map<string, Cbor>([
				["fmt", "none"],
				["attStmt", new Map()],
				["authData", authData],
			]),
		);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
			response: {
				clientDataJSON: b64u(
					this.clientData("webauthn.create", options.challenge),
				),
				attestationObject: b64u(att),
				transports: ["internal"],
			},
		};
	}

	/** Answers `navigator.credentials.get` for these options. */
	assert(options: { challenge: string }, over: { origin?: string } = {}) {
		this.counter++;
		const counter = Buffer.alloc(4);
		counter.writeUInt32BE(this.counter);
		const authData = Buffer.concat([
			sha(this.opts.rpId),
			Buffer.from([this.flags(false)]),
			counter,
		]);
		const clientDataJSON = this.clientData(
			"webauthn.get",
			options.challenge,
			over.origin,
		);
		const signature = sign(
			"sha256",
			Buffer.concat([authData, sha(clientDataJSON)]),
			this.key,
		);
		return {
			id: this.id,
			rawId: this.id,
			type: "public-key",
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
			response: {
				clientDataJSON: b64u(clientDataJSON),
				authenticatorData: b64u(authData),
				signature: b64u(signature),
				userHandle: null,
			},
		};
	}
}
