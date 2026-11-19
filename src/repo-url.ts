/**
 * A repo's web page from its git remote, and the check a peer's copy must
 * pass. Pure: no git, no I/O.
 */

/** Longest repo URL pulsar keeps or accepts from a peer. */
const MAX_REPO_URL = 500;

const HOST =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const SEGMENT = /^[A-Za-z0-9._~-]+$/;
/** Remote schemes that name a server with a web UI at the same host. */
const SCHEMES = new Set([
	"https:",
	"http:",
	"ssh:",
	"git:",
	"git+ssh:",
	"ssh+git:",
]);

/** `owner/repo` (or `group/sub/repo`) from a remote path; null when it isn't one. */
function repoPath(path: string): string | null {
	const parts = path.replace(/\/+$/, "").split("/");
	const last = parts.length - 1;
	parts[last] = (parts[last] ?? "").replace(/\.git$/i, "");
	if (parts.length < 2) return null;
	for (const p of parts)
		if (!p || p === "." || p === ".." || !SEGMENT.test(p)) return null;
	return parts.join("/");
}

/**
 * The https page of a git remote: `git@host:owner/repo.git`,
 * `ssh://[user@]host[:port]/owner/repo`, `https://[user:token@]host/owner/repo`.
 * Built from the parsed host and path only, so credentials, an ssh port, a
 * query or a hash never reach it; only the host is lowercased. File paths,
 * local paths and anything else that isn't `host/owner/repo` give null.
 */
export function remoteWebUrl(raw: string | null | undefined): string | null {
	const s = raw?.trim();
	if (!s || s.length > 1000 || /[\s\\]/.test(s)) return null;
	let host: string;
	let port = "";
	let path: string;
	let scheme = "https:";
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
		let u: URL;
		try {
			u = new URL(s);
		} catch {
			return null;
		}
		if (!SCHEMES.has(u.protocol)) return null;
		host = u.hostname.toLowerCase();
		// A web port only means something for a web remote; an ssh port doesn't.
		if (u.protocol === "http:" || u.protocol === "https:") {
			scheme = u.protocol;
			port = u.port ? `:${u.port}` : "";
		}
		path = u.pathname.replace(/^\/+/, "");
	} else {
		// scp form: `[user@]host:path`. A one-letter host is a Windows drive.
		const m = /^(?:[^@/:]+@)?([^@/:]+):([^/].*)$/.exec(s);
		if (!m || (m[1] ?? "").length < 2) return null;
		host = (m[1] as string).toLowerCase();
		path = m[2] as string;
	}
	if (!HOST.test(host)) return null;
	const repo = repoPath(path);
	if (!repo) return null;
	const url = `${scheme}//${host}${port}/${repo}`;
	return url.length <= MAX_REPO_URL ? url : null;
}

/**
 * A repo URL from a peer, checked: http(s) only, no credentials, query or
 * hash, bounded. Anything else is dropped (null), so older peers that never
 * send it and odd values look the same.
 */
export function cleanRepoUrl(v: unknown): string | null {
	if (typeof v !== "string" || !v || v.length > MAX_REPO_URL) return null;
	// Whitespace, backslashes and control characters never belong in one.
	for (let i = 0; i < v.length; i++) {
		const c = v.charCodeAt(i);
		if (c < 0x21 || c === 0x7f || c === 0x5c) return null;
	}
	let u: URL;
	try {
		u = new URL(v);
	} catch {
		return null;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return null;
	if (u.username || u.password || u.search || u.hash || v.includes("@"))
		return null;
	if (!HOST.test(u.hostname)) return null;
	return u.href.replace(/\/$/, "");
}
