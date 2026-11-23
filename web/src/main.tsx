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

// Keyboard-avoiding composer: expose how much of the layout viewport the
// on-screen keyboard covers.
const vv = window.visualViewport;
if (vv) {
	const update = () => {
		const covered = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
		document.documentElement.style.setProperty("--kb", `${covered}px`);
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
