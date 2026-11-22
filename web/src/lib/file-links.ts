/**
 * The file viewer's route (features/files) and where a path sits in an
 * agent's folder. Pure.
 */
import type { Route } from "./hash.ts";

/**
 * The file viewer's route: `#/file/<agentId>?path=<rel>&line=<n>`, `path`
 * relative to the agent's folder ("" or none: its top).
 */
export function fileRoute(agentId: string, path: string, line?: number): Route {
	const params = {
		...(path ? { path } : {}),
		...(line ? { line: String(line) } : {}),
	};
	return {
		view: "page",
		name: "file",
		arg: agentId,
		...(path || line ? { params } : {}),
	};
}

/**
 * A path relative to the agent's folder (`cwd`, absolute or `~/…`), "" for
 * the folder itself; null when the path is outside it or no folder is known.
 */
export function insideFolder(
	path: string,
	cwd: string | null | undefined,
): string | null {
	if (!cwd) return null;
	const root = normalize(cwd);
	const abs = normalize(path);
	if (root === null || abs === null) return null;
	if (abs === root) return "";
	return abs.startsWith(root.endsWith("/") ? root : `${root}/`)
		? abs.slice(root.length + (root.endsWith("/") ? 0 : 1))
		: null;
}

/** `/a/./b/../c` → `/a/c` (also under `~/`); null for a relative path. */
function normalize(p: string): string | null {
	const tilde = p === "~" || p.startsWith("~/");
	if (!tilde && !p.startsWith("/")) return null;
	const out: string[] = [];
	for (const s of (tilde ? p.slice(1) : p).split("/")) {
		if (!s || s === ".") continue;
		if (s === "..") out.pop();
		else out.push(s);
	}
	return `${tilde ? "~" : ""}/${out.join("/")}`;
}
