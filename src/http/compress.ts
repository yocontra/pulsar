import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import type { Context, Next } from "hono";

const br = promisify(brotliCompress);
const gz = promisify(gzip);

/** Smaller than this, a JSON body goes as is (headers would eat the gain). */
export const COMPRESS_MIN = 1024;

/**
 * Compresses JSON API responses (a transcript page is ~100 KB; tree and
 * agent lists grow with the pool) for clients that accept it: brotli at a
 * fast level, else gzip. Off the event loop (zlib's thread pool). The event
 * stream and media are left alone: only `application/json` bodies.
 */
export async function compressJson(c: Context, next: Next) {
	await next();
	const res = c.res;
	if (
		!res.body ||
		res.headers.has("content-encoding") ||
		!(res.headers.get("content-type") ?? "").startsWith("application/json")
	)
		return;
	const accept = c.req.header("accept-encoding") ?? "";
	const enc = /\bbr\b/.test(accept)
		? "br"
		: /\bgzip\b/.test(accept)
			? "gzip"
			: null;
	if (!enc) return;
	const raw = Buffer.from(await res.arrayBuffer());
	const headers = new Headers(res.headers);
	headers.append("vary", "Accept-Encoding");
	if (raw.length < COMPRESS_MIN) {
		c.res = new Response(raw, { status: res.status, headers });
		return;
	}
	const body =
		enc === "br"
			? await br(raw, {
					params: {
						[constants.BROTLI_PARAM_QUALITY]: 4,
						[constants.BROTLI_PARAM_SIZE_HINT]: raw.length,
					},
				})
			: await gz(raw, { level: 5 });
	headers.set("content-encoding", enc);
	headers.delete("content-length");
	c.res = new Response(body, { status: res.status, headers });
}
