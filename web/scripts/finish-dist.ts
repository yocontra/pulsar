/**
 * Post-build step for dist/web, after `astro build`, before check-dist.ts:
 *
 * 1. Build id: a hash of every built file except sw.js. Written into
 *    index.html (`<meta name="pulsar-build">`) and sw.js, whose cache is
 *    named after it, so one service worker's cache only ever holds one
 *    build's shell.
 * 2. Precache list in sw.js: the shell ("/", boot.js, manifest, icon), its
 *    stylesheets, and the initial route's JS (entry + static imports + both
 *    layouts + the data layer, which boot() always loads, + both session
 *    views). Other lazy chunks are cached when first used.
 *    index.html gets a modulepreload for each static import of the entry, so
 *    the browser fetches them with the entry instead of one round trip later.
 * 3. Precompression: `.br` and `.gz` next to every text file of 1 KB or
 *    more where it saves 10%+; src/transport/static.ts serves them.
 */
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import {
	closure,
	DIST,
	entryScripts,
	entryStyles,
	isSidecar,
	layoutChunks,
	walk,
} from "./dist-graph.ts";

const COMPRESSIBLE = new Set([
	".html",
	".js",
	".mjs",
	".css",
	".svg",
	".json",
	".webmanifest",
	".txt",
	".map",
]);

// Runs once per `astro build` output (it rewrites index.html and sw.js).
const swPath = join(DIST, "sw.js");
const sw = readFileSync(swPath, "utf8");
if (
	!sw.includes('"__PULSAR_BUILD__"') ||
	!sw.includes('["__PULSAR_PRECACHE__"]')
)
	throw new Error("sw.js is missing the build placeholders");

// A rebuild over an old dist: drop stale sidecars first.
for (const f of walk(DIST)) if (isSidecar(f)) rmSync(f);

const files = walk(DIST).sort();
const hash = createHash("sha256");
for (const f of files) {
	if (relative(DIST, f) === "sw.js") continue;
	hash.update(relative(DIST, f)).update("\0").update(readFileSync(f));
}
const build = hash.digest("hex").slice(0, 12);

const indexPath = join(DIST, "index.html");
const index = readFileSync(indexPath, "utf8");
if (!index.includes("<head>")) throw new Error("index.html has no <head>");
const entries = entryScripts();
const preloads = [...closure(entries)]
	.filter((f) => !entries.includes(f))
	.map((f) => `<link rel="modulepreload" href="/${relative(DIST, f)}">`)
	.join("");
writeFileSync(
	indexPath,
	index
		.replace("<head>", `<head><meta name="pulsar-build" content="${build}">`)
		.replace("</head>", `${preloads}</head>`),
);

// The data layer (web/src/data, a lazy chunk boot() imports right away),
// and each layout's session view (the phone's agent page, the desktop's
// session pane): opening a chat is what the app is for, so its chunks come
// from the cache, not one round trip per chunk on the first open.
const lazyShell = files.filter((f) =>
	/_app\/(bridge|AgentPage|SessionDesktop)\.[^/]+\.js$/.test(f),
);
if (lazyShell.length !== 3)
	throw new Error("expected the bridge, AgentPage and SessionDesktop chunks");
const shell = [
	...entryStyles(),
	...closure([...entries, ...layoutChunks(files), ...lazyShell]),
];
const precache = [
	"/",
	"/boot.js",
	"/prefs.js",
	"/preload.js",
	"/manifest.webmanifest",
	"/icon.svg",
	...new Set(shell.map((f) => `/${relative(DIST, f)}`)),
];
writeFileSync(
	swPath,
	sw
		.replace('"__PULSAR_BUILD__"', JSON.stringify(build))
		.replace('["__PULSAR_PRECACHE__"]', JSON.stringify(precache)),
);

let raw = 0;
let br = 0;
let gz = 0;
let count = 0;
for (const f of walk(DIST)) {
	if (!COMPRESSIBLE.has(extname(f))) continue;
	const data = readFileSync(f);
	if (data.length < 1024) continue;
	const b = brotliCompressSync(data, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: 11,
			[constants.BROTLI_PARAM_SIZE_HINT]: data.length,
		},
	});
	const g = gzipSync(data, { level: 9 });
	if (b.length < data.length * 0.9) {
		writeFileSync(`${f}.br`, b);
		br += b.length;
	}
	if (g.length < data.length * 0.9) {
		writeFileSync(`${f}.gz`, g);
		gz += g.length;
	}
	raw += data.length;
	count++;
}
const kb = (n: number) => `${(n / 1024).toFixed(0)} KB`;
console.log(
	`finish-dist: build ${build}; precache ${precache.length} files (${kb(shell.reduce((s, f) => s + statSync(f).size, 0))}); compressed ${count} files ${kb(raw)} -> br ${kb(br)}, gzip ${kb(gz)}`,
);
