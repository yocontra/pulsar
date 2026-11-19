/**
 * Web Push from the installed app. iOS shows notifications only for a Home
 * Screen app (iOS 16.4+); a Safari tab can't subscribe. The daemon that
 * served this page keeps the subscription and pushes for its own approvals.
 */
import { api } from "../api/client.ts";

export type PushState =
	| "unsupported"
	| "needs-install"
	| "denied"
	| "off"
	| "on";

const isIos = () => /iPhone|iPad/.test(navigator.userAgent);
const standalone = () =>
	matchMedia("(display-mode: standalone)").matches ||
	(navigator as Navigator & { standalone?: boolean }).standalone === true;

async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!("serviceWorker" in navigator)) return null;
	const reg = await navigator.serviceWorker.getRegistration();
	return reg ?? null;
}

export async function pushState(): Promise<PushState> {
	if (isIos() && !standalone()) return "needs-install";
	if (!("PushManager" in window) || !("Notification" in window))
		return "unsupported";
	if (Notification.permission === "denied") return "denied";
	const reg = await registration();
	if (!reg) return "unsupported";
	return (await reg.pushManager.getSubscription()) ? "on" : "off";
}

function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
	const s = atob(b64u.replace(/-/g, "+").replace(/_/g, "/"));
	const out = new Uint8Array(new ArrayBuffer(s.length));
	for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
	return out;
}

/** Asks for permission and subscribes this browser on this node. */
export async function enablePush(): Promise<PushState> {
	if ((await Notification.requestPermission()) !== "granted") return "denied";
	const reg = await registration();
	if (!reg) return "unsupported";
	const { publicKey } = await api.pushKey();
	const sub =
		(await reg.pushManager.getSubscription()) ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: keyBytes(publicKey),
		}));
	const json = sub.toJSON() as {
		endpoint: string;
		keys: { p256dh: string; auth: string };
	};
	try {
		// Prove Human opens here when this browser isn't proven yet.
		await api.pushSubscribe({ endpoint: json.endpoint, keys: json.keys });
	} catch (e) {
		// The daemon doesn't know this subscription: don't leave it on here.
		await sub.unsubscribe().catch(() => {});
		throw e;
	}
	return "on";
}

export async function disablePush(): Promise<PushState> {
	const sub = await (await registration())?.pushManager.getSubscription();
	if (sub) {
		// Off takes a proven device too (it's also the security-notice channel).
		await api.pushUnsubscribe(sub.endpoint);
		await sub.unsubscribe();
	}
	return "off";
}
