/**
 * Appearance: System (default), Light or Dark, per device. public/prefs.js
 * applies the stored choice before first paint; this module owns it after
 * boot. "system" leaves <html> without data-theme, so the CSS follows
 * prefers-color-scheme; "light" / "dark" set <html data-theme>, which every
 * token block honors (styles/tokens.css).
 */
import { signal } from "./signals.ts";

export type Appearance = "system" | "light" | "dark";
export const APPEARANCES: readonly [Appearance, string][] = [
	["system", "System"],
	["light", "Light"],
	["dark", "Dark"],
];

/** Shared with public/prefs.js. */
const KEY = "pulsar.appearance";
const COLORS = {
	light: { phone: "#f4f3f1", desktop: "#f7f7f5" },
	dark: { phone: "#0b0b0a", desktop: "#151517" },
} as const;

function read(): Appearance {
	try {
		const v = localStorage.getItem(KEY);
		if (v === "light" || v === "dark") return v;
	} catch {}
	return "system";
}

export const appearance = signal<Appearance>(read());

function apply(a: Appearance) {
	const root = document.documentElement;
	if (a === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", a);
	for (const m of document.querySelectorAll<HTMLMetaElement>(
		'meta[name="theme-color"]',
	)) {
		const media = m.media || "";
		const layout = /min-width/.test(media) ? "desktop" : "phone";
		// System: each meta shows its own scheme's color (its media query picks).
		const scheme = a === "system" ? (/dark/.test(media) ? "dark" : "light") : a;
		m.content = COLORS[scheme][layout];
	}
	appearance.value = a;
}

export function setAppearance(a: Appearance) {
	try {
		if (a === "system") localStorage.removeItem(KEY);
		else localStorage.setItem(KEY, a);
	} catch {}
	apply(a);
}

// Another tab on this device changed it.
if (typeof addEventListener === "function")
	addEventListener("storage", (e) => {
		if (e.key !== KEY && e.key !== null) return;
		apply(read());
	});
