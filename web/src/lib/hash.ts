/** Hash routes: parsing and building `#/a/<id>`-style URLs (no DOM access). */
export type Route =
	| { view: "home" }
	| { view: "agent"; id: string }
	/** A subagent: its transcript, under its parent agent (`#/s/<id>`). */
	| { view: "subagent"; id: string }
	| { view: "node"; id: string }
	| { view: "ids"; ids: string[] }
	| { view: "broadcast"; selector: string }
	| { view: "needs" }
	| { view: "approval"; id: string }
	/** An agent's worktree changes: the phone's page, the desktop's panel. */
	| { view: "changes"; id: string; file?: string }
	/** Phone only: settings and Ask are screens of their own. */
	| { view: "settings" }
	| { view: "ask" }
	/**
	 * A page a feature registered (lib/registry.tsx `registerPage`):
	 * `#/<name>/<arg>?<params>`.
	 */
	| {
			view: "page";
			name: string;
			arg?: string;
			params?: Record<string, string>;
	  };

/** First path segments the app itself routes; pages can't take them. */
const BUILT_IN = new Set([
	"a",
	"s",
	"n",
	"ids",
	"broadcast",
	"needs",
	"approval",
	"changes",
	"settings",
	"ask",
]);
const pageNames = new Set<string>();
const pageListeners = new Set<() => void>();

/** Lets `#/<name>` parse as a page route (lib/registry.tsx calls it). */
export function registerPageName(name: string) {
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(name) || BUILT_IN.has(name))
		throw new Error(`not a page name: ${name}`);
	pageNames.add(name);
	for (const fn of pageListeners) fn();
}

/** Called when a page name is registered (the router re-reads the first URL). */
export function onPageName(fn: () => void): () => void {
	pageListeners.add(fn);
	return () => {
		pageListeners.delete(fn);
	};
}

export function parseHash(hash: string): Route {
	const h = hash.replace(/^#/, "");
	const [path = "", qs = ""] = h.split("?");
	const params = new URLSearchParams(qs);
	const parts = path.split("/").filter(Boolean);
	let arg = "";
	try {
		arg = parts[1] ? decodeURIComponent(parts.slice(1).join("/")) : "";
	} catch {
		// A malformed escape (`#/a/%E0`): show home rather than a blank app.
		return { view: "home" };
	}
	switch (parts[0]) {
		case "a":
			return arg ? { view: "agent", id: arg } : { view: "home" };
		case "s":
			return arg ? { view: "subagent", id: arg } : { view: "home" };
		case "n":
			return arg ? { view: "node", id: arg } : { view: "home" };
		case "ids":
			return {
				view: "ids",
				ids: (params.get("ids") ?? "").split(",").filter(Boolean),
			};
		case "broadcast":
			return { view: "broadcast", selector: params.get("s") ?? "*" };
		case "needs":
			return { view: "needs" };
		case "approval":
			return arg ? { view: "approval", id: arg } : { view: "home" };
		case "changes": {
			const file = params.get("f");
			return arg
				? { view: "changes", id: arg, ...(file ? { file } : {}) }
				: { view: "home" };
		}
		case "settings":
			return { view: "settings" };
		case "ask":
			return { view: "ask" };
		default: {
			const name = parts[0] ?? "";
			if (!pageNames.has(name)) return { view: "home" };
			const p = Object.fromEntries(params);
			return {
				view: "page",
				name,
				...(arg ? { arg } : {}),
				...(Object.keys(p).length ? { params: p } : {}),
			};
		}
	}
}

export function hrefFor(r: Route): string {
	const e = encodeURIComponent;
	switch (r.view) {
		case "home":
			return "#/";
		case "agent":
			return `#/a/${e(r.id)}`;
		case "subagent":
			return `#/s/${e(r.id)}`;
		case "node":
			return `#/n/${e(r.id)}`;
		case "ids":
			return `#/ids?ids=${r.ids.map(e).join(",")}`;
		case "broadcast":
			return `#/broadcast?s=${e(r.selector)}`;
		case "needs":
			return "#/needs";
		case "approval":
			return `#/approval/${e(r.id)}`;
		case "changes":
			return `#/changes/${e(r.id)}${r.file ? `?f=${e(r.file)}` : ""}`;
		case "settings":
			return "#/settings";
		case "ask":
			return "#/ask";
		case "page": {
			const qs = new URLSearchParams(r.params ?? {}).toString();
			return `#/${e(r.name)}${r.arg ? `/${e(r.arg)}` : ""}${qs ? `?${qs}` : ""}`;
		}
	}
}
