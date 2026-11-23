import {
	cpSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { APIRequestContext } from "@playwright/test";
import { expect, test } from "./fixtures.ts";

/**
 * Builds and deploys as the app sees them: staged copies of dist/web standing
 * in for another build, and the mock pointed at one (src/transport/static.ts
 * serves them as the daemon does). Importing this resets the mock and drops
 * the staged copies after each test.
 */

export const DIST = resolve(import.meta.dirname, "../../dist/web");
const H = { "X-Pulsar": "1" };

/** The built app's build id and entry script. */
export function current() {
	const html = readFileSync(join(DIST, "index.html"), "utf8");
	return {
		build: /name="pulsar-build" content="([0-9a-f]+)"/.exec(html)![1]!,
		entry: /<script type="module" src="([^"]+)"/.exec(html)![1]!,
	};
}

/** Point the mock at another dist folder and/or hold its HTML responses. */
export async function serve(
	request: APIRequestContext,
	body: {
		root?: string;
		htmlDelayMs?: number;
		webBuild?: string;
		previous?: string[];
	} = {},
) {
	const res = await request.post("/api/v1/__mock/static", {
		headers: H,
		data: body,
	});
	expect(res.ok()).toBe(true);
}

const staged: string[] = [];
test.afterEach(async ({ request }) => {
	await serve(request);
	for (const dir of staged.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

/**
 * A copy of dist/web standing in for another build: a new build id and
 * every JS and CSS file under a new name, as a real rebuild would hash them
 * (a file whose content changes must change its name too). `legacySw` swaps
 * in the pulsar-shell-v2 worker that phones still run.
 */
export function stageBuild(opts: { legacySw?: boolean } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pulsar-build-"));
	staged.push(root);
	cpSync(DIST, root, { recursive: true });
	const list = () => readdirSync(root, { recursive: true, encoding: "utf8" });
	// The copy serves uncompressed: no sidecar can go stale.
	for (const f of list()) if (/\.(br|gz)$/.test(f)) rmSync(join(root, f));
	const { build: old, entry } = current();
	const build = `${old.slice(0, 6)}${Math.random().toString(16).slice(2, 8)}`;
	const renamed = new Map<string, string>();
	for (const f of list()) {
		const m = /^_app\/([^/]+)\.(js|css)$/.exec(f);
		if (!m) continue;
		renamed.set(`${m[1]}.${m[2]}`, `${m[1]}.old.${m[2]}`);
		renameSync(join(root, f), join(root, "_app", `${m[1]}.old.${m[2]}`));
	}
	const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const names = new RegExp(
		`(?<=[/"'\`])(${[...renamed.keys()].map(escapeRe).join("|")})(?=[?"'\`)])`,
		"g",
	);
	for (const f of list()) {
		if (!/\.(js|css|html)$/.test(f)) continue;
		const src = readFileSync(join(root, f), "utf8");
		const out = src
			.replace(names, (n) => renamed.get(n)!)
			.replaceAll(old, build);
		if (out !== src) writeFileSync(join(root, f), out);
	}
	if (opts.legacySw)
		cpSync(
			resolve(import.meta.dirname, "fixtures/sw-v2.js"),
			join(root, "sw.js"),
		);
	const oldEntry = entry.replace(/\.js$/, ".old.js");
	// Nothing in the copy may still point at the current build's files.
	const html = readFileSync(join(root, "index.html"), "utf8");
	expect(html).toContain(oldEntry);
	expect(html).toContain(build);
	return { root, build, entry: oldEntry };
}
