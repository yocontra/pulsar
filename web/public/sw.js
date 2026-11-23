// pulsar app service worker: caches the static shell only. API responses
// (/api/*) are never cached or intercepted, so stale agent data or
// transcripts never live in the cache. It also shows Web Push notifications
// with the text the daemon wrote (see `notice` below); tapping one opens the
// screen it names (that agent, that prompt, Usage).
// The cache belongs to one build: web/scripts/finish-dist.ts writes the build
// id and that build's files below (the shell, and every JS and CSS file of
// the build: a lazy chunk is never a network request away). Install fills
// the cache with exactly those files and stores the HTML last, so a cached
// shell means a complete build: a page the worker serves from the cache
// (a slow or failing network) never needs the server for its own chunks.
// Activate drops older caches but the one before (an open page may still
// run that build). A cached shell never points at assets from another build.
const BUILD = "__PULSAR_BUILD__";
const PRECACHE = ["__PULSAR_PRECACHE__"];
const CACHE = `pulsar-shell-${BUILD}`;
const PRECACHED = new Set(PRECACHE);
// How long a navigation waits for the network before the cached shell.
const NAV_TIMEOUT_MS = 3000;
// After a build asset 404s (the cached shell is older than the server's
// build), navigations wait for the network until this time.
let networkOnlyUntil = 0;
const BYPASS_MS = 60_000;
// Parallel downloads while installing.
const INSTALL_FETCHES = 6;
// Build files this worker failed to fetch lately (`/_app/x.js 404`), for
// the app's load error reports (web/public/boot.js asks with "info").
const failed = [];
function noteFailed(url, why) {
	failed.push(`${new URL(url, location.origin).pathname} ${why}`);
	if (failed.length > 5) failed.shift();
}

/**
 * Tells the daemon this worker could not install or activate (the page
 * never hears why): the build, the file, the error. Bounded; never throws.
 */
async function report(kind, err) {
	try {
		const body = {
			kind,
			build: BUILD,
			urls: err?.url ? [err.url] : [],
			error: {
				name: String(err?.name || "Error").slice(0, 80),
				message: String(err?.message ?? err).slice(0, 500),
			},
			sw: {
				controller: null,
				state: kind === "sw-install" ? "installing" : "activating",
				caches: (await caches.keys()).slice(-10),
				failed: failed.slice(),
			},
			online: self.navigator.onLine,
			standalone: false,
			ua: self.navigator.userAgent.slice(0, 400),
			route: "",
			reloaded: false,
			at: Date.now(),
		};
		await fetch("/api/v1/client-errors", {
			method: "POST",
			headers: { "X-Pulsar": "1", "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout?.(3000),
		});
	} catch {}
}

/** A response worth caching: complete, from this origin. */
const ok = (res) => res?.ok && res.status === 200 && !res.redirected;

async function fill(cache) {
	// The HTML first: the server may have moved on to a newer build since
	// this sw.js was fetched. Never keep another build's HTML: install fails
	// and the browser tries again with the newer sw.js.
	const shell = await fetch("/", { cache: "no-cache" });
	const html = ok(shell) ? await shell.clone().text() : "";
	if (!html.includes(`content="${BUILD}"`))
		throw new Error("pulsar: the server's HTML is from another build");
	const rest = PRECACHE.filter((u) => u !== "/");
	let next = 0;
	const worker = async () => {
		while (next < rest.length) {
			const url = rest[next++];
			// Hashed build files never change under one name: reuse an older
			// build's copy (most chunks survive a deploy), else download.
			const old = url.startsWith("/_app/") && (await caches.match(url));
			const res =
				old ||
				(await fetch(url).catch((e) => {
					noteFailed(url, "network");
					throw Object.assign(
						new Error(`pulsar: could not fetch ${url}: ${e?.message}`),
						{ url },
					);
				}));
			if (!ok(res)) {
				noteFailed(url, String(res?.status));
				throw Object.assign(
					new Error(`pulsar: could not cache ${url} (${res?.status})`),
					{ url },
				);
			}
			await cache.put(url, res);
		}
	};
	await Promise.all(Array.from({ length: INSTALL_FETCHES }, worker));
	// Last: the shell marks the cache complete (cachedShell).
	await cache.put("/", shell);
}

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			try {
				await fill(cache);
			} catch (err) {
				// Never leave an incomplete cache behind (a complete one of the
				// same build, from an earlier install, has its shell: keep it).
				if (!(await cache.match("/"))) await caches.delete(CACHE);
				await report("sw-install", err);
				throw err;
			}
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		(async () => {
			// Cache names keep their creation order: keep this build's and the
			// newest other one (the build an open page may still run).
			try {
				const others = (await caches.keys()).filter((k) => k !== CACHE);
				others.pop();
				await Promise.all(others.map((k) => caches.delete(k)));
				await self.clients.claim();
			} catch (err) {
				await report("sw-activate", err);
				throw err;
			}
		})(),
	);
});

// The page asks for network-only navigations before it reloads after a
// failed chunk (web/public/boot.js), and waits for the reply.
self.addEventListener("message", (event) => {
	// The page's load error report (web/public/boot.js): this worker's build
	// and the build files it failed to fetch.
	if (event.data?.type === "info") {
		event.ports[0]?.postMessage({ build: BUILD, failed: failed.slice() });
		return;
	}
	if (event.data?.type !== "bypass") return;
	networkOnlyUntil = Date.now() + BYPASS_MS;
	event.ports[0]?.postMessage("ok");
});

// This build's shell: install stores it after every other file, so it is
// there only when the whole build is.
const cachedShell = () => caches.open(CACHE).then((c) => c.match("/"));

async function navigate(req) {
	const net = fetch(req);
	if (Date.now() < networkOnlyUntil)
		return net.catch(async () => (await cachedShell()) || Response.error());
	// Network first; after NAV_TIMEOUT_MS (or a network error) this build's
	// cached shell, if there is one. Otherwise keep waiting for the network.
	const timeout = new Promise((ok) => setTimeout(ok, NAV_TIMEOUT_MS)).then(
		async () => (await cachedShell()) || net,
	);
	const fallback = net.catch(
		async () => (await cachedShell()) || Response.error(),
	);
	return Promise.race([fallback, timeout]);
}

async function asset(req) {
	const hit = await caches.match(req);
	if (hit) return hit;
	const res = await fetch(req).catch((e) => {
		noteFailed(req.url, "network");
		throw e;
	});
	if (!res.ok) noteFailed(req.url, String(res.status));
	if (res.ok) {
		const copy = res.clone();
		caches.open(CACHE).then((c) => c.put(req, copy));
	} else if (res.status === 404) {
		// The page runs a shell whose build the server no longer has.
		networkOnlyUntil = Date.now() + BYPASS_MS;
	}
	return res;
}

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	if (req.mode === "navigate") {
		event.respondWith(navigate(req));
		return;
	}
	// Hashed build assets are immutable: cache first.
	if (url.pathname.startsWith("/_app/")) {
		event.respondWith(asset(req));
		return;
	}
	// The rest of this build's shell (boot.js, manifest, icon): this cache
	// first, so a cached shell never waits on a stalled network.
	if (PRECACHED.has(url.pathname) && !url.search && url.pathname !== "/") {
		event.respondWith(
			caches
				.open(CACHE)
				.then((c) => c.match(req))
				.then((hit) => hit || fetch(req)),
		);
	}
});

// The daemon writes each notification's text (src/service/push-copy.ts):
// title, body, tag and the screen a tap opens. The payload is encrypted for
// this browser, so the push service never sees it. Older daemons send only
// the kind and opaque ids: then the generic copy below shows.
const TITLE_MAX = 60;
const BODY_MAX = 180;
const str = (v, max) =>
	typeof v === "string" && v.trim() ? v.slice(0, max) : "";
/** Only this app's own routes: `/` or `/#/…`. */
const route = (v) =>
	typeof v === "string" && (v === "/" || v.startsWith("/#/")) ? v : "";

/** The daemon's text when present, else the generic copy. */
function notice(data, title, body, tag, extra) {
	const url = route(data.url);
	return self.registration.showNotification(
		str(data.title, TITLE_MAX) || title,
		{
			body: str(data.body, BODY_MAX) || body,
			tag: str(data.tag, 100) || tag,
			// A newer notice for the same agent alerts again.
			renotify: true,
			icon: "/icon.svg",
			...extra,
			data: { ...extra?.data, ...(url ? { url } : {}) },
		},
	);
}

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	if (data.kind === "security") {
		event.waitUntil(
			notice(
				data,
				"Security notice",
				"A passkey or device change. Open Pulsar to check.",
				"security",
				{ data: { security: true } },
			),
		);
		return;
	}
	if (data.kind === "limit" && typeof data.level === "number") {
		event.waitUntil(limitNotice(data));
		return;
	}
	if (
		(data.kind === "finished" || data.kind === "failed") &&
		typeof data.ref === "string"
	) {
		event.waitUntil(turnNotice(data));
		return;
	}
	if (data.kind !== "approval" || typeof data.id !== "string") return;
	const badge =
		typeof data.badge === "number" && self.navigator.setAppBadge
			? self.navigator.setAppBadge(data.badge).catch(() => {})
			: Promise.resolve();
	event.waitUntil(
		Promise.all([
			badge,
			notice(
				data,
				data.interaction ? "Answer needed" : "Approval needed",
				data.interaction
					? "An agent is waiting for your answer."
					: "An agent is waiting for your approval.",
				`approval:${data.id}`,
				{ data: { id: data.id } },
			),
		]),
	);
});

/**
 * An agent finished its turn or stopped with an error. A focused Pulsar
 * tab shows its own toast instead, where the browser allows a push without
 * a notification (Chromium; Safari and Firefox require one every time).
 */
async function turnNotice(data) {
	const failed = data.kind === "failed";
	const tabs = await self.clients.matchAll({ type: "window" });
	const chromium = /Chrome\//.test(self.navigator.userAgent);
	if (
		chromium &&
		tabs.some((c) => c.focused && c.visibilityState === "visible")
	)
		return;
	return notice(
		data,
		failed ? "An agent stopped with an error" : "An agent finished",
		failed
			? "Open Pulsar to see what went wrong."
			: "Open Pulsar to see what it did.",
		`turn:${data.ref}`,
		{ silent: data.sound !== true, data: { turn: data.ref } },
	);
}

/**
 * A plan usage limit passed a threshold or was reached. One notice per
 * limit (tag). A focused Pulsar tab shows its own toast instead where the
 * browser allows (as `turnNotice`).
 */
async function limitNotice(data) {
	const tabs = await self.clients.matchAll({ type: "window" });
	const chromium = /Chrome\//.test(self.navigator.userAgent);
	if (
		chromium &&
		tabs.some((c) => c.focused && c.visibilityState === "visible")
	)
		return;
	const reached = data.reached === true;
	const level = Math.max(0, Math.min(100, Math.round(data.level)));
	return notice(
		data,
		reached ? "A usage limit was reached" : `A usage limit passed ${level}%`,
		reached
			? "Agents on that plan pause until it resets. Open Pulsar to see when."
			: "Open Pulsar to see which plan and when it resets.",
		"limit",
		{ data: { limit: true } },
	);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const id = event.notification.data?.id;
	const turn = event.notification.data?.turn;
	const url = route(event.notification.data?.url);
	event.waitUntil(
		(async () => {
			let target = event.notification.data?.security
				? "/"
				: event.notification.data?.limit
					? "/#/usage"
					: "/#/needs";
			// The daemon named the screen: no lookup needed.
			if (url) target = url;
			else if (typeof turn === "string") {
				target = "/";
				try {
					const res = await fetch(
						`/api/v1/push/turns/${encodeURIComponent(turn)}`,
						{ headers: { "X-Pulsar": "1" } },
					);
					if (res.ok) {
						const t = await res.json();
						if (typeof t.agentId === "string")
							target = `/#/a/${encodeURIComponent(t.agentId)}`;
					}
				} catch {}
			}
			if (!url && typeof id === "string") {
				try {
					const res = await fetch(
						`/api/v1/approvals/${encodeURIComponent(id)}`,
						{
							headers: { "X-Pulsar": "1" },
						},
					);
					if (res.ok) {
						const a = await res.json();
						if (a.agentId)
							target = `/#/approval/${encodeURIComponent(a.agentId)}`;
					}
				} catch {}
			}
			const tabs = await self.clients.matchAll({
				type: "window",
				includeUncontrolled: true,
			});
			const tab = tabs.find((c) => new URL(c.url).origin === location.origin);
			if (tab) {
				await tab.focus();
				return tab.navigate(target);
			}
			return self.clients.openWindow(target);
		})(),
	);
});
