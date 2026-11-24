// Feature registrations (slots, pages, commands) before anything reads them.
import "./features.ts";
import { createRoot } from "react-dom/client";
import { api, request, setSessionToken } from "./api/client.ts";
import { App } from "./components/App.tsx";
import { reportLoad } from "./lib/load-report.ts";
import {
	registerCommand,
	registerPage,
	registerPaletteProvider,
	registerSettingsSection,
	registerSlot,
} from "./lib/registry.tsx";
import { boot } from "./lib/store.ts";
import { toast } from "./lib/toast.ts";

const registry = {
	registerCommand,
	registerPage,
	registerPaletteProvider,
	registerSettingsSection,
	registerSlot,
};

// The on-screen keyboard. iOS never resizes the layout viewport for it (it
// ignores the viewport meta's interactive-widget): it shrinks the visual
// viewport and pans it down to show the focused field, which leaves the
// fixed body (Ionic's) and its top bar above the screen. So:
// - --kb is the keyboard's height, the bottom padding docks and sheets add
//   to sit on it;
// - --vv-top is the pan: the body moves down by it (mobile/theme.css,
//   html[data-vv-pan]), so the top bar stays at the top of what shows and
//   the conversation takes the room between it and the dock, as in
//   Messages.
// Android's resizes-content shrinks the layout viewport instead: both stay 0.
// While zoomed in (pinch), the pan is the zoom's, not the keyboard's.
const vv = window.visualViewport;
if (vv) {
	const root = document.documentElement;
	const update = () => {
		const zoomed = vv.scale > 1.01;
		const pan = zoomed ? 0 : Math.max(0, Math.round(vv.offsetTop));
		const covered = Math.max(
			0,
			Math.round(window.innerHeight - vv.height - (zoomed ? vv.offsetTop : 0)),
		);
		root.style.setProperty("--kb", `${covered}px`);
		root.style.setProperty("--vv-top", `${pan}px`);
		root.toggleAttribute("data-vv-pan", pan > 0);
	};
	vv.addEventListener("resize", update);
	vv.addEventListener("scroll", update);
	update();
}

const root = document.getElementById("app");
if (root) {
	root.textContent = "";
	createRoot(root).render(<App />);
	// The boot guard (public/boot.js) stops treating errors as a failed boot.
	document.documentElement.setAttribute("data-booted", "");
}
void boot();

// End-to-end tests only: a test's init script sets `__pulsarE2E` before the
// app loads (never set otherwise), and gets the toast and registry APIs.
const e2e = (window as { __pulsarE2E?: Record<string, unknown> }).__pulsarE2E;
if (e2e && typeof e2e === "object")
	Object.assign(e2e, { toast, api, request, setSessionToken, ...registry });

// The service worker caches only the static shell, never API responses.
if (
	"serviceWorker" in navigator &&
	import.meta.env.PROD &&
	window.isSecureContext
)
	navigator.serviceWorker.register("/sw.js").then(
		(reg) =>
			// A worker that never installs (sw.js reports why itself; this
			// adds the page's side: route, controller, caches).
			reg?.addEventListener("updatefound", () => {
				const w = reg.installing;
				w?.addEventListener("statechange", () => {
					if (w.state === "redundant" && reg.active !== w)
						void reportLoad("sw-install", {
							name: "InstallError",
							message: "the service worker did not install",
						});
				});
			}),
		(err: unknown) => void reportLoad("sw-register", err),
	);
