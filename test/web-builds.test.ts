/**
 * Older installed builds after a deploy: the daemon serves their hashed app
 * files to pages that still run them (src/transport/static.ts), and an
 * upgrade keeps the newest builds for that (src/paths.ts retainedBuilds).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticIdentity } from "../src/http/identity.ts";
import {
	KEEP_BUILD_MS,
	KEEP_BUILDS,
	MAX_BUILDS,
	retainedBuilds,
} from "../src/paths.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { IMMUTABLE, serveStatic } from "../src/transport/static.ts";
import { restoreEnv } from "./helpers.ts";

const DAY = 24 * 60 * 60_000;

/** A build's dist/web under `dir`, with `files` (path → text). */
function webBuild(dir: string, files: Record<string, string>, at?: number) {
	const web = join(dir, "dist", "web");
	mkdirSync(web, { recursive: true });
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(join(web, path, ".."), { recursive: true });
		writeFileSync(join(web, path), text);
	}
	if (at !== undefined) utimesSync(dir, at / 1000, at / 1000);
	return web;
}

describe("serveStatic with older builds", () => {
	let dir: string;
	let cur: string;
	let old: string;
	let older: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-builds-"));
		cur = webBuild(join(dir, "b"), {
			"index.html": "<p>b</p>",
			"sw.js": "b",
			"_app/main.b.js": "b",
		});
		old = webBuild(join(dir, "a"), {
			"index.html": "<p>a</p>",
			"sw.js": "a",
			"boot.js": "a",
			"_app/main.a.js": "a",
			"_app/page.a.js": "a page",
			"_app/x.html": "<p>not this</p>",
			"secret.txt": "secret",
		});
		older = webBuild(join(dir, "z"), {
			"_app/page.a.js": "an older copy",
			"_app/z.css": "z",
		});
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	const get = (path: string) => serveStatic(cur, path, {}, [old, older]);
	const body = (b: unknown) => Buffer.from(b as Uint8Array).toString();

	test("a hashed asset gone from the current build comes from the newest older build that has it", async () => {
		const page = await get("/_app/page.a.js");
		expect(page.status).toBe(200);
		expect(body(page.body)).toBe("a page");
		expect(page.headers["Cache-Control"]).toBe(IMMUTABLE);
		expect(page.headers["Content-Type"]).toStartWith("text/javascript");
		const css = await get("/_app/z.css");
		expect(body(css.body)).toBe("z");
		// The current build wins when it has the file.
		expect(body((await get("/_app/main.b.js")).body)).toBe("b");
	});

	test("HTML, sw.js, boot.js and other root files never come from an older build", async () => {
		expect(body((await get("/")).body)).toBe("<p>b</p>");
		expect(body((await get("/sw.js")).body)).toBe("b");
		expect((await get("/boot.js")).status).toBe(404);
		expect((await get("/secret.txt")).status).toBe(404);
		expect((await get("/_app/x.html")).status).toBe(404);
		// An app route without an extension is the current index.html.
		expect(body((await get("/_app/nope")).body)).toBe("<p>b</p>");
	});

	test("no way out of the older builds' _app folders", async () => {
		for (const p of [
			"/_app/../secret.txt",
			"/_app/%2e%2e/secret.txt",
			"/_app/..%2fsecret.txt",
			"/_app/../../../a/dist/web/secret.txt",
			"/_app/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
		])
			expect((await get(p)).status).toBe(404);
		expect((await get("/_app/a%00.js")).status).toBe(400);
		expect((await get("/_app/gone.js")).status).toBe(404);
	});
});

describe("retainedBuilds", () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-retain-"));
	});
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("keeps the newest builds, any from the last two days, up to the cap", async () => {
		const root = join(dir, "install");
		const now = Date.now();
		const make = (name: string, at: number) => {
			mkdirSync(join(root, name), { recursive: true });
			utimesSync(join(root, name), at / 1000, at / 1000);
		};
		// 15 old builds, a day apart, from 10 days ago back.
		for (let i = 0; i < 15; i++) make(`1.0.${i}`, now - (10 + i) * DAY);
		writeFileSync(join(root, "notes.txt"), "");
		symlinkSync("1.0.0", join(root, "current"));
		const oldOnly = await retainedBuilds(root, now);
		expect(oldOnly).toHaveLength(KEEP_BUILDS);
		expect(oldOnly[0]).toBe("1.0.0");
		expect(oldOnly).not.toContain("1.0.14");

		// A busy day: 35 builds within the last two days, newest first.
		for (let i = 0; i < 35; i++)
			make(`2.0.0-${String(i).padStart(2, "0")}`, now - i * 60_000);
		const busy = await retainedBuilds(root, now);
		expect(busy).toHaveLength(MAX_BUILDS);
		expect(busy[0]).toBe("2.0.0-00");
		expect(busy.every((b) => b.startsWith("2.0.0-"))).toBe(true);

		// Past two days only the newest KEEP_BUILDS stay.
		expect(await retainedBuilds(root, now + KEEP_BUILD_MS + DAY)).toHaveLength(
			KEEP_BUILDS,
		);
		expect(await retainedBuilds(join(dir, "missing"), now)).toEqual([]);
	});
});

describe("the daemon serves an installed build's older siblings", () => {
	let dir: string;
	let http: HttpTransport;
	let service: PulsarService;
	let store: Store;
	let base: string;
	const saved = process.env.PULSAR_INSTALL_ROOT;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pulsar-installed-"));
		const install = join(dir, "install");
		const now = Date.now();
		webBuild(
			join(install, "2.0.0-old"),
			{ "index.html": "old", "_app/page.old.js": "old page" },
			now - 60_000,
		);
		// Pruned: past the retention rule.
		webBuild(
			join(install, "1.0.0"),
			{ "_app/ancient.js": "ancient" },
			now - 30 * DAY,
		);
		for (let i = 0; i < KEEP_BUILDS; i++)
			webBuild(join(install, `1.5.${i}`), {}, now - (3 + i) * DAY);
		const web = webBuild(
			join(install, "2.0.0-new"),
			{ "index.html": "new", "_app/main.new.js": "new" },
			now,
		);
		symlinkSync("2.0.0-new", join(install, "current"));
		process.env.PULSAR_INSTALL_ROOT = install;
		store = new Store(join(dir, "pulsar.db"));
		service = new PulsarService({ store, scan: false, machine: "studio" });
		http = new HttpTransport(service, {
			identity: new StaticIdentity("me@example.com", "phone"),
			owner: "me@example.com",
			hosts: ["127.0.0.1"],
			port: 0,
			// As the daemon finds it: through `current`.
			webRoot: join(install, "current", "dist", "web"),
		});
		await http.listen();
		base = `http://127.0.0.1:${http.port}`;
		expect(web).toBe(join(install, "2.0.0-new", "dist", "web"));
	});
	afterAll(async () => {
		restoreEnv("PULSAR_INSTALL_ROOT", saved);
		await http.close();
		service.stop();
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("an older build's chunk, immutable; its HTML never", async () => {
		const page = await fetch(`${base}/_app/page.old.js`);
		expect(page.status).toBe(200);
		expect(await page.text()).toBe("old page");
		expect(page.headers.get("cache-control")).toBe(IMMUTABLE);
		expect(await (await fetch(`${base}/`)).text()).toBe("new");
		expect(await (await fetch(`${base}/_app/main.new.js`)).text()).toBe("new");
		// A build past the retention rule is not looked at.
		expect((await fetch(`${base}/_app/ancient.js`)).status).toBe(404);
	});

	test("an app outside the install root (a checkout) serves its own files only", async () => {
		const checkout = webBuild(join(dir, "checkout"), { "index.html": "co" });
		const other = new HttpTransport(service, {
			identity: new StaticIdentity("me@example.com", "phone"),
			owner: "me@example.com",
			hosts: ["127.0.0.1"],
			port: 0,
			webRoot: checkout,
		});
		await other.listen();
		try {
			const r = await fetch(`http://127.0.0.1:${other.port}/_app/page.old.js`);
			expect(r.status).toBe(404);
		} finally {
			await other.close();
		}
	});
});
