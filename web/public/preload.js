// pulsar data preload: an async classic script at the top of <head> (external,
// so the CSP's script-src 'self' allows it). It starts the first screen's
// API reads (hello, the machine tree, the branches this device keeps open,
// needs-you, recently active) while the stylesheets and the app's JS still
// download, instead of after the entry and the data layer chunk have run.
// The app (src/api/client.ts, takePreload) uses each response at most once,
// for a request to the exact same path with the same session token, within
// PRELOAD_MS; anything else it fetches itself. The paths must match what the
// app asks for (src/data/queries.ts defs; test/web-preload.test.ts checks).
(() => {
	const get = (k) => {
		try {
			return JSON.parse(localStorage.getItem(`pulsar.${k}`) ?? "null");
		} catch {
			return null;
		}
	};
	let token = null;
	try {
		token = localStorage.getItem("pulsar.session");
	} catch {}
	const at = Date.now();
	const pending = new Map();
	const go = (path) => {
		const res = fetch(`/api/v1${path}`, {
			headers: {
				"X-Pulsar": "1",
				...(token ? { Authorization: `Bearer ${token}` } : {}),
			},
			credentials: "omit",
			cache: "no-store",
		});
		res.catch(() => {});
		pending.set(path, { res, at, token });
	};
	const SORTS = ["needs", "busy", "recent", "name"];
	const sort = SORTS.includes(get("sort")) ? get("sort") : "needs";
	const open = get("expanded.machines");
	go("/hello");
	// A device's first visit (no branch ever opened or closed) also asks for
	// the branches the app opens by default.
	go(
		`/tree?group=machines&sort=${sort}&limit=100${open === null ? "&expand=default" : ""}`,
	);
	go("/attention");
	go("/recent");
	if (Array.isArray(open))
		for (const id of open.slice(0, 8))
			if (typeof id === "string")
				go(`/tree/${encodeURIComponent(id)}/children?sort=${sort}`);
	// A link straight to a session (#/a/<id>): its row and newest page too.
	const m = /^#\/a\/([^/?]+)/.exec(location.hash);
	if (m) {
		let id = null;
		try {
			id = decodeURIComponent(m[1]);
		} catch {}
		if (id) {
			go(`/agents/${encodeURIComponent(id)}`);
			go(`/agents/${encodeURIComponent(id)}/transcript`);
		}
	}
	window.__pulsarPreload = pending;
})();
