import { createHash } from "node:crypto";
import { readFile, stat as statFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * The built app's static files (dist/web), shared by the daemon
 * (src/transport/http.ts) and the e2e mock (web/mock/server.ts).
 *
 * - Precompressed `.br` / `.gz` siblings (web/scripts/finish-dist.ts) are
 *   served by Accept-Encoding, with `Vary: Accept-Encoding`. A sibling older
 *   than its source is ignored.
 * - A strong ETag per variant (content hash outside `/_app/`); `If-None-Match` answers 304.
 * - Hashed build assets (`/_app/`) are immutable for a year; everything else
 *   (HTML, sw.js, boot.js, the manifest) is `no-cache` and revalidates.
 * - App routes (no extension) get `index.html`.
 */

const MIME: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json",
	".webmanifest": "application/manifest+json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".woff2": "font/woff2",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json",
	".woff": "font/woff",
	".ttf": "font/ttf",
	".wasm": "application/wasm",
	".webp": "image/webp",
};

export const IMMUTABLE = "public, max-age=31536000, immutable";

export type Encoding = "br" | "gzip";
const SUFFIX: Record<Encoding, string> = { br: ".br", gzip: ".gz" };

export type StaticResponse = {
	status: number;
	headers: Record<string, string>;
	body: Uint8Array<ArrayBuffer> | string | null;
};

/**
 * The best of `available` that `accept` (an Accept-Encoding header) allows:
 * highest q wins, br before gzip on a tie; `*` covers unlisted codings;
 * q=0 refuses. Null means identity.
 */
export function negotiate(
	accept: string | undefined,
	available: readonly Encoding[],
): Encoding | null {
	if (!accept || available.length === 0) return null;
	const q = new Map<string, number>();
	for (const part of accept.split(",")) {
		const [raw, ...params] = part.toLowerCase().split(";");
		const name = raw?.trim();
		if (!name) continue;
		let weight = 1;
		for (const p of params) {
			const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
			if (m) weight = Number(m[1]);
		}
		if (Number.isFinite(weight)) q.set(name, Math.min(1, Math.max(0, weight)));
	}
	let best: Encoding | null = null;
	let bestQ = 0;
	for (const enc of ["br", "gzip"] as const) {
		if (!available.includes(enc)) continue;
		const w =
			q.get(enc) ??
			(enc === "gzip" ? q.get("x-gzip") : undefined) ??
			q.get("*") ??
			0;
		if (w > bestQ) {
			best = enc;
			bestQ = w;
		}
	}
	return best;
}

async function stat(p: string) {
	try {
		const s = await statFile(p);
		return s.isFile() ? s : null;
	} catch {
		return null;
	}
}

const text = (status: number, body: string): StaticResponse => ({
	status,
	headers: { "Content-Type": "text/plain; charset=utf-8" },
	body,
});

/** Serves `path` (the URL path, still percent-encoded) from `root`. */
export async function serveStatic(
	root: string,
	path: string,
	req: { acceptEncoding?: string; ifNoneMatch?: string } = {},
): Promise<StaticResponse> {
	let rel: string;
	try {
		rel = decodeURIComponent(path);
	} catch {
		return text(400, "bad path");
	}
	if (rel.includes("\0")) return text(400, "bad path");
	const base = resolve(root);
	let file = resolve(base, normalize(`.${rel}`));
	if (file !== base && !file.startsWith(base + sep))
		return text(404, "not found");
	if (!(await stat(file))) {
		if (await stat(join(file, "index.html"))) file = join(file, "index.html");
		else if (!extname(file)) file = join(base, "index.html");
		else return text(404, "not found");
	}
	const src = await stat(file);
	if (!src) return text(404, "not found");

	// Precompressed siblings no older than the source.
	const variants = new Map<
		Encoding,
		NonNullable<Awaited<ReturnType<typeof stat>>>
	>();
	for (const enc of ["br", "gzip"] as const) {
		const s = await stat(file + SUFFIX[enc]);
		if (s && s.mtimeMs >= src.mtimeMs) variants.set(enc, s);
	}
	const enc = negotiate(req.acceptEncoding, [...variants.keys()]);
	const chosen = enc ? variants.get(enc)! : src;
	const servedPath = enc ? file + SUFFIX[enc] : file;
	const immutable = file.startsWith(join(base, "_app") + sep);
	// Hashed build assets never change under one name: size and mtime do.
	// The rest (index.html, sw.js) keeps its name across builds, often at the
	// same size, and package installs may flatten mtimes: hash the bytes.
	let body: Buffer | null = null;
	let tag: string;
	if (immutable)
		tag = `${chosen.size.toString(36)}-${Math.trunc(chosen.mtimeMs).toString(36)}`;
	else {
		body = await readFile(servedPath);
		tag = createHash("sha1").update(body).digest("base64url").slice(0, 22);
	}
	const etag = `"${tag}${enc ? `-${enc}` : ""}"`;

	const headers: Record<string, string> = {
		"Content-Type":
			MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
		"Cache-Control": immutable ? IMMUTABLE : "no-cache",
		ETag: etag,
	};
	if (variants.size) headers.Vary = "Accept-Encoding";
	if (enc) headers["Content-Encoding"] = enc;

	const inm = req.ifNoneMatch;
	if (
		inm &&
		(inm.trim() === "*" ||
			inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))
	)
		return { status: 304, headers, body: null };

	body ??= await readFile(servedPath);
	headers["Content-Length"] = String(body.byteLength);
	return {
		status: 200,
		headers,
		body: new Uint8Array(
			body.buffer as ArrayBuffer,
			body.byteOffset,
			body.byteLength,
		),
	};
}
