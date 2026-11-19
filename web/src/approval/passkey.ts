/**
 * The passkey step for approvals. Lazy: only the approval card imports this,
 * so WebAuthn code stays out of the startup bundle.
 *
 * 1. Ask the daemon for request options for this prompt and this answer; the
 *    challenge covers the request id, the tool-input hash, the agent, the
 *    answer and the expiry, and works once.
 * 2. Sign with the platform authenticator (user verification required), and
 *    send the decision with the signature.
 *
 * That is for a prompt on another machine. A prompt on this machine is
 * answered with the browser's passkey session instead (see `signAndDecide`).
 */
import {
	browserSupportsWebAuthn,
	platformAuthenticatorIsAvailable,
	startAuthentication,
} from "@simplewebauthn/browser";
import {
	ApiError,
	api,
	ensureSession,
	hasSessionToken,
	sessionReady,
	setSessionToken,
} from "../api/client.ts";
import type {
	Approval,
	ApprovalDecision,
	DecideResponse,
	InteractionAnswer,
} from "../api/types.ts";

export type Support = "platform" | "no-platform" | "unsupported";

export async function support(): Promise<Support> {
	if (!browserSupportsWebAuthn()) return "unsupported";
	try {
		return (await platformAuthenticatorIsAvailable())
			? "platform"
			: "no-platform";
	} catch {
		return "no-platform";
	}
}

/** This browser has no passkey on this machine yet: Prove Human first. */
export class NeedsProof extends Error {
	constructor() {
		super("Prove you're human on this device first.");
	}
}

/** The prompt is another machine's, and this browser has no passkey there. */
export class RemoteNeedsProof extends Error {
	constructor() {
		super(
			"This prompt is on another machine. Open Pulsar on that machine and prove you're human there, then approve it.",
		);
	}
}

const FLAG = "pulsar.passkey";

/** True once this browser registered or used a passkey (a hint, not a security check). */
export function hasPasskey(): boolean {
	try {
		return Boolean(localStorage.getItem(FLAG));
	} catch {
		return false;
	}
}

export function rememberPasskey() {
	try {
		localStorage.setItem(FLAG, "1");
	} catch {}
}

/** The hint was wrong (the passkey was removed): the next Prove Human registers. */
export function forgetPasskey() {
	try {
		localStorage.removeItem(FLAG);
	} catch {}
}

/** "iPhone", "Mac", "Android", "this browser". */
export function deviceName() {
	const ua = navigator.userAgent;
	if (/iPhone/.test(ua)) return "iPhone";
	if (/iPad/.test(ua)) return "iPad";
	if (/Android/.test(ua)) return "Android";
	if (/Mac/.test(ua)) return "Mac";
	if (/Windows/.test(ua)) return "Windows PC";
	if (/CrOS/.test(ua)) return "Chromebook";
	if (/Linux/.test(ua)) return "Linux PC";
	return "this browser";
}

type RequestJSON = Parameters<typeof startAuthentication>[0]["optionsJSON"];

/** Request options for this answer, or null when the machine has no passkey yet. */
async function options(
	requestId: string,
	decision: ApprovalDecision,
	note: string | undefined,
	answer: InteractionAnswer | undefined,
): Promise<RequestJSON | null> {
	const r = await api.approvalOptions(requestId, decision, note, answer);
	return "options" in r ? (r.options as unknown as RequestJSON) : null;
}

/**
 * Answers one prompt. A prompt on this machine goes with this browser's
 * passkey session (Prove Human once, then no more Face ID per answer): the
 * daemon checks the session and that `card`'s input hash (and listed rules)
 * are the prompt's own. Unproven, Prove Human opens first (`onStep("prove")`);
 * a passkey made there starts the session, so the answer needs no second
 * check. Another machine's prompt is signed with the passkey: that machine
 * verifies it itself and never takes this machine's session. Throws
 * `ProveCancelled` when the operator closes Prove Human, `RemoteNeedsProof`
 * when the other machine doesn't know this device.
 */
export async function signAndDecide(
	requestId: string,
	decision: ApprovalDecision,
	opts: {
		note?: string;
		/** With `decision: "answer"`: the interaction's answer (signed with it). */
		answer?: InteractionAnswer;
		/** The card the operator answered: what the session decision is bound to. */
		card?: Pick<Approval, "inputHash" | "sessionRules">;
		onStep?: (step: "prove" | "sign" | "send") => void;
	} = {},
): Promise<DecideResponse> {
	const remote = requestId.includes("/");
	if (!remote && opts.card) return decideWithSession(requestId, decision, opts);
	const request = await options(requestId, decision, opts.note, opts.answer);
	// Another machine's prompt: that machine issued the challenge over its own
	// passkeys, so a passkey made here would not count there.
	if (!request) throw remote ? new RemoteNeedsProof() : new NeedsProof();
	opts.onStep?.("sign");
	let assertion: Awaited<ReturnType<typeof startAuthentication>>;
	try {
		assertion = await startAuthentication({ optionsJSON: request });
	} catch (e) {
		// No passkey in this browser for this machine: make one first.
		if (!hasPasskey()) throw remote ? new RemoteNeedsProof() : new NeedsProof();
		throw e;
	}
	rememberPasskey();
	opts.onStep?.("send");
	return api.decide(requestId, {
		decision,
		...(opts.note ? { note: opts.note } : {}),
		...(opts.answer ? { answer: opts.answer } : {}),
		assertion: assertion as unknown as Record<string, unknown>,
	});
}

/** A prompt on this machine, answered with the passkey session (asks once if it lapsed). */
async function decideWithSession(
	requestId: string,
	decision: ApprovalDecision,
	opts: {
		note?: string;
		answer?: InteractionAnswer;
		card?: Pick<Approval, "inputHash" | "sessionRules">;
		onStep?: (step: "prove" | "sign" | "send") => void;
	},
): Promise<DecideResponse> {
	const card = opts.card!;
	const body = {
		decision,
		...(opts.note ? { note: opts.note } : {}),
		...(opts.answer ? { answer: opts.answer } : {}),
		inputHash: card.inputHash,
		...(decision === "allow-session"
			? { sessionRules: card.sessionRules ?? null }
			: {}),
	};
	const proveFirst = async () => {
		await sessionReady();
		if (hasSessionToken()) return;
		opts.onStep?.("prove");
		await ensureSession("approve");
	};
	await proveFirst();
	opts.onStep?.("send");
	try {
		return await api.decide(requestId, body);
	} catch (e) {
		// The session lapsed or was revoked: prove again once, then answer.
		if (!(e instanceof ApiError) || e.code !== "session_required") throw e;
		setSessionToken(null);
		await proveFirst();
		opts.onStep?.("send");
		return api.decide(requestId, body);
	}
}
