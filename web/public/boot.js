// pulsar boot guard: a classic deferred script that runs before the app's
// module entry (scripts run in document order), so it sees the entry's load
// failure. It turns a failed module or chunk download, or an error before the
// app mounts, into one automatic reload and then an error screen with a Retry
// button: never a white page. The app sets <html data-booted> once it mounts.
(() => {
	const KEY = "pulsar:boot-retry";
	const WINDOW_MS = 60_000;
	const root = document.documentElement;
	let failed = false;

	const booted = () => root.hasAttribute("data-booted");
	// A booted app warming chunks in the background (src/lib/prefetch.ts):
	// a failed prefetch is not the app failing, so never reload over it.
	const quiet = () => booted() && (window.__pulsarPrefetching ?? 0) > 0;

	// Reload with navigations going to the network (not the cached shell).
	function reload() {
		const sw = navigator.serviceWorker?.controller;
		if (!sw) return location.reload();
		const channel = new MessageChannel();
		const go = () => location.reload();
		const timer = setTimeout(go, 500);
		channel.port1.onmessage = () => {
			clearTimeout(timer);
			go();
		};
		sw.postMessage({ type: "bypass" }, [channel.port2]);
	}

	function show() {
		const screen = document.getElementById("boot-error");
		if (screen) screen.hidden = false;
		document.getElementById("boot-retry")?.focus();
	}

	function fail() {
		if (failed || quiet()) return;
		failed = true;
		let last = 0;
		try {
			last = Number(sessionStorage.getItem(KEY)) || 0;
		} catch {}
		// One automatic retry per minute; after that, the error screen. Once
		// the app runs, a lazy chunk shows its own Retry (src/lib/lazy.tsx)
		// instead: never cover a working app.
		if (Date.now() - last > WINDOW_MS) {
			try {
				sessionStorage.setItem(KEY, String(Date.now()));
				return reload();
			} catch {}
		}
		if (!booted()) show();
	}

	const chunkError = (reason) =>
		/dynamically imported module|module script failed|Unable to preload|error loading dynamically/i.test(
			String(reason?.message ?? reason),
		);

	// Capture phase: a <script> or <link> load error does not bubble.
	addEventListener(
		"error",
		(e) => {
			const t = e.target;
			if (t instanceof HTMLScriptElement) return fail();
			if (
				t instanceof HTMLLinkElement &&
				/stylesheet|modulepreload/.test(t.rel)
			)
				return fail();
			// A script error before the app mounts (a top-level module error).
			if (t === window && !booted()) fail();
		},
		true,
	);
	// Vite's dynamic import helper: a lazy chunk (or its CSS) did not load.
	// It fires for any rejection of the import, errors the app handles
	// included (a passkey SecurityError, say): only download errors count.
	addEventListener("vite:preloadError", (e) => {
		if (chunkError(e.payload)) fail();
	});
	addEventListener("unhandledrejection", (e) => {
		if (chunkError(e.reason)) fail();
	});

	document.addEventListener("DOMContentLoaded", () => {
		document.getElementById("boot-retry")?.addEventListener("click", () => {
			try {
				sessionStorage.setItem(KEY, String(Date.now()));
			} catch {}
			reload();
		});
		// Module scripts run before DOMContentLoaded: an entry that ran
		// without mounting (no module support, blocked script) shows the
		// error screen too.
		setTimeout(() => {
			if (!booted() && !failed) fail();
		}, 0);
	});

	// A slow network: say so after a while.
	setTimeout(() => {
		if (booted()) return;
		const slow = document.getElementById("boot-slow");
		if (slow) slow.hidden = false;
	}, 6000);
})();
