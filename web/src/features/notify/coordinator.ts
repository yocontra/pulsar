/**
 * Finish and fail notifications inside the app (the daemon's `notify`
 * event: an agent the operator started, messaged or opened ended its turn).
 *
 * - Sound, when "Agent activity" includes it: two short tones, made with
 *   WebAudio (no file to load). Browsers keep audio locked until the first
 *   tap or key press, so the first gesture unlocks it.
 * - A toast, when "In-app notifications" is on, the window has focus, and
 *   that agent is not the one open: CircleCheck or CircleAlert, the push's
 *   title and body ("api-fix finished", its last message), and "Open
 *   agent". It closes once that agent opens.
 * - A prompt answered elsewhere closes its system notification, while the
 *   app is open on this device (close.ts).
 * - A badge count while the window is in the background: the app badge (the
 *   installed app) and "(n)" in the title, "9+" at most; focus clears it.
 *
 * OS notifications come from Web Push (sw.js), not from here.
 */
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { createElement } from "react";
import { api } from "../../api/client.ts";
import type { AgentRow, ServerEvents } from "../../api/types.ts";
import { keys } from "../../data/keys.ts";
import { live, queryClient } from "../../data/runtime.ts";
import { navigate, route } from "../../lib/router.ts";
import { effect } from "../../lib/signals.ts";
import { dismissToast, type ToastId, toast } from "../../lib/toast.ts";
import { closeAnswered } from "./close.ts";
import { inApp, mode, refresh, wantsSound } from "./prefs.ts";

type Notice = ServerEvents["notify"];

/** True while `agentId` is the agent on screen (its conversation, prompt or changes). */
function isOpen(agentId: string): boolean {
	const r = route.value;
	return (
		(r.view === "agent" || r.view === "approval" || r.view === "changes") &&
		r.id === agentId
	);
}

const focused = () =>
	document.visibilityState === "visible" && document.hasFocus();

async function nameOf(agentId: string): Promise<string> {
	const cached = queryClient.getQueryData<AgentRow>(keys.agent(agentId));
	if (cached) return cached.name;
	try {
		return (await api.agent(agentId)).name;
	} catch {
		return "An agent";
	}
}

// ------------------------------------------------------------------ sound

let audio: AudioContext | null = null;

async function unlock() {
	try {
		audio ??= new AudioContext();
		if (audio.state === "suspended") await audio.resume();
	} catch {}
}

/** Two short tones: rising for a finish, falling for a failure. */
export function chime(kind: Notice["kind"]) {
	const ctx = audio;
	if (ctx?.state !== "running") return;
	const notes = kind === "finished" ? [660, 880] : [520, 390];
	const t0 = ctx.currentTime;
	notes.forEach((hz, i) => {
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		const at = t0 + i * 0.14;
		osc.type = "sine";
		osc.frequency.value = hz;
		gain.gain.setValueAtTime(0.0001, at);
		gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
		gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.13);
		osc.connect(gain).connect(ctx.destination);
		osc.start(at);
		osc.stop(at + 0.14);
	});
}

// ------------------------------------------------------------------ badge

let unseen = 0;
const PREFIX = /^\(\d+\+?\) /;

function showBadge() {
	const label = unseen > 9 ? "9+" : String(unseen);
	const bare = document.title.replace(PREFIX, "");
	document.title = unseen > 0 ? `(${label}) ${bare}` : bare;
	const nav = navigator as Navigator & {
		setAppBadge?: (n?: number) => Promise<void>;
		clearAppBadge?: () => Promise<void>;
	};
	if (unseen > 0) nav.setAppBadge?.(unseen).catch(() => {});
	else nav.clearAppBadge?.().catch(() => {});
}

function clearBadge() {
	if (unseen === 0) return;
	unseen = 0;
	showBadge();
}

// ------------------------------------------------------------------ toasts

/** Open toasts by agent: one per agent, closed when it opens. */
const open = new Map<string, ToastId>();

async function showToast(n: Notice) {
	const failed = n.kind === "failed";
	// The daemon's text, the same as the push (older daemons: the name only).
	const title =
		n.title ??
		`${await nameOf(n.agentId)} ${failed ? "stopped with an error" : "finished"}`;
	if (isOpen(n.agentId)) return;
	const id = await toast(title, {
		id: `turn:${n.agentId}`,
		tone: failed ? "error" : "success",
		...(n.body ? { description: n.body } : {}),
		duration: failed ? 10_000 : 6000,
		icon: createElement(failed ? CircleAlertIcon : CircleCheckIcon, {
			size: 16,
			"aria-hidden": true,
		}),
		action: {
			label: "Open agent",
			onClick: () => navigate({ view: "agent", id: n.agentId }),
		},
	});
	open.set(n.agentId, id);
}

/** Handles one `notify` event (exported for tests). */
export function onNotify(n: Notice) {
	if (wantsSound(mode.value)) chime(n.kind);
	if (!focused()) {
		unseen++;
		showBadge();
		return;
	}
	if (inApp.value && !isOpen(n.agentId)) void showToast(n);
}

let started = false;

export function start() {
	if (started) return;
	started = true;
	live.on("notify", onNotify);
	live.on("approval", (a) => void closeAnswered(a));
	for (const ev of ["pointerdown", "keydown"] as const)
		window.addEventListener(ev, unlock, { capture: true, passive: true });
	window.addEventListener("focus", clearBadge);
	// What this device chose reaches its subscription: now, and on coming back
	// (notifications may have been turned on meanwhile), at most once a minute.
	let synced = 0;
	const sync = () => {
		if (Date.now() - synced < 60_000) return;
		synced = Date.now();
		refresh().catch(() => {});
	};
	sync();
	document.addEventListener("visibilitychange", () => {
		if (focused()) clearBadge();
		if (document.visibilityState === "visible") sync();
	});
	// Opening an agent closes its toast.
	effect(() => {
		route.value;
		for (const [agentId, id] of open)
			if (isOpen(agentId)) {
				open.delete(agentId);
				void dismissToast(id);
			}
	});
}
