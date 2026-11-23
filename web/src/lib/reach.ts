/**
 * Is the daemon reachable? Off Tailscale the app's shell still loads from
 * the service worker's cache, so a failed chunk or a dropped stream means
 * "can't reach the machine", not a broken build. The probe and the wait for
 * the machine to come back live in public/boot.js (they run before the app
 * mounts too); this wraps them.
 */

declare global {
	interface Window {
		/** public/boot.js: true when /api/v1/hello answers (any status) within 4 s. */
		__pulsarReach?: () => Promise<boolean>;
		/** public/boot.js: run `go` once the daemon answers (online, visible, backoff). */
		__pulsarWhenBack?: (go: () => void) => void;
		/** public/boot.js: reload past the service worker's cached shell. */
		__pulsarReload?: () => void;
	}
}

const KEY = "pulsar.machine";

/** Whether the daemon answers now (true when boot.js is missing). */
export const reachable = (): Promise<boolean> =>
	window.__pulsarReach?.() ?? Promise.resolve(true);

/** A full reload past the cached shell (browsers may cache a failed import). */
export function reloadApp() {
	if (window.__pulsarReload) window.__pulsarReload();
	else location.reload();
}

/** Keep the machine /hello came from, for "Can't reach studio". */
export function rememberMachine(name: string) {
	try {
		localStorage.setItem(KEY, name);
	} catch {}
}

/** "Can't reach studio" / "Can't Reach Your Machines" (phone: title case). */
export function offlineCopy(phone: boolean) {
	let m = "";
	try {
		m = localStorage.getItem(KEY) ?? "";
	} catch {}
	return {
		title: `Can't ${phone ? "Reach" : "reach"} ${m || (phone ? "Your Machines" : "your pool")}`,
		body: `Check that ${phone ? "the Tailscale app" : "Tailscale"} is on, then try again.`,
	};
}
