/**
 * The desktop sidebar's width, per device: --d-side-w on <html> (read by
 * `.d-app`'s grid in styles/desktop.css). public/prefs.js applies the stored
 * width before first paint; this module owns it after boot.
 */
import { signal } from "./signals.ts";

/** Shared with public/prefs.js. */
const KEY = "pulsar.sideWidth";
export const SIDE_DEFAULT = 296;
export const SIDE_MIN = 220;
const SIDE_MAX = 480;
export const SIDE_STEP = 16;

/** The widest the sidebar may be in this window: 480 px or 40 % of it. */
export function sideMax(): number {
	return Math.max(SIDE_MIN, Math.min(SIDE_MAX, Math.round(innerWidth * 0.4)));
}

export function clampSide(w: number): number {
	return Math.min(sideMax(), Math.max(SIDE_MIN, Math.round(w)));
}

function stored(): number | null {
	try {
		const w = Number(localStorage.getItem(KEY));
		return w > 0 ? w : null;
	} catch {
		return null;
	}
}

/** The width the operator chose (unclamped), or null for the default. */
let chosen = stored();
export const sideWidth = signal(clampSide(chosen ?? SIDE_DEFAULT));

function apply(w: number) {
	document.documentElement.style.setProperty("--d-side-w", `${w}px`);
	sideWidth.value = w;
}

/** Live update while dragging or pressing keys; `save` stores it. */
export function setSideWidth(w: number, save = true) {
	const c = clampSide(w);
	apply(c);
	if (!save) return;
	chosen = c;
	try {
		localStorage.setItem(KEY, String(c));
	} catch {}
}

/** Back to the default width (double-click the handle). */
export function resetSideWidth() {
	chosen = null;
	try {
		localStorage.removeItem(KEY);
	} catch {}
	document.documentElement.style.removeProperty("--d-side-w");
	sideWidth.value = clampSide(SIDE_DEFAULT);
}

// A narrower window lowers the cap; widening it again restores the choice.
if (typeof addEventListener === "function")
	addEventListener("resize", () => {
		if (chosen === null) return;
		const c = clampSide(chosen);
		if (c !== sideWidth.peek()) apply(c);
	});
