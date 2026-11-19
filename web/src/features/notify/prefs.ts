/**
 * "Agent activity" settings on this device: the select (Off / Notifications
 * only / Sound only / Notifications with sound) and the in-app switch.
 *
 * The daemon keeps them with this browser's push subscription (it sends
 * finish/fail pushes only when the mode includes notifications). A browser
 * without a subscription keeps them here only, and its select shows the
 * mode without notifications ("Off" or "Sound only") until it subscribes.
 */
import { api } from "../../api/client.ts";
import type { TurnNotifyMode } from "../../api/types.ts";
import { signal } from "../../lib/signals.ts";

export type Mode = TurnNotifyMode;

export const MODES: ReadonlyArray<readonly [Mode, string]> = [
	["off", "Off"],
	["notify", "Notifications only"],
	["sound", "Sound only"],
	["both", "Notifications with sound"],
];

const KEY = "pulsar.agentActivity";

function load(): { mode: Mode; inApp: boolean } {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as {
			mode?: unknown;
			inApp?: unknown;
		} | null;
		const mode = MODES.find(([m]) => m === v?.mode)?.[0] ?? "notify";
		return { mode, inApp: v?.inApp !== false };
	} catch {
		return { mode: "notify", inApp: true };
	}
}

const first = load();
/** The chosen mode (with notifications even while this browser has no subscription). */
export const mode = signal<Mode>(first.mode);
export const inApp = signal<boolean>(first.inApp);
/** This browser holds a push subscription on the node that served the app. */
export const subscribed = signal(false);

function save() {
	try {
		localStorage.setItem(
			KEY,
			JSON.stringify({ mode: mode.value, inApp: inApp.value }),
		);
	} catch {}
}

export const wantsNotifications = (m: Mode) => m === "notify" || m === "both";
export const wantsSound = (m: Mode) => m === "sound" || m === "both";

/** What the select shows: notifications only count with a subscription. */
export function shownMode(): Mode {
	const m = mode.value;
	if (subscribed.value || !wantsNotifications(m)) return m;
	return m === "both" ? "sound" : "off";
}

/** This browser's push endpoint, when it has a subscription. */
export async function endpoint(): Promise<string | null> {
	if (!("serviceWorker" in navigator)) return null;
	try {
		const reg = await navigator.serviceWorker.getRegistration();
		return (await reg?.pushManager?.getSubscription())?.endpoint ?? null;
	} catch {
		return null;
	}
}

/** Reads what the daemon keeps for this browser's subscription. */
export async function refresh(): Promise<void> {
	const ep = await endpoint();
	subscribed.value = false;
	if (!ep) return;
	const r = await api.pushSettings({ endpoint: ep });
	subscribed.value = r.subscribed;
	if (!r.subscribed) return;
	mode.value = r.turns;
	inApp.value = r.inApp;
	save();
}

/** Saves a change here and, with a subscription, on the daemon. */
export async function update(change: { mode?: Mode; inApp?: boolean }) {
	if (change.mode !== undefined) mode.value = change.mode;
	if (change.inApp !== undefined) inApp.value = change.inApp;
	save();
	const ep = await endpoint();
	if (!ep) return;
	const r = await api.pushSettings({
		endpoint: ep,
		...(change.mode !== undefined ? { turns: change.mode } : {}),
		...(change.inApp !== undefined ? { inApp: change.inApp } : {}),
	});
	subscribed.value = r.subscribed;
}
