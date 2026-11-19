/**
 * The built app's module graph, shared by finish-dist.ts (service worker
 * precache list) and check-dist.ts (initial-route budget).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const DIST = resolve(import.meta.dirname, "../../dist/web");

/** Precompressed siblings written by finish-dist.ts. */
export const isSidecar = (f: string) => /\.(br|gz)$/.test(f);

export function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? walk(p) : [p];
	});
}

/** Module scripts and modulepreloads in index.html (absolute paths). */
export function entryScripts(dist = DIST): string[] {
	const index = readFileSync(join(dist, "index.html"), "utf8");
	return [
		...index.matchAll(/<script[^>]*\btype="module"[^>]*\bsrc="([^"]+\.js)"/g),
		...index.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g),
	].map((m) => join(dist, m[1]!));
}

/** Stylesheets linked from index.html (absolute paths). */
export function entryStyles(dist = DIST): string[] {
	const index = readFileSync(join(dist, "index.html"), "utf8");
	return [
		...index.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g),
	].map((m) => join(dist, m[1]!));
}

/** `starts` plus everything they import statically (`import(` is lazy). */
export function closure(starts: string[]): Set<string> {
	const seen = new Set<string>();
	const queue = [...starts];
	while (queue.length) {
		const f = queue.pop()!;
		if (seen.has(f)) continue;
		seen.add(f);
		const src = readFileSync(f, "utf8");
		for (const m of src.matchAll(
			/(?:^|[;\s}])import\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"']+\.js)["']/g,
		)) {
			queue.push(resolve(join(f, ".."), m[1]!));
		}
	}
	return seen;
}

/** The app chunks the device loads right away: the desktop app or the phone shell. */
export function layoutChunks(files: string[]): string[] {
	return files.filter((f) => /_app\/(DesktopApp|PhoneApp)\.[^/]+\.js$/.test(f));
}
