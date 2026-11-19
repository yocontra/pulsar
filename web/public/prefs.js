// pulsar per-device prefs: a classic, render-blocking script in <head>
// (external, so the CSP's script-src 'self' allows it; CSSOM writes are not
// inline styles). It applies this device's choices before first paint, so
// nothing flashes or shifts:
// - Appearance: "light" / "dark" set <html data-theme>; "system" (the
//   default) leaves it unset and the CSS follows prefers-color-scheme.
//   src/lib/theme.ts owns it after boot.
// - Desktop sidebar width: --d-side-w on <html>. src/lib/sidebar.ts owns it
//   after boot. Keep keys, bounds and colors in sync with those modules.
(() => {
	const root = document.documentElement;
	const get = (k) => {
		try {
			return localStorage.getItem(k);
		} catch {
			return null;
		}
	};

	const w = Number(get("pulsar.sideWidth"));
	if (w > 0) {
		const max = Math.max(220, Math.min(480, Math.round(innerWidth * 0.4)));
		root.style.setProperty(
			"--d-side-w",
			`${Math.min(max, Math.max(220, Math.round(w)))}px`,
		);
	}

	const pref = get("pulsar.appearance");
	if (pref !== "light" && pref !== "dark") return;
	root.setAttribute("data-theme", pref);
	// The status bar and window chrome: every theme-color meta shows the
	// forced theme's color for its layout (phone below 1024 px, desktop above).
	const COLORS = {
		light: { phone: "#f2f2f7", desktop: "#f7f7f5" },
		dark: { phone: "#000000", desktop: "#151517" },
	};
	for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
		const media = m.getAttribute("media") || "";
		m.setAttribute(
			"content",
			COLORS[pref][/min-width/.test(media) ? "desktop" : "phone"],
		);
	}
})();
