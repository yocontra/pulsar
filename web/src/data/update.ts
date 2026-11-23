/**
 * Keeps an open app on the build its daemon serves. The page knows its own
 * build (`<meta name="pulsar-build">`, web/scripts/finish-dist.ts); /hello
 * says which build the daemon serves now (`webBuild`). When they differ, the
 * app fetches the new build (service worker update) and reloads, at once if
 * the operator is not in the middle of something, else at the next quiet
 * moment, with a "Pulsar updated" toast to reload sooner.
 *
 * A reload keeps the route (the hash) and composer text (lib/composer-draft.ts).
 * Text it can't keep (a commit message, a review comment), attached files,
 * a send or passkey check in flight: no automatic reload, only the toast.
 * One automatic reload per build: if the page still runs another build
 * after it (cached old assets), the toast stays and nothing loops.
 */

import { keepDrafts, openComposers } from "../lib/composer-draft.ts";
import { inFlight } from "../lib/inflight.ts";
import { dismissToast, toast } from "../lib/toast.ts";
import { proveAsk } from "../prove/state.ts";
import { sendsPending } from "./pending.ts";

/** What the operator is doing, as far as a reload goes. */
export interface Activity {
	/** ms since the last keystroke in any text field. */
	typedAgo: number;
	/** A text field other than a composer has focus. */
	focusedField: boolean;
	/** A non-empty text field a reload can't keep (not a composer). */
	unsaved: boolean;
	/** A composer holds attached or uploading files. */
	files: boolean;
	/** A dialog, sheet or menu is open. */
	dialog: boolean;
	/**
	 * A send, Stop, passkey check or Prove Human in progress, or a failed
	 * send whose text lives only in its Retry bubble.
	 */
	inFlight: boolean;
	/** Dictation is listening (its words land in the composer). */
	dictating: boolean;
}

/** Typing this recently counts as busy. */
export const TYPING_MS = 4000;
/** While an update waits, how often to look for a quiet moment. */
export const RETRY_MS = 5000;

/**
 * Would a reload now get in the way? In a hidden page (the app went to the
 * background) only what a reload would lose counts.
 */
export function isBusy(a: Activity, hidden: boolean): boolean {
	if (a.unsaved || a.files || a.inFlight) return true;
	if (hidden) return false;
	return a.dialog || a.focusedField || a.dictating || a.typedAgo < TYPING_MS;
}

/**
 * - `none`: nothing to do (same build, or a build id is missing: dev, or an
 *   older daemon).
 * - `reload`: reload into the served build now.
 * - `wait`: show the toast and reload at the next quiet moment.
 * - `toast`: this page already reloaded for `served` and still runs another
 *   build; show the toast only (no loop).
 */
export type Decision = "none" | "reload" | "wait" | "toast";

export function decide(p: {
	own: string | null | undefined;
	served: string | null | undefined;
	/** The build this page last reloaded for. */
	tried: string | null | undefined;
	busy: boolean;
}): Decision {
	if (!p.own || !p.served || p.own === p.served) return "none";
	if (p.tried === p.served) return "toast";
	return p.busy ? "wait" : "reload";
}

// ------------------------------------------------------------ browser

/** sessionStorage: the build this tab last reloaded for. */
const TRIED = "pulsar:update-tried";
const DIALOGS = [
	'[role="dialog"]',
	'[role="alertdialog"]',
	'[aria-modal="true"]',
	'[role="menu"]',
	"dialog[open]",
	".d-pop",
	".d-menu",
	"ion-modal.show-modal",
	"ion-action-sheet",
	"ion-alert",
	"ion-popover",
].join(",");
const TEXT_INPUT = /^(text|search|email|url|tel|password|number)$/;

let lastInput = Number.NEGATIVE_INFINITY;

function activity(): Activity {
	const composers = new Set<Element>();
	let files = false;
	for (const c of openComposers.values()) {
		const f = c.field();
		if (f) composers.add(f);
		if (c.draft.files.peek().length) files = true;
	}
	const el = document.activeElement;
	const focusedField =
		!!el &&
		!composers.has(el) &&
		(el instanceof HTMLTextAreaElement ||
			(el instanceof HTMLInputElement && TEXT_INPUT.test(el.type)) ||
			(el instanceof HTMLElement && el.isContentEditable));
	let unsaved = false;
	for (const f of document.querySelectorAll<HTMLElement>(
		'textarea, [contenteditable="true"], [contenteditable=""]',
	)) {
		if (composers.has(f)) continue;
		const v = f instanceof HTMLTextAreaElement ? f.value : f.textContent;
		if (v?.trim()) {
			unsaved = true;
			break;
		}
	}
	const dialog = [...document.querySelectorAll(DIALOGS)].some(
		(e) => e.getClientRects().length > 0,
	);
	return {
		typedAgo: Date.now() - lastInput,
		focusedField,
		unsaved,
		files,
		dialog,
		inFlight: inFlight.peek() > 0 || proveAsk.peek() !== null || sendsPending(),
		dictating: !!document.querySelector('.mic-btn[aria-pressed="true"]'),
	};
}

/** The build this tab reloaded for; `served` when storage fails (no auto reload). */
function tried(served: string): string | null {
	try {
		return sessionStorage.getItem(TRIED);
	} catch {
		return served;
	}
}

const wait = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Lets the service worker install `build` (its cache is named after it), so
 * the reload comes from the new build's files; bounded, it never blocks the
 * reload for long.
 */
async function fetchBuild(build: string) {
	const reg = await navigator.serviceWorker
		?.getRegistration()
		.catch(() => undefined);
	if (!reg || typeof caches === "undefined") return;
	const ready = (async () => {
		await reg.update().catch(() => {});
		while (!(await caches.has(`pulsar-shell-${build}`).catch(() => true)))
			await wait(250);
	})();
	await Promise.race([ready, wait(8000)]);
}

/** Navigations skip the cached shell for a while (as web/public/boot.js). */
async function bypassShell() {
	const sw = navigator.serviceWorker?.controller;
	if (!sw) return;
	const channel = new MessageChannel();
	const answered = new Promise((ok) => {
		channel.port1.onmessage = ok;
	});
	sw.postMessage({ type: "bypass" }, [channel.port2]);
	await Promise.race([answered, wait(500)]);
}

let applying = false;

async function apply(build: string, tapped: boolean) {
	if (applying) return;
	let kept = false;
	try {
		sessionStorage.setItem(TRIED, build);
		kept = keepDrafts();
	} catch {}
	// Without the loop guard or the drafts saved, reload only when asked.
	if (!kept && !tapped) return offer(build);
	applying = true;
	await fetchBuild(build);
	if (tapped) await bypassShell();
	location.reload();
}

let shownFor: string | null = null;

function offer(build: string) {
	if (shownFor === build) return;
	shownFor = build;
	void toast("Pulsar updated", {
		id: "pulsar-update",
		duration: Number.POSITIVE_INFINITY,
		action: { label: "Reload", onClick: () => void apply(build, true) },
	});
}

let started = false;

/**
 * Starts watching `served()` (call `check` when it may have changed). Does
 * nothing in a page without a build id (the dev server).
 */
export function startUpdates(served: () => string | null | undefined) {
	const own = document
		.querySelector('meta[name="pulsar-build"]')
		?.getAttribute("content");
	if (started || !own) return () => {};
	started = true;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const check = () => {
		clearTimeout(timer);
		const build = served();
		if (applying || !build) return;
		const d = decide({
			own,
			served: build,
			tried: tried(build),
			busy: isBusy(activity(), document.hidden),
		});
		if (d === "none") {
			// The daemon went back to this build: the offer is moot.
			if (shownFor) void dismissToast("pulsar-update");
			shownFor = null;
			return;
		}
		if (d === "reload") return void apply(build, false);
		offer(build);
		if (d === "wait") timer = setTimeout(check, RETRY_MS);
	};
	document.addEventListener("input", () => (lastInput = Date.now()), true);
	document.addEventListener("visibilitychange", check);
	addEventListener("hashchange", check);
	check();
	return check;
}
