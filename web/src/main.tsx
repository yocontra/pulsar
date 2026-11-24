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

// The on-screen keyboard, in the phone layout. Ionic's body is fixed to
// the screen, and iOS does not resize it for the keyboard: it shrinks the
// visual viewport and scrolls or pans it down to show the focused field
// (iOS 27: innerHeight and vv.height 325, vv.offsetTop and scrollY 339 on
// a 664 px Safari page), which leaves the top bar above the screen and the
// dock under the keyboard. So while the keyboard is up the body becomes
// the visual viewport: html[data-vv] (mobile/theme.css) sizes it to
// --vvh and moves it down by --vv-top. The top bar stays at the top, the
// dock sits on the keyboard, and the conversation takes the room between,
// as in Messages. Everything that floats (sheets, menus, toasts) lives in
// the body, so --kb stays 0 there.
// Elsewhere --kb is how much of the layout viewport the keyboard covers:
// the desktop layout (an iPad), and Android, whose resizes-content shrinks
// the layout viewport itself (no keyboard is seen here, both stay 0).
// While zoomed in (pinch), the viewport moves for the zoom: --kb as before.
const vv = window.visualViewport;
if (vv) {
	const root = document.documentElement;
	const update = () => {
		const phone = root.dataset.platform === "phone" && vv.scale <= 1.01;
		const open =
			phone && (vv.height < root.clientHeight - 1 || vv.offsetTop > 0.5);
		root.toggleAttribute("data-vv", open);
		if (open) {
			root.style.setProperty("--vvh", `${Math.round(vv.height)}px`);
			root.style.setProperty("--vv-top", `${Math.round(vv.offsetTop)}px`);
			root.style.setProperty("--kb", "0px");
			return;
		}
		const covered = window.innerHeight - vv.height - vv.offsetTop;
		root.style.setProperty("--kb", `${Math.max(0, Math.round(covered))}px`);
	};
	// A tap into the composer focuses it without Safari's scroll to the
	// field: the field is low on the page, and iOS 27 scrolls the document
	// (scrollY 339) while the keyboard animates, so the top bar left the
	// screen for a few frames before the body caught up. The resized body
	// above keeps the field in view instead. Only an unfocused field: taps
	// inside a focused one place the caret as usual.
	document.addEventListener(
		"touchend",
		(e) => {
			const t = e.target;
			if (
				root.dataset.platform === "phone" &&
				t instanceof HTMLTextAreaElement &&
				t.closest(".m-composer") &&
				document.activeElement !== t
			) {
				e.preventDefault();
				t.focus({ preventScroll: true });
			}
		},
		{ capture: true, passive: false },
	);
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
