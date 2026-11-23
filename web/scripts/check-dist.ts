/**
 * Post-build checks for dist/web:
 * - CSP: no inline <script>, <style>, style= or on*= attributes in any HTML
 *   (the daemon serves `script-src 'self'` and `default-src 'self'`).
 * - Budget, per layout: the initial route's JS (boot.js, entry + static
 *   imports + that layout's app chunk) gzipped (the .gz sidecars
 *   finish-dist.ts writes, which the daemon serves): the phone (Ionic shell,
 *   with its mode's Ionic styles) ≤ 183 KB, the desktop ≤ 130 KB.
 * - Package: dist/web ≤ 9 MB and ≤ 420 files unpacked, not counting the
 *   precompressed .br/.gz sidecars, which have their own ≤ 4 MB budget
 *   (Shiki languages and KaTeX fonts are trimmed in astro.config.mjs;
 *   Mermaid loads lazily).
 * - Service worker: sw.js and index.html carry the same build id.
 * Prints every chunk's gzipped size.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";
import {
	closure,
	DIST,
	entryScripts,
	isSidecar,
	layoutChunks,
	walk,
} from "./dist-graph.ts";

/** Initial JS per layout chunk (`_app/<name>.<hash>.js`), gzipped. */
const BUDGETS: Record<string, number> = {
	// Raised from 170 for Konsta UI's runtime on the first screen (the tab
	// bar; tailwind-merge with it, ~15 KB), then lowered from 185 at 180.8:
	// Home's search field is Konsta's, loaded after the first paint, not
	// Ionic's IonSearchbar, and Konsta's shared runtime is one chunk
	// (astro.config.mjs "konsta"), not split by lazy pages. Briefly 185
	// while a stale nested tailwind-merge copy put 2 KB more in some
	// checkouts' konsta chunk (astro.config.mjs resolve.dedupe fixes it);
	// lowered to 183 at 180.5 once the dead phone CSS and Ionic wrappers
	// were gone. Headroom ~2 KB.
	PhoneApp: 183 * 1024,
	DesktopApp: 130 * 1024,
};
// All of dist/web, uncompressed. Briefly 9.5 MB for the Konsta phone
// screens (9.01 MB); back to 9 MB at 8.85 MB once the dead phone CSS,
// Ionic wrappers and phone branches were deleted.
const PACKAGE_BYTES = 9 * 1024 * 1024;
// The count catches a bundle that fans out (Shiki's full bundle was 300+
// grammar chunks). What's here now is on-demand and expected: ~36 Mermaid
// diagram types, 20 KaTeX fonts, ~22 Shiki grammars, the formatter's
// plugins. Merging those would make one diagram or one language load all
// of them, so the cap has headroom instead (raised from 260 at 258, and
// from 300 to 340 at 271 for the lazy chunks of new features, then to 420 at
// 335 as more features landed as lazy chunks).
const PACKAGE_FILES = 420;
const SIDECAR_BYTES = 4 * 1024 * 1024;
const problems: string[] = [];

const all = walk(DIST);
const files = all.filter((f) => !isSidecar(f));
const sidecars = all.filter(isSidecar);
const gz = (p: string) =>
	existsSync(`${p}.gz`)
		? statSync(`${p}.gz`).size
		: gzipSync(readFileSync(p)).length;

for (const file of files.filter((f) => f.endsWith(".html"))) {
	const html = readFileSync(file, "utf8");
	const rel = relative(DIST, file);
	for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
		if (!/\bsrc=/.test(m[1] ?? ""))
			problems.push(`${rel}: inline <script>${(m[2] ?? "").slice(0, 60)}`);
	}
	if (/<style\b/i.test(html)) problems.push(`${rel}: inline <style>`);
	if (/\sstyle=/i.test(html)) problems.push(`${rel}: style= attribute`);
	if (/\son[a-z]+=/i.test(html)) problems.push(`${rel}: inline event handler`);
	if (/javascript:/i.test(html)) problems.push(`${rel}: javascript: URL`);
}

// Initial route: module scripts and modulepreloads in index.html, plus their
// static imports, plus the layout the device loads right away (one each).
// boot.js (the classic boot guard), prefs.js (Appearance, sidebar width) and
// preload.js (the first API reads) load first on every route too.
const entry = closure([
	...entryScripts(),
	join(DIST, "boot.js"),
	join(DIST, "prefs.js"),
	join(DIST, "preload.js"),
]);
const layouts = layoutChunks(files);
const initial = new Set<string>(entry);
const js = files.filter((f) => f.endsWith(".js") && f.includes("_app"));
const results: string[] = [];
for (const name of Object.keys(BUDGETS)) {
	const chunk = layouts.find((l) =>
		relative(DIST, l).startsWith(`_app/${name}.`),
	);
	if (!chunk) {
		problems.push(`no ${name} chunk: the per-layout budget can't be checked`);
		continue;
	}
	const c = new Set([...entry, ...closure([chunk])]);
	// The phone's Ionic styles for its mode load with its chunk
	// (components/App.tsx): count iOS's, report Android's beside it.
	if (name === "PhoneApp") {
		const reg = (mode: string) =>
			js.find((f) => relative(DIST, f).startsWith(`_app/${mode}-eager.`));
		const ios = reg("ios");
		const md = reg("md");
		if (!ios || !md)
			problems.push(
				"no ios-eager/md-eager chunk (astro.config.mjs ionicModeStyles)",
			);
		else {
			c.add(ios);
			results.push(
				`  (Ionic styles: iOS ${(gz(ios) / 1024).toFixed(1)} KB counted; Android ${(gz(md) / 1024).toFixed(1)} KB in its place)`,
			);
		}
	}
	for (const f of c) initial.add(f);
	const bytes = [...c].reduce((s, f) => s + gz(f), 0);
	const budget = BUDGETS[name]!;
	results.push(
		`initial JS, ${name}: ${(bytes / 1024).toFixed(1)} KB gzipped (budget ${budget / 1024} KB)`,
	);
	if (bytes > budget)
		problems.push(
			`${name} initial JS ${(bytes / 1024).toFixed(1)} KB > ${budget / 1024} KB`,
		);
}
console.log("dist/web chunks (gzipped, * = initial on some layout):");
for (const f of js.sort())
	console.log(
		`  ${initial.has(f) ? "*" : " "} ${(gz(f) / 1024).toFixed(1).padStart(6)} KB  ${relative(DIST, f)}`,
	);
for (const f of files.filter((f) => f.endsWith(".css")))
	console.log(
		`    ${(gz(f) / 1024).toFixed(1).padStart(6)} KB  ${relative(DIST, f)}`,
	);
for (const r of results) console.log(r);

// The Ionic CSP fix (astro.config.mjs) must have reached the Stencil runtime:
// an unpatched registerStyle would put <style> tags in <head>.
for (const f of js)
	if (/\w\(\w,\w,!!\(1&\w\.i\)\)/.test(readFileSync(f, "utf8")))
		problems.push(
			`${relative(DIST, f)}: Stencil registerStyle is unpatched (inline <style> under CSP)`,
		);

const total = files.reduce((s, f) => s + statSync(f).size, 0);
console.log(
	`dist/web: ${(total / 1024 / 1024).toFixed(2)} MB in ${files.length} files (budget ${PACKAGE_BYTES / 1024 / 1024} MB, ${PACKAGE_FILES} files)`,
);
if (total > PACKAGE_BYTES)
	problems.push(
		`dist/web is ${(total / 1024 / 1024).toFixed(2)} MB > ${PACKAGE_BYTES / 1024 / 1024} MB`,
	);
if (files.length > PACKAGE_FILES)
	problems.push(`dist/web has ${files.length} files > ${PACKAGE_FILES}`);
const sidecarBytes = sidecars.reduce((s, f) => s + statSync(f).size, 0);
console.log(
	`precompressed: ${(sidecarBytes / 1024 / 1024).toFixed(2)} MB in ${sidecars.length} .br/.gz files (budget ${SIDECAR_BYTES / 1024 / 1024} MB)`,
);
if (sidecarBytes > SIDECAR_BYTES)
	problems.push(
		`precompressed sidecars are ${(sidecarBytes / 1024 / 1024).toFixed(2)} MB > ${SIDECAR_BYTES / 1024 / 1024} MB`,
	);
if (!existsSync(join(DIST, "index.html.br")))
	problems.push("index.html is not precompressed (finish-dist.ts)");

const build = /<meta name="pulsar-build" content="([0-9a-f]+)">/.exec(
	readFileSync(join(DIST, "index.html"), "utf8"),
)?.[1];
const sw = readFileSync(join(DIST, "sw.js"), "utf8");
if (!build || !sw.includes(`const BUILD = "${build}"`))
	problems.push("sw.js and index.html do not carry the same build id");
if (sw.includes("__PULSAR_"))
	problems.push("sw.js still has a build placeholder");

for (const f of files)
	if (/\.(woff|ttf)$/.test(f))
		problems.push(`${relative(DIST, f)}: only woff2 fonts ship`);

// Heavy libraries must stay out of the initial route.
const initialSrc = [...initial].map((f) => readFileSync(f, "utf8")).join("\n");
for (const [name, marker] of [
	["streamdown", "streamdown"],
	["shiki", "shiki"],
	["mermaid", "mermaid"],
	["katex", "katex"],
	["simplewebauthn", "WebAuthn"],
	["uqr", "QrCode"],
] as const) {
	if (initialSrc.includes(marker))
		problems.push(`${name} is in the initial route`);
}

if (problems.length) {
	console.error(`\ncheck-dist failed:\n- ${problems.join("\n- ")}`);
	process.exit(1);
}
console.log("check-dist: ok (no inline scripts or styles; budget met)");
