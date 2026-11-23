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

	// Reload with navigations going to the network (not the cached shell),
	// keeping composer text (src/lib/composer-draft.ts).
	function reload() {
		try {
			window.__pulsarKeepDrafts?.();
		} catch {}
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
		// The report's short code and file, for the operator to paste.
		pending.then(() => {
			const r = window.__pulsarLastLoadError;
			const code = document.getElementById("boot-code");
			if (!r || !code) return;
			code.textContent = window.__pulsarLoadCode(r);
			code.hidden = false;
			document.getElementById("boot-copy").hidden = false;
		});
	}

	// The page is being left (a link, a typed URL, a reload): the browser
	// cancels its downloads (WebKit at once), and a chunk that fails then is
	// not a broken build. Reloading would take the navigation over and load
	// the page being left again. beforeunload, not pagehide: it comes when
	// the navigation starts, before the downloads are cancelled.
	let leaving = false;
	addEventListener("beforeunload", () => {
		leaving = true;
	});
	// Back from the back/forward cache: here again.
	addEventListener("pageshow", () => {
		leaving = false;
	});

	// "BOOT-TypeError · index.abc.js": what failed, for a person to read out.
	window.__pulsarLoadCode = (r) => {
		const file = (r.urls[0] ?? r.sw?.failed[0] ?? "").split(/[/ ]/);
		const name = r.urls[0] ? file.pop() : file[file.length - 2];
		return `${r.kind.toUpperCase()}-${r.error.name}${name ? ` · ${name}` : ""}`;
	};
	// Every field of the last report, as text to paste.
	window.__pulsarLoadDetails = () =>
		JSON.stringify(window.__pulsarLastLoadError ?? null, null, 1);

	// Load error reports for the daemon (POST /api/v1/client-errors, see
	// src/diagnostics/client-errors.ts): the build, the file, the error and
	// the service worker's state; never message text, drafts or tokens. Each
	// once per page, 10 a minute at most; one the network lost is sent again
	// on the next load. A reload waits for the report (1.5 s at most).
	// `reloaded`: this page is the automatic retry's reload (see retry).
	let reloaded = false;
	try {
		reloaded = Date.now() - Number(sessionStorage.getItem(KEY)) <= WINDOW_MS;
	} catch {}
	const API = "/api/v1/client-errors";
	const QUEUE = "pulsar:load-errors";
	const sent = new Set();
	let times = [];
	let pending = Promise.resolve();
	// Reports on their way; a reload waits for them all. A fetch cut by
	// leaving the page (`leaving`, above) is not resent as a beacon:
	// keepalive sends it.
	const inflight = new Set();
	const cut = (s, n) => String(s ?? "").slice(0, n);
	const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
	const ask = (sw) =>
		new Promise((ok) => {
			const ch = new MessageChannel();
			ch.port1.onmessage = (e) => ok(e.data);
			setTimeout(ok, 500);
			sw.postMessage({ type: "info" }, [ch.port2]);
		});

	async function swState() {
		const sw = navigator.serviceWorker;
		const o = { controller: null, state: sw ? "none" : "unsupported" };
		o.caches =
			typeof caches === "undefined" ? [] : await caches.keys().catch(() => []);
		o.failed = [];
		if (!sw) return o;
		const reg = await Promise.race([sw.getRegistration(), wait(500)]);
		if (reg)
			o.state = reg.installing
				? "installing"
				: reg.waiting
					? "waiting"
					: reg.active
						? "active"
						: "none";
		const info = sw.controller && (await ask(sw.controller));
		if (info) {
			o.controller = cut(info.build, 64);
			o.failed = (info.failed ?? []).map((f) => cut(f, 300));
		}
		return o;
	}

	function post(body) {
		const queue = () => {
			try {
				const q = JSON.parse(sessionStorage.getItem(QUEUE) || "[]");
				sessionStorage.setItem(QUEUE, JSON.stringify([...q, body].slice(-5)));
			} catch {}
		};
		return fetch(API, {
			method: "POST",
			headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
			body,
			keepalive: true,
		}).then(
			(r) => r.status >= 500 && queue(),
			// Lost (off Tailscale a beacon "succeeds" and is dropped): kept
			// for the next load.
			() => leaving || queue(),
		);
	}

	function report(kind, err, urls = []) {
		// A download cancelled by leaving the page is not a load error.
		if (leaving) return pending;
		const message = cut(err?.message ?? err, 500);
		const key = kind + message + urls;
		const now = Date.now();
		times = times.filter((t) => now - t < 60_000);
		if (sent.has(key) || times.length >= 10) return pending;
		sent.add(key);
		times.push(now);
		// The files that failed (Chromium's resource timing has the status),
		// then the module the message names (Chromium; WebKit names none).
		const named =
			message.match(/(?:https?:\/\/[^\s'"]+)?\/_app\/[^\s'"]+/g) ?? [];
		const bad = performance
			.getEntriesByType?.("resource")
			.filter((e) => /\/_app\//.test(e.name) && e.responseStatus >= 400)
			.map((e) => e.name);
		const r = {
			kind,
			build: cut(
				document.querySelector('meta[name="pulsar-build"]')?.content,
				64,
			),
			urls: [...new Set([...urls, ...(bad ?? []), ...named])]
				.filter(Boolean)
				.slice(0, 5)
				.map((u) => cut(u, 300)),
			error: { name: cut(err?.name || "Error", 80), message },
			online: navigator.onLine,
			standalone:
				navigator.standalone === true ||
				matchMedia("(display-mode: standalone)").matches,
			ua: cut(navigator.userAgent, 400),
			route: cut(location.hash.slice(1).split("?")[0], 300),
			reloaded,
			at: now,
		};
		const go = swState()
			.catch(() => ({
				controller: null,
				state: "error",
				caches: [],
				failed: [],
			}))
			.then((sw) => {
				r.sw = sw;
				r.sw.caches = (sw.caches ?? []).slice(-10).map((c) => cut(c, 80));
				r.sw.failed = sw.failed.slice(-5);
				window.__pulsarLastLoadError = r;
				return post(JSON.stringify(r));
			})
			.catch(() => {});
		inflight.add(go);
		go.then(() => inflight.delete(go));
		pending = Promise.race([go, wait(1500)]);
		return pending;
	}
	window.__pulsarReport = report;

	// Reports a lost connection kept from the last page (the reload once
	// an unreachable daemon answers again sends them).
	try {
		const q = JSON.parse(sessionStorage.getItem(QUEUE) || "[]");
		sessionStorage.removeItem(QUEUE);
		for (const body of q) post(body);
	} catch {}

	// Can this page reach the daemon? Any answer to /api/v1/hello counts
	// (sw.js never answers /api/ from its cache); a network error, or none
	// within 4 s, does not: off Tailscale, the shell still loads from cache.
	const reach = () =>
		navigator.onLine
			? fetch("/api/v1/hello", {
					cache: "no-store",
					signal: AbortSignal.timeout?.(4000),
				}).then(
					() => true,
					() => false,
				)
			: Promise.resolve(false);

	// Unreachable: ask again when the network or the app comes back, and on
	// a backoff (1 s, doubling to 30 s); `back` runs once the daemon answers.
	let back = null;
	let delay = 0;
	let timer = 0;
	function check() {
		reach().then((ok) => {
			if (!back) return;
			clearTimeout(timer);
			if (!ok)
				return (timer = setTimeout(
					check,
					(delay = Math.min(delay * 2 || 1000, 30_000)),
				));
			const go = back;
			back = null;
			go();
		});
	}
	const again = () => {
		if (!back) return;
		delay = 0;
		check();
	};
	addEventListener("online", again);
	document.addEventListener("visibilitychange", again);
	window.__pulsarReach = reach;
	// A reload (a chunk failed) wins over an in-place retry.
	const home = () => window.__pulsarReload();
	window.__pulsarWhenBack = (go) => {
		if (!back) timer = setTimeout(again, 1000);
		if (back !== home) back = go;
	};

	// No answer, and not because this page is being left (a reload on its
	// way cancels the probe too).
	const down = (ok) => !ok && !reloading && !leaving;

	// "Can't reach studio": the machine of the last /hello (src/lib/reach.ts).
	function offline() {
		if (booted()) dispatchEvent(new Event("pulsar:offline"));
		else {
			try {
				document.getElementById("boot-machine").textContent =
					localStorage.getItem("pulsar.machine") || "your machine";
			} catch {}
			document.getElementById("boot-offline").hidden = false;
		}
		// Into the served build once it answers (a failed import is cached).
		window.__pulsarWhenBack(home);
	}

	// One automatic reload per minute, shared by every path below and by
	// src/lib/lazy.tsx: true when a reload is on its way.
	let reloading = false;
	function retry() {
		if (reloading) return true;
		if (leaving) return false;
		let last = 0;
		try {
			last = Number(sessionStorage.getItem(KEY)) || 0;
		} catch {}
		if (Date.now() - last <= WINDOW_MS) return false;
		try {
			sessionStorage.setItem(KEY, String(Date.now()));
		} catch {
			return false;
		}
		reloading = true;
		// The same failure often reports twice (the file, then the import
		// that needed it): wait a moment for both, 1.5 s at most.
		wait(100)
			.then(() => Promise.race([Promise.all(inflight), wait(1500)]))
			.then(() => {
				leaving = true;
				reload();
			});
		return true;
	}

	function fail(err, urls) {
		if (leaving) return;
		report(booted() ? "chunk" : "boot", err, urls);
		if (failed || quiet()) return;
		failed = true;
		// The daemon unreachable: say so and wait for it, no reload. Else,
		// after the automatic retry, the error screen. Once the app runs, a
		// lazy chunk shows its own Retry (src/lib/lazy.tsx) instead: never
		// cover a working app.
		reach().then((ok) => {
			if (down(ok)) return offline();
			if (retry()) return;
			if (!booted()) show();
		});
	}

	const chunkError = (reason) =>
		/dynamically imported module|module script failed|Unable to preload|error loading dynamically/i.test(
			String(reason?.message ?? reason),
		);

	// For src/lib/lazy.tsx: a screen whose chunk did not download reloads
	// into the served build by itself (once a minute) before it shows its
	// Retry, and that Retry reloads past the cached shell too: true when a
	// reload is on its way. With the daemon unreachable: "offline", and a
	// reload once it answers.
	window.__pulsarRecover = (reason) =>
		chunkError(reason)
			? reach().then((ok) => (down(ok) ? (offline(), "offline") : retry()))
			: Promise.resolve(false);
	// Before the app mounts the entry's own errors; after, module-load ones.
	const moduleError = (reason) => {
		if (chunkError(reason)) report("module", reason);
	};
	window.__pulsarReload = () => {
		try {
			sessionStorage.setItem(KEY, String(Date.now()));
		} catch {}
		reload();
	};

	// Capture phase: a <script> or <link> load error does not bubble.
	addEventListener(
		"error",
		(e) => {
			const t = e.target;
			const lost = (url) => fail({ name: "LoadError", message: url }, [url]);
			if (t instanceof HTMLScriptElement) return lost(t.src);
			if (
				t instanceof HTMLLinkElement &&
				/stylesheet|modulepreload/.test(t.rel)
			)
				return lost(t.href);
			// A script error before the app mounts (a top-level module error).
			if (t === window && !booted()) fail(e.error ?? e.message);
			else if (t === window) moduleError(e.error ?? e.message);
		},
		true,
	);
	// Vite's dynamic import helper: a lazy chunk (or its CSS) did not load.
	// It fires for any rejection of the import, errors the app handles
	// included (a passkey SecurityError, say): only download errors count.
	addEventListener("vite:preloadError", (e) => {
		if (chunkError(e.payload)) fail(e.payload);
	});
	addEventListener("unhandledrejection", (e) => {
		if (chunkError(e.reason)) fail(e.reason);
	});

	document.addEventListener("DOMContentLoaded", () => {
		document
			.getElementById("boot-retry")
			?.addEventListener("click", () => window.__pulsarReload());
		document.getElementById("boot-again")?.addEventListener("click", again);
		const copy = document.getElementById("boot-copy");
		copy?.addEventListener("click", () => {
			navigator.clipboard?.writeText(window.__pulsarLoadDetails()).then(
				() => {
					copy.textContent = "Copied";
				},
				() => {},
			);
		});
		// Module scripts run before DOMContentLoaded: an entry that ran
		// without mounting (no module support, blocked script) shows the
		// error screen too.
		setTimeout(() => {
			if (!booted() && !failed)
				fail({ name: "NotMounted", message: "the app did not start" });
		}, 0);
	});

	// A slow network: say so after a while.
	setTimeout(() => {
		if (booted()) return;
		const slow = document.getElementById("boot-slow");
		if (slow) slow.hidden = false;
	}, 6000);
})();
