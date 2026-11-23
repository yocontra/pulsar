/**
 * Prove Human: the one place the app asks the operator for Face ID / Touch
 * ID. Any action that needs it calls `proveHuman(reason)`, which opens the
 * sheet and resolves `proven` once this browser holds a passkey session
 * (then the action carries on by itself), `skipped` when the operator sends
 * without proof (sends only), or `cancelled`.
 * The sheet and its WebAuthn code load only when it opens.
 */
import { signal } from "../lib/signals.ts";

/** Why the sheet opened: its first line says what happens next. */
export type ProveReason =
	| "approve"
	| "stop"
	| "send"
	| "notifications"
	| "remove"
	| "signout"
	/** An acting op (attach, start an agent, commit, push, PR): api.acting. */
	| "act"
	/** Switch an agent's mode, or run a slash command in its session. */
	| "control"
	| "manual";

export type ProveResult = "proven" | "skipped" | "cancelled";

export interface ProveAsk {
	reason: ProveReason;
	/** The action can go on without proof (a send, framed as unverified). */
	allowSkip: boolean;
	/** Every caller waiting on this sheet. */
	resolve: Array<(result: ProveResult) => void>;
}

/** The open sheet, or null. */
export const proveAsk = signal<ProveAsk | null>(null);

/** This browser holds a passkey session (kept in step by `setSessionToken`). */
export const proven = signal(false);

/**
 * Asks the operator to prove they're human on this device. A sheet that is
 * already open is reused (both callers get its answer).
 */
export function proveHuman(
	reason: ProveReason = "manual",
	opts: { allowSkip?: boolean } = {},
): Promise<ProveResult> {
	return new Promise((resolve) => {
		const open = proveAsk.peek();
		if (open) {
			open.resolve.push(resolve);
			return;
		}
		proveAsk.value = {
			reason,
			allowSkip: opts.allowSkip === true,
			resolve: [resolve],
		};
	});
}

/** Closes the sheet with an answer for everyone waiting. */
export function closeProve(result: ProveResult) {
	const open = proveAsk.peek();
	proveAsk.value = null;
	for (const r of open?.resolve ?? []) r(result);
}

const SKIP_KEY = "pulsar.sendUnproven";

/** The operator chose to send without proving: don't ask again in this tab. */
export const skippedForSends = signal(
	(() => {
		try {
			return sessionStorage.getItem(SKIP_KEY) === "1";
		} catch {
			return false;
		}
	})(),
);

export function skipProofForSends() {
	skippedForSends.value = true;
	try {
		sessionStorage.setItem(SKIP_KEY, "1");
	} catch {}
}

// A notification tap lands on `#/prove` (a fresh load, or a tab that was
// already open): open the sheet there.
function openFromHash() {
	if (location.hash !== "#/prove") return;
	history.replaceState(history.state, "", location.pathname);
	void proveHuman("manual");
}
if (typeof location !== "undefined") {
	openFromHash();
	addEventListener("hashchange", openFromHash);
}
