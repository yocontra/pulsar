// pulsar app service worker: caches the static shell only. API responses
// (/api/*) are never cached or intercepted, so stale agent data or
// transcripts never live in the cache. It also shows Web Push notifications:
// the push says only "approval pending" with an opaque id; tapping it opens
// that approval (details come from this node's API, never from the push).
// "An agent finished" / "An agent stopped with an error" carry only an
// opaque token for the agent; tapping one opens that agent.
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
			const res = old || (await fetch(url));
			if (!ok(res)) throw new Error(`pulsar: could not cache ${url}`);
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
			const others = (await caches.keys()).filter((k) => k !== CACHE);
			others.pop();
			await Promise.all(others.map((k) => caches.delete(k)));
			await self.clients.claim();
		})(),
	);
});

// The page asks for network-only navigations before it reloads after a
// failed chunk (web/public/boot.js), and waits for the reply.
self.addEventListener("message", (event) => {
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

/**
 * A plan usage limit passed a threshold or was reached: no names here, the
 * Usage page says which. One notice at a time (tag). A focused Pulsar tab
 * shows its own toast instead where the browser allows (as `turnNotice`).
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
	return self.registration.showNotification(
		reached
			? "An agent hit its usage limit"
			: "An agent is near its usage limit",
		{
			body: reached
				? "Open Pulsar to see when it resets."
				: `A usage limit passed ${level}%. Open Pulsar to see which.`,
			tag: "limit",
			icon: "/icon.svg",
			data: { limit: true },
		},
	);
}

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const id = event.notification.data?.id;
	const turn = event.notification.data?.turn;
	event.waitUntil(
		(async () => {
			let target = event.notification.data?.security
				? "/"
				: event.notification.data?.limit
					? "/#/usage"
					: "/#/needs";
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
