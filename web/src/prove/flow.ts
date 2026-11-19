/**
 * The WebAuthn steps behind Prove Human. Lazy: only the sheet imports this.
 *
 * - Sign in: user verification (Face ID, Touch ID, Windows Hello or the
 *   device PIN) on a passkey this machine knows → a session.
 * - Register: a new platform passkey for this device → a passkey and a
 *   session in one step (registering already verifies the person).
 */
import {
	startAuthentication,
	startRegistration,
} from "@simplewebauthn/browser";
import { api, setSessionToken } from "../api/client.ts";
import {
	deviceName,
	forgetPasskey,
	hasPasskey,
	rememberPasskey,
} from "../approval/passkey.ts";

type RequestJSON = Parameters<typeof startAuthentication>[0]["optionsJSON"];
type CreateJSON = Parameters<typeof startRegistration>[0]["optionsJSON"];

/** One user verification on an existing passkey: a session for this browser. */
export async function signIn(): Promise<void> {
	const o = await api.sessionOptions(deviceName());
	const assertion = await startAuthentication({
		optionsJSON: o.options as RequestJSON,
	});
	const v = await api.sessionVerify(o.requestId, assertion);
	setSessionToken(v.token);
	rememberPasskey();
}

/** Registers this device's passkey and starts its session. */
export async function register(): Promise<void> {
	const { options } = await api.passkeyRegisterOptions({
		label: deviceName(),
	});
	const response = await startRegistration({
		optionsJSON: options as unknown as CreateJSON,
	});
	const r = await api.passkeyRegisterVerify(
		response as unknown as Record<string, unknown>,
	);
	setSessionToken(r.token);
	rememberPasskey();
}

/**
 * Sign in when this device has a passkey here; otherwise make one. A
 * device that holds one this browser forgot (cleared data, the installed
 * app, a synced passkey) gets InvalidStateError: sign in with it. A sign-in
 * the authenticator refuses (NotAllowedError) drops the hint: the passkey
 * may have been removed, and the next try registers instead of failing the
 * same way forever. (A device that still holds one gets InvalidStateError
 * there, the daemon excludes its passkeys, and signs in after all.)
 */
export async function prove(
	canSession: boolean,
	steps: { signIn: () => Promise<void>; register: () => Promise<void> } = {
		signIn,
		register,
	},
): Promise<void> {
	if (hasPasskey() && canSession) {
		try {
			await steps.signIn();
		} catch (e) {
			if (e instanceof Error && e.name === "NotAllowedError") forgetPasskey();
			throw e;
		}
		return;
	}
	try {
		await steps.register();
	} catch (e) {
		if (e instanceof Error && e.name === "InvalidStateError")
			await steps.signIn();
		else throw e;
	}
}
