// pulsar app service worker: caches the static shell only. API responses
// (/api/*) are never cached or intercepted, so stale agent data or
// transcripts never live in the cache. It also shows Web Push notifications:
// the push says only "approval pending" with an opaque id; tapping it opens
// that approval (details come from this node's API, never from the push).
const CACHE = "pulsar-shell-v2";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.then(() => self.skipWaiting()),
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

self.addEventListener("fetch", (event) => {
	const req = event.request;
	const url = new URL(req.url);
	if (req.method !== "GET" || url.origin !== location.origin) return;
	if (url.pathname.startsWith("/api/")) return;

	// Navigations: network first, the cached shell when offline.
	if (req.mode === "navigate") {
		event.respondWith(
			fetch(req)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((c) => c.put("/", copy));
					}
					return res;
				})
				.catch(() => caches.match("/").then((r) => r || Response.error())),
		);
		return;
	}

	// Hashed build assets are immutable: cache first.
	if (url.pathname.startsWith("/_app/")) {
		event.respondWith(
			caches.match(req).then(
				(hit) =>
					hit ||
					fetch(req).then((res) => {
						if (res.ok) {
							const copy = res.clone();
							caches.open(CACHE).then((c) => c.put(req, copy));
						}
						return res;
					}),
			),
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
	if (data.kind !== "approval" || typeof data.id !== "string") return;
	const badge =
		typeof data.badge === "number" && self.navigator.setAppBadge
			? self.navigator.setAppBadge(data.badge).catch(() => {})
			: Promise.resolve();
	event.waitUntil(
		Promise.all([
			badge,
			self.registration.showNotification("Approval pending", {
				body: "An agent needs your approval.",
				tag: `approval:${data.id}`,
				icon: "/icon.svg",
				data: { id: data.id },
			}),
		]),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const id = event.notification.data?.id;
	event.waitUntil(
		(async () => {
			let target = event.notification.data?.security ? "/" : "/#/needs";
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
