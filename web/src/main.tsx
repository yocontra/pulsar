import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { boot } from "./lib/store.ts";

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

// The service worker caches only the static shell, never API responses.
if (
	"serviceWorker" in navigator &&
	import.meta.env.PROD &&
	window.isSecureContext
)
	navigator.serviceWorker.register("/sw.js").catch(() => {});
