// pulsar app service worker: caches the static shell only. API responses
// (/api/*) are never cached or intercepted, so stale agent data or
// transcripts never live in the cache. It also shows Web Push notifications:
// the push says only "approval pending" with an opaque id; tapping it opens
// that approval (details come from this node's API, never from the push).
// "An agent finished" / "An agent stopped with an error" carry only an
// opaque token for the agent; tapping one opens that agent.
// The cache belongs to one build: web/scripts/finish-dist.ts writes the build
// id and that build's shell (HTML, boot.js, CSS, initial-route JS) below, the
// install step fills the cache with exactly those files, and activate drops
// every other cache. A cached shell therefore never points at assets from
// another build.
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

self.addEventListener("install", (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// Immutable /_app/ files come from the HTTP cache when the page just
			// loaded them; the HTML and boot.js revalidate (no-cache).
			await cache.addAll(PRECACHE);
			// The server may have moved on to a newer build since this sw.js was
			// fetched: never keep another build's HTML. Install fails and the
			// browser tries again with the newer sw.js.
			const html = await (await cache.match("/"))?.text();
			if (!html?.includes(`content="${BUILD}"`)) {
				await caches.delete(CACHE);
				throw new Error("pulsar: the server's HTML is from another build");
			}
			await self.skipWaiting();
		})(),
	);
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) =>
				Promise.all(
					keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
				),
			)
			.then(() => self.clients.claim()),
	);
});

// The page asks for network-only navigations before it reloads after a
// failed chunk (web/public/boot.js), and waits for the reply.
self.addEventListener("message", (event) => {
	if (event.data?.type !== "bypass") return;
	networkOnlyUntil = Date.now() + BYPASS_MS;
	event.ports[0]?.postMessage("ok");
});

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
	const res = await fetch(req);
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

self.addEventListener("push", (event) => {
	let data = {};
	try {
		data = event.data ? event.data.json() : {};
	} catch {}
	if (data.kind === "security") {
		// A passkey or enrollment change: the app's settings say what happened.
		event.waitUntil(
			self.registration.showNotification("Pulsar security notice", {
				body: "A passkey or enrollment change on one of your machines. Open Pulsar to check.",
				tag: "security",
				icon: "/icon.svg",
				data: { security: true },
			}),
		);
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
			self.registration.showNotification(
				data.interaction ? "Answer needed" : "Approval pending",
				{
					body: data.interaction
						? "An agent is waiting for your answer."
						: "An agent needs your approval.",
					tag: `approval:${data.id}`,
					icon: "/icon.svg",
					data: { id: data.id },
				},
			),
		]),
	);
});

/**
 * An agent finished its turn or stopped with an error. The payload has only
 * an opaque token for the agent; tapping resolves it to the agent to open. A focused Pulsar tab shows
 * its own toast instead, where the browser allows a push without a
 * notification (Chromium; Safari and Firefox require one every time).
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
	return self.registration.showNotification(
		failed ? "An agent stopped with an error" : "An agent finished",
		{
			body: failed
				? "Open Pulsar to see what went wrong."
				: "Open Pulsar to see what it did.",
			tag: `turn:${data.ref}`,
			icon: "/icon.svg",
			silent: data.sound !== true,
			data: { turn: data.ref },
		},
	);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const id = event.notification.data?.id;
	const turn = event.notification.data?.turn;
	event.waitUntil(
		(async () => {
			let target = event.notification.data?.security ? "/" : "/#/needs";
			if (typeof turn === "string") {
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
			if (typeof id === "string") {
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
