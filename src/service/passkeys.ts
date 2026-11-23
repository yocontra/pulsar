import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "../canonical.ts";
import type { ApprovalDecision, PasskeyInfo } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";

/**
 * Passkeys for approvals (WebAuthn). Every approve or deny is signed by a
 * platform authenticator with user verification (Face ID / Touch ID); the
 * challenge is derived from the exact prompt and answer, used once, and short
 * lived, so a signature can't be replayed or moved to another prompt.
 *
 * Registration: any request from the operator's Tailscale identity may
 * register a platform passkey; user verification is required. The UV flag
 * is the authenticator's own claim (no attestation), so a process that
 * scripts a software authenticator on a device signed in to the tailnet as
 * the operator could register one: an accepted residual (SECURITY.md).
 *
 * Relying party: the tailnet's MagicDNS suffix, shared by every node
 * (`tailnetRpId`); credentials stay per node.
 *
 * `@simplewebauthn/server` loads on first use, so the daemon's startup and
 * the CLI never pay for it.
 */

export interface StoredPasskey {
	id: string;
	publicKey: Uint8Array;
	login: string;
	rpId: string;
	counter: number;
	transports: string[];
	label: string;
	createdAt: number;
	lastUsedAt: number | null;
}

/** Where passkeys live: SQLite in the daemon, memory in the mock and tests. */
export interface PasskeyStore {
	list(login: string, rpId: string): StoredPasskey[];
	add(p: StoredPasskey): void;
	/** Records a use: the authenticator's new counter and the time. */
	touch(id: string, counter: number, at: number): void;
	remove(id: string): boolean;
	all(): StoredPasskey[];
	/** A stable random WebAuthn user handle per login (base64url). */
	userHandle(login: string): string;
}

/** The relying party a request is served under: its RP id and allowed origins. */
export interface RelyingParty {
	rpId: string;
	origins: string[];
	/**
	 * The node that enrolls (its machine name). The RP id is shared by the
	 * tailnet, so the passkey's user name says which machine it is for.
	 */
	node?: string;
}

/** Everything one signature covers. */
export interface ApprovalBinding {
	requestId: string;
	inputHash: string;
	agentId: string;
	decision: ApprovalDecision;
	/** sha256 of the canonical session grant (allow-session), else "". */
	grantHash: string;
	/** sha256 of the note sent with a deny, else "": a relay can't change it. */
	noteHash: string;
	expiresAt: number;
}

/** Which passkey signed. How a decision is shown comes from the request, not from here (see `proverLabel`). */
export interface Signer {
	credentialId: string;
	/** The passkey's label: the device it was registered on, not always the one that used it. */
	device: string;
	method: string;
}

interface Pending<T> {
	login: string;
	rpId: string;
	expiresAt: number;
	data: T;
}

/** How long `any()` trusts its last read of the store. */
const ANY_TTL_MS = 30_000;
/** How long a challenge stays usable. */
const CHALLENGE_MS = 2 * 60_000;
/** Open challenges per login, requester and prompt (or kind); a full bucket drops its own oldest. */
const MAX_PER_BUCKET = 5;
/** Open challenges one requester may hold in all (well under MAX_PENDING). */
const MAX_PER_REQUESTER = 20;
const MAX_PENDING = 200;

/** sha256 of the canonical `payload`, then the nonce: the challenge bytes. */
function challengeBytes(payload: unknown, nonce: string): Buffer {
	return createHash("sha256")
		.update(canonicalJson(payload))
		.update(nonce)
		.digest();
}

/** The challenge bytes for a binding and a fresh nonce. */
function bindingChallenge(b: ApprovalBinding, nonce: string): Buffer {
	// Fields listed one by one: extra keys on `b` must not change the hash.
	return challengeBytes(
		{
			v: 1,
			requestId: b.requestId,
			inputHash: b.inputHash,
			agentId: b.agentId,
			decision: b.decision,
			grantHash: b.grantHash,
			noteHash: b.noteHash,
			expiresAt: b.expiresAt,
		},
		nonce,
	);
}

/** What one challenge is for: deciding one prompt, or a session sign-in. */
export type Purpose =
	| { kind: "approval"; binding: ApprovalBinding }
	| { kind: "session"; context: string }
	/** Interrupting one agent (a Stop relayed to its home node). */
	| { kind: "stop"; agent: string }
	/**
	 * One acting op relayed to its home node (src/service/acting.ts): the op,
	 * its target, and a digest of its exact parameters.
	 */
	| { kind: "act"; op: string; target: string; digest: string };

/** The challenge bytes for a purpose and a fresh nonce. */
function purposeChallenge(purpose: Purpose, nonce: string): Buffer {
	if (purpose.kind === "approval")
		return bindingChallenge(purpose.binding, nonce);
	if (purpose.kind === "stop")
		return challengeBytes(
			{ v: 1, purpose: "stop", agent: purpose.agent },
			nonce,
		);
	if (purpose.kind === "act")
		return challengeBytes(
			{
				v: 1,
				purpose: "act",
				op: purpose.op,
				target: purpose.target,
				digest: purpose.digest,
			},
			nonce,
		);
	return challengeBytes(
		{ v: 1, purpose: "session", context: purpose.context },
		nonce,
	);
}

/** Tailscale whois OS names as shown ("macOS" → "Mac"). */
const OS_NAMES: Record<string, string> = {
	macos: "Mac",
	ios: "iOS",
	android: "Android",
	windows: "Windows",
	linux: "Linux",
};

/**
 * The device that proved a decision, from the request's Tailscale node and
 * OS: "Mac (contra-m2-mbp)", or the node alone when the OS is unknown. Never
 * the passkey's label: a synced passkey (iCloud Keychain) keeps the name of
 * the device it was registered on, whichever device uses it.
 */
export function proverLabel(p: { node?: string; os?: string }): string | null {
	const node = p.node?.trim() ? cleanLabel(p.node) : null;
	const os = OS_NAMES[(p.os ?? "").toLowerCase()];
	if (os && node) return `${os} (${node})`;
	return node ?? os ?? null;
}

/** "Face ID" on iOS, "Touch ID" on a Mac; a plain passkey elsewhere or when the OS is unknown. */
export function proverMethod(os: string | undefined): string {
	const o = (os ?? "").toLowerCase();
	if (o === "ios") return "Face ID";
	if (o === "macos") return "Touch ID";
	return "passkey";
}

/** The challenge a WebAuthn response answered (from its clientDataJSON). */
function challengeOf(response: unknown): string | null {
	const data = (response as { response?: { clientDataJSON?: unknown } })
		?.response?.clientDataJSON;
	if (typeof data !== "string") return null;
	try {
		const parsed = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
		return typeof parsed?.challenge === "string" ? parsed.challenge : null;
	} catch {
		return null;
	}
}

const bad = (message: string) => new RpcError("bad_assertion", message);
type Lib = typeof import("@simplewebauthn/server");
let lib: Promise<Lib> | null = null;
const webauthn = () => {
	lib ??= import("@simplewebauthn/server");
	return lib;
};

export class Passkeys {
	private registrations = new Map<
		string,
		Pending<{ label: string; requester: string }>
	>();
	private assertions = new Map<
		string,
		Pending<{ purpose: Purpose; nonce: string; requester: string }>
	>();
	private readonly store: PasskeyStore;
	private readonly now: () => number;
	private anyCache: { at: number; any: boolean } | null = null;

	constructor(store: PasskeyStore, now: () => number = Date.now) {
		this.store = store;
		this.now = now;
	}

	/**
	 * Whether any passkey is enrolled. Polled every second or two (can the
	 * app answer?), so the database read is kept for `ANY_TTL_MS`; this
	 * class's own add and remove clear it at once.
	 */
	any(): boolean {
		const at = this.now();
		if (!this.anyCache || at - this.anyCache.at >= ANY_TTL_MS)
			this.anyCache = { at, any: this.store.all().length > 0 };
		return this.anyCache.any;
	}

	list(): PasskeyInfo[] {
		return this.store.all().map((p) => ({
			id: p.id,
			label: p.label,
			createdAt: p.createdAt,
			lastUsedAt: p.lastUsedAt,
		}));
	}

	remove(id: string): boolean {
		this.anyCache = null;
		return this.store.remove(id);
	}

	/** True when this login has a passkey under this RP. */
	has(login: string, rp: RelyingParty): boolean {
		return this.store.list(login, rp.rpId).length > 0;
	}

	/**
	 * Registration options for the operator's device (the caller checked the
	 * Tailscale identity). A platform authenticator with user verification
	 * required: Face ID, Touch ID, Windows Hello or the device PIN.
	 */
	async registrationOptions(
		login: string,
		rp: RelyingParty,
		opts: { label: string; requester?: string },
	) {
		const existing = this.store.list(login, rp.rpId);
		const { generateRegistrationOptions } = await webauthn();
		const options = await generateRegistrationOptions({
			rpName: "pulsar",
			rpID: rp.rpId,
			// Shared RP id: name the machine, so the phone's picker tells them apart
			// (each node also has its own random user id).
			userName: rp.node ? `${login} (${rp.node})` : login,
			userDisplayName: rp.node ? `${login} on ${rp.node}` : login,
			userID: Buffer.from(this.store.userHandle(login), "base64url"),
			attestationType: "none",
			timeout: CHALLENGE_MS,
			excludeCredentials: existing.map((p) => ({
				id: p.id,
				transports: p.transports,
			})),
			authenticatorSelection: {
				authenticatorAttachment: "platform",
				residentKey: "preferred",
				userVerification: "required",
			},
		});
		// Bounded per requesting node like assertions, so a flood from one
		// node can't fill the table and lock another out of its first passkey.
		const requester = opts.requester ?? "local";
		this.gc();
		dropOldest(
			this.registrations,
			(r) => r.data.requester === requester,
			MAX_PER_BUCKET,
		);
		this.remember(this.registrations, options.challenge, {
			login,
			rpId: rp.rpId,
			expiresAt: this.now() + CHALLENGE_MS,
			data: { label: cleanLabel(opts.label), requester },
		});
		return options;
	}

	async verifyRegistration(
		login: string,
		rp: RelyingParty,
		response: unknown,
	): Promise<PasskeyInfo> {
		const challenge = challengeOf(response);
		const pending = challenge ? this.registrations.get(challenge) : undefined;
		if (challenge) this.registrations.delete(challenge);
		if (
			!challenge ||
			!pending ||
			pending.login !== login ||
			pending.rpId !== rp.rpId
		)
			throw bad("unknown or used registration challenge");
		if (pending.expiresAt <= this.now())
			throw bad("the registration expired; try again");
		const { verifyRegistrationResponse } = await webauthn();
		let result: Awaited<ReturnType<Lib["verifyRegistrationResponse"]>>;
		try {
			result = await verifyRegistrationResponse({
				response: response as Parameters<
					Lib["verifyRegistrationResponse"]
				>[0]["response"],
				expectedChallenge: challenge,
				expectedOrigin: rp.origins,
				expectedRPID: rp.rpId,
				requireUserVerification: true,
			});
		} catch (e) {
			throw bad((e as Error).message);
		}
		if (!result.verified) throw bad("the passkey could not be verified");
		const cred = result.registrationInfo.credential;
		const now = this.now();
		const stored: StoredPasskey = {
			id: cred.id,
			publicKey: new Uint8Array(cred.publicKey),
			login,
			rpId: rp.rpId,
			counter: cred.counter,
			transports: cred.transports ?? [],
			label: pending.data.label,
			createdAt: now,
			lastUsedAt: null,
		};
		this.store.add(stored);
		this.anyCache = null;
		return {
			id: stored.id,
			label: stored.label,
			createdAt: now,
			lastUsedAt: null,
		};
	}

	/** Request options whose challenge covers `binding` (one use, two minutes). */
	assertionOptions(
		login: string,
		rp: RelyingParty,
		binding: ApprovalBinding,
		requester = "local",
	) {
		return this.issue(
			login,
			rp,
			{ kind: "approval", binding },
			binding.expiresAt,
			requester,
		);
	}

	/**
	 * Verifies a signature over `binding` (the prompt as it is now, and the
	 * answer being sent). The challenge is spent whether or not this succeeds.
	 */
	verifyAssertion(
		login: string,
		rp: RelyingParty,
		binding: ApprovalBinding,
		assertion: unknown,
	): Promise<Signer> {
		return this.check(login, rp, { kind: "approval", binding }, assertion);
	}

	/**
	 * Request options for a passkey session (the app's signed-in state, for
	 * actions that need a recent Face ID / Touch ID but not one prompt).
	 * `context` is bound into the challenge, e.g. a session id the caller
	 * created; pass the same one to `verifySession`. One WebAuthn
	 * implementation for approvals and sessions.
	 */
	sessionOptions(
		login: string,
		rp: RelyingParty,
		context: string,
		requester = "local",
	) {
		return this.issue(
			login,
			rp,
			{ kind: "session", context },
			Number.POSITIVE_INFINITY,
			requester,
		);
	}

	/** Verifies a session sign-in for `context` (single use, two minutes, user verification required). */
	verifySession(
		login: string,
		rp: RelyingParty,
		context: string,
		assertion: unknown,
	): Promise<Signer> {
		return this.check(login, rp, { kind: "session", context }, assertion);
	}

	/** Request options for interrupting one agent (single use, two minutes). */
	stopOptions(
		login: string,
		rp: RelyingParty,
		agent: string,
		requester = "local",
	) {
		return this.issue(
			login,
			rp,
			{ kind: "stop", agent },
			Number.POSITIVE_INFINITY,
			requester,
		);
	}

	/** Verifies a signature for stopping `agent`. */
	verifyStop(
		login: string,
		rp: RelyingParty,
		agent: string,
		assertion: unknown,
	): Promise<Signer> {
		return this.check(login, rp, { kind: "stop", agent }, assertion);
	}

	/**
	 * Request options for one acting op (single use, two minutes). The
	 * challenge covers the op, its target and `digest` (its parameters).
	 */
	actOptions(
		login: string,
		rp: RelyingParty,
		act: { op: string; target: string; digest: string },
		requester = "local",
	) {
		return this.issue(
			login,
			rp,
			{ kind: "act", ...act },
			Number.POSITIVE_INFINITY,
			requester,
		);
	}

	/** Verifies a signature for exactly this op, target and parameter digest. */
	verifyAct(
		login: string,
		rp: RelyingParty,
		act: { op: string; target: string; digest: string },
		assertion: unknown,
	): Promise<Signer> {
		return this.check(login, rp, { kind: "act", ...act }, assertion);
	}

	private async issue(
		login: string,
		rp: RelyingParty,
		purpose: Purpose,
		until: number,
		requester: string,
	) {
		const creds = this.store.list(login, rp.rpId);
		if (creds.length === 0)
			throw new RpcError(
				"no_passkey",
				"Register a passkey for this browser first",
			);
		this.gc();
		// Bounded per requester: at most 5 open challenges of one kind (per
		// prompt for approvals) per login *and* requesting node, and 20 in all.
		// A full bucket drops its own oldest challenge, so one requester can
		// never use up another's slots (a flood from one node can't lock the
		// user's phone out); the global table cap (`remember`) bounds the rest.
		const sameBucket = (d: { purpose: Purpose; requester: string }) =>
			d.requester === requester &&
			d.purpose.kind === purpose.kind &&
			(purpose.kind !== "approval" ||
				(d.purpose.kind === "approval" &&
					d.purpose.binding.requestId === purpose.binding.requestId));
		dropOldest(
			this.assertions,
			(a) => a.login === login && sameBucket(a.data),
			MAX_PER_BUCKET,
		);
		// And in all, across prompts: many prompts can't add up to the table.
		dropOldest(
			this.assertions,
			(a) => a.data.requester === requester,
			MAX_PER_REQUESTER,
		);
		const nonce = randomBytes(16).toString("base64url");
		const { generateAuthenticationOptions } = await webauthn();
		const options = await generateAuthenticationOptions({
			rpID: rp.rpId,
			challenge: new Uint8Array(purposeChallenge(purpose, nonce)),
			timeout: CHALLENGE_MS,
			userVerification: "required",
			allowCredentials: creds.map((p) => ({
				id: p.id,
				transports: p.transports,
			})),
		});
		this.remember(this.assertions, options.challenge, {
			login,
			rpId: rp.rpId,
			expiresAt: Math.min(this.now() + CHALLENGE_MS, until),
			data: { purpose, nonce, requester },
		});
		return options;
	}

	private async check(
		login: string,
		rp: RelyingParty,
		purpose: Purpose,
		assertion: unknown,
	): Promise<Signer> {
		const challenge = challengeOf(assertion);
		const pending = challenge ? this.assertions.get(challenge) : undefined;
		if (challenge) this.assertions.delete(challenge);
		if (!challenge || !pending) throw bad("unknown or used challenge");
		if (pending.login !== login || pending.rpId !== rp.rpId)
			throw bad("the challenge belongs to someone else");
		if (pending.expiresAt <= this.now()) throw bad("the challenge expired");
		const signed = purposeChallenge(purpose, pending.data.nonce).toString(
			"base64url",
		);
		if (signed !== challenge)
			throw bad("the signature covers a different prompt, answer or purpose");
		const id = (assertion as { id?: unknown }).id;
		const cred = this.store.list(login, rp.rpId).find((p) => p.id === id);
		if (!cred) throw bad("unknown passkey");
		const { verifyAuthenticationResponse } = await webauthn();
		let result: Awaited<ReturnType<Lib["verifyAuthenticationResponse"]>>;
		try {
			result = await verifyAuthenticationResponse({
				response: assertion as Parameters<
					Lib["verifyAuthenticationResponse"]
				>[0]["response"],
				expectedChallenge: challenge,
				expectedOrigin: rp.origins,
				expectedRPID: rp.rpId,
				requireUserVerification: true,
				credential: {
					id: cred.id,
					publicKey: new Uint8Array(cred.publicKey),
					counter: cred.counter,
					transports: cred.transports as never,
				},
			});
		} catch (e) {
			throw bad((e as Error).message);
		}
		if (!result.verified || !result.authenticationInfo.userVerified)
			throw bad("Face ID / Touch ID did not verify");
		this.store.touch(cred.id, result.authenticationInfo.newCounter, this.now());
		return {
			credentialId: cred.id,
			device: cred.label,
			method: "passkey",
		};
	}

	/** Remembers a challenge. When full, new ones are refused: nobody can evict the user's open sign-in. */
	private remember<T>(
		map: Map<string, Pending<T>>,
		key: string,
		value: Pending<T>,
	) {
		this.gc();
		if (map.size >= MAX_PENDING)
			throw new RpcError(
				"rate_limited",
				"Too many sign-ins are open. Wait a minute and try again.",
			);
		map.set(key, value);
	}

	private gc() {
		const now = this.now();
		for (const map of [this.registrations, this.assertions])
			for (const [k, v] of map) if (v.expiresAt <= now) map.delete(k);
	}
}

/** Deletes the oldest matching entries (insertion order) so one more fits under `max`. */
function dropOldest<T>(
	map: Map<string, T>,
	matches: (v: T) => boolean,
	max: number,
) {
	const keys = [...map].filter(([, v]) => matches(v)).map(([k]) => k);
	for (const key of keys.slice(0, Math.max(0, keys.length - max + 1)))
		map.delete(key);
}

/** A device name as shown ("iPhone"): no control characters, at most 40, else "browser". */
export function cleanLabel(label: unknown): string {
	const s = typeof label === "string" ? label : "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strip control characters
	const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	return clean.slice(0, 40) || "browser";
}

/** Passkeys in memory (tests and the development mock). */
export class MemoryPasskeyStore implements PasskeyStore {
	private keys = new Map<string, StoredPasskey>();
	private handles = new Map<string, string>();
	list(login: string, rpId: string) {
		return [...this.keys.values()].filter(
			(p) => p.login === login && p.rpId === rpId,
		);
	}
	add(p: StoredPasskey) {
		this.keys.set(p.id, p);
	}
	touch(id: string, counter: number, at: number) {
		const p = this.keys.get(id);
		if (p) {
			p.counter = counter;
			p.lastUsedAt = at;
		}
	}
	remove(id: string) {
		return this.keys.delete(id);
	}
	all() {
		return [...this.keys.values()];
	}
	userHandle(login: string) {
		let h = this.handles.get(login);
		if (!h) {
			h = randomBytes(16).toString("base64url");
			this.handles.set(login, h);
		}
		return h;
	}
}
