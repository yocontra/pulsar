import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, gunzipSync, gzipSync } from "node:zlib";
import { IMMUTABLE, negotiate, serveStatic } from "../src/transport/static.ts";

describe("negotiate", () => {
	const both = ["br", "gzip"] as const;
	test("prefers br, then gzip", async () => {
		expect(negotiate("gzip, deflate, br, zstd", both)).toBe("br");
		expect(negotiate("gzip, deflate", both)).toBe("gzip");
		expect(negotiate("br", ["gzip"])).toBeNull();
		expect(negotiate("gzip, br", ["gzip"])).toBe("gzip");
	});
	test("identity without a header, or with nothing available", async () => {
		expect(negotiate(undefined, both)).toBeNull();
		expect(negotiate("", both)).toBeNull();
		expect(negotiate("identity", both)).toBeNull();
		expect(negotiate("br, gzip", [])).toBeNull();
	});
	test("q-values: highest wins, q=0 refuses", async () => {
		expect(negotiate("br;q=0.5, gzip;q=0.8", both)).toBe("gzip");
		expect(negotiate("br;q=0, gzip", both)).toBe("gzip");
		expect(negotiate("br;q=0, gzip;q=0", both)).toBeNull();
		expect(negotiate("BR ; Q=1.0", both)).toBe("br");
	});
	test("wildcard and x-gzip", async () => {
		expect(negotiate("*", both)).toBe("br");
		expect(negotiate("*;q=0.1, br;q=0", both)).toBe("gzip");
		expect(negotiate("x-gzip", both)).toBe("gzip");
	});
});

describe("serveStatic", () => {
	let root: string;
	const js = "export const x = 1;\n".repeat(200);
	const html = `<!doctype html><title>pulsar</title>${"<p>hi</p>".repeat(200)}`;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "pulsar-static-"));
		mkdirSync(join(root, "_app"));
		writeFileSync(join(root, "index.html"), html);
		writeFileSync(join(root, "index.html.br"), brotliCompressSync(html));
		writeFileSync(join(root, "index.html.gz"), gzipSync(html));
		writeFileSync(join(root, "_app", "a.1234.js"), js);
		writeFileSync(join(root, "_app", "a.1234.js.br"), brotliCompressSync(js));
		writeFileSync(join(root, "_app", "a.1234.js.gz"), gzipSync(js));
		writeFileSync(join(root, "sw.js"), "self.x = 1;");
		writeFileSync(join(root, "icon.svg"), "<svg/>");
		// A sidecar older than its source is ignored.
		writeFileSync(join(root, "stale.css"), "body{color:red}");
		writeFileSync(join(root, "stale.css.br"), "not this");
		utimesSync(join(root, "stale.css.br"), new Date(0), new Date(0));
	});
	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const get = (path: string, accept?: string, inm?: string) =>
		serveStatic(root, path, { acceptEncoding: accept, ifNoneMatch: inm });
	const bytes = (b: unknown) => Buffer.from(b as Uint8Array);

	test("serves the precompressed variant with Vary, length and ETag", async () => {
		const br = await get("/_app/a.1234.js", "gzip, br");
		expect(br.status).toBe(200);
		expect(br.headers["Content-Encoding"]).toBe("br");
		expect(br.headers.Vary).toBe("Accept-Encoding");
		expect(br.headers["Content-Type"]).toBe("text/javascript; charset=utf-8");
		expect(Number(br.headers["Content-Length"])).toBe(
			bytes(br.body).byteLength,
		);
		expect(bytes(br.body).byteLength).toBeLessThan(js.length / 4);

		const gz = await get("/_app/a.1234.js", "gzip");
		expect(gz.headers["Content-Encoding"]).toBe("gzip");
		expect(gunzipSync(bytes(gz.body)).toString()).toBe(js);

		const plain = await get("/_app/a.1234.js");
		expect(plain.headers["Content-Encoding"]).toBeUndefined();
		expect(plain.headers.Vary).toBe("Accept-Encoding");
		expect(bytes(plain.body).toString()).toBe(js);

		// One ETag per variant.
		const tags = new Set([br, gz, plain].map((r) => r.headers.ETag));
		expect(tags.size).toBe(3);
	});

	test("If-None-Match answers 304 for the same variant only", async () => {
		const first = await get("/_app/a.1234.js", "br");
		const etag = first.headers.ETag!;
		const again = await get("/_app/a.1234.js", "br", etag);
		expect(again.status).toBe(304);
		expect(again.body).toBeNull();
		expect(again.headers.ETag).toBe(etag);
		expect(again.headers["Cache-Control"]).toBe(IMMUTABLE);
		expect(again.headers.Vary).toBe("Accept-Encoding");
		expect((await get("/_app/a.1234.js", "br", `"x", W/${etag}`)).status).toBe(
			304,
		);
		expect((await get("/_app/a.1234.js", "gzip", etag)).status).toBe(200);
	});

	test("a new build's sw.js of the same size and mtime gets a new ETag", async () => {
		const t = new Date(1_700_000_000_000);
		writeFileSync(join(root, "sw.js"), 'const BUILD = "aaaaaaaaaaaa";');
		utimesSync(join(root, "sw.js"), t, t);
		const before = (await get("/sw.js")).headers.ETag!;
		writeFileSync(join(root, "sw.js"), 'const BUILD = "bbbbbbbbbbbb";');
		utimesSync(join(root, "sw.js"), t, t);
		const after = await get("/sw.js");
		expect(after.headers.ETag).not.toBe(before);
		expect((await get("/sw.js", undefined, before)).status).toBe(200);
		writeFileSync(join(root, "sw.js"), "self.x = 1;");
	});

	test("cache policy: /_app/ immutable, everything else no-cache", async () => {
		expect((await get("/_app/a.1234.js")).headers["Cache-Control"]).toBe(
			IMMUTABLE,
		);
		for (const p of ["/", "/index.html", "/sw.js", "/icon.svg", "/agents/x"])
			expect((await get(p)).headers["Cache-Control"]).toBe("no-cache");
		// A missing build asset is a 404, never cached as immutable.
		const missing = await get("/_app/gone.js");
		expect(missing.status).toBe(404);
		expect(missing.headers["Cache-Control"]).toBeUndefined();
		// The SPA fallback under /_app/ is the HTML, not immutable.
		expect((await get("/_app/route")).headers["Cache-Control"]).toBe(
			"no-cache",
		);
	});

	test("app routes get index.html, compressed", async () => {
		const r = await get("/agents/abc", "br");
		expect(r.headers["Content-Type"]).toBe("text/html; charset=utf-8");
		expect(r.headers["Content-Encoding"]).toBe("br");
	});

	test("no sidecar or a stale one: identity, no Vary", async () => {
		const sw = await get("/sw.js", "br, gzip");
		expect(sw.headers["Content-Encoding"]).toBeUndefined();
		expect(sw.headers.Vary).toBeUndefined();
		const stale = await get("/stale.css", "br");
		expect(stale.headers["Content-Encoding"]).toBeUndefined();
		expect(bytes(stale.body).toString()).toBe("body{color:red}");
	});

	test("no traversal or bad paths", async () => {
		expect((await get("/../etc/passwd")).status).toBe(404);
		expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(404);
		expect((await get("/%E0%A4%A")).status).toBe(400);
		expect((await get("/a%00.js")).status).toBe(400);
	});
});
