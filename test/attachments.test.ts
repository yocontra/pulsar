import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticIdentity } from "../src/http/identity.ts";
import type {
	AttachmentManifest,
	AttachmentUpload,
	FileSearch,
} from "../src/http/wire.ts";
import {
	ATTACH_LIMITS,
	parseManifest,
	safeName,
} from "../src/service/attachments.ts";
import { rankFiles } from "../src/service/files.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { cleanupRepos, g, gitRepo, tmpFolder } from "./git-repo.ts";

/**
 * Attachments (src/service/attachments.ts) and the `@` file list
 * (src/service/files.ts) on one node: limits, sniffing, hashes, 0600 files,
 * GC, the streaming route's own body limit, and git ls-files path safety.
 */

const OWNER = "me@example.com";
const USER = { kind: "human" as const, login: OWNER, node: "phone" };
const VERIFIED = { ...USER, verified: true as const };

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(200, 7),
]);
const nonce = () => `n${Math.random().toString(36).slice(2)}0000000000000000`;
const spec = (name: string, data: Uint8Array, type = "") => ({
	name,
	type,
	size: data.length,
	sha256: sha(data),
});

let dir: string;
let attachDir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
let agentId: string;
let repo: string;

async function code(p: Promise<unknown>): Promise<string> {
	try {
		await p;
		return "ok";
	} catch (e) {
		return (e as { code?: string }).code ?? (e as Error).message;
	}
}

function open(manifest: AttachmentManifest, agent = agentId) {
	return service.acting.run(
		VERIFIED,
		"attachments.upload",
		{ agent },
		manifest,
	) as Promise<AttachmentUpload>;
}

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${base}/api/v1${path}`, {
		...init,
		headers: { "X-Pulsar": "1", ...(init.headers ?? {}) },
	});

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-attach-"));
	attachDir = join(dir, "attachments");
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({
		store,
		scan: false,
		machine: "studio",
		attachments: { dir: () => attachDir },
	});
	http = new HttpTransport(service, {
		identity: new StaticIdentity(OWNER, "phone"),
		owner: OWNER,
		hosts: ["127.0.0.1"],
		port: 0,
		webRoot: null,
		hub: { coalesceMs: 60_000 },
	});
	await http.listen();
	base = `http://127.0.0.1:${http.port}`;
	repo = gitRepo();
	agentId = service.registry.upsert({
		harness: "pi",
		sessionId: "s-attach",
		pid: null,
		cwd: repo,
		project: "demo",
		branch: "main",
		tags: [],
		meta: {},
		registered: false,
	}).id;
});

afterAll(async () => {
	service.stop();
	await http.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	cleanupRepos();
});

describe("manifest", () => {
	test("limits: count, empty, size per kind, hash", () => {
		const one = spec("a.txt", Buffer.from("hi"));
		const many = Array.from({ length: 11 }, () => one);
		expect(() => parseManifest({ nonce: nonce(), files: many })).toThrow(
			"up to 10 files",
		);
		expect(() =>
			parseManifest({ nonce: nonce(), files: [{ ...one, size: 0 }] }),
		).toThrow("is empty");
		expect(() =>
			parseManifest({
				nonce: nonce(),
				files: [
					{ ...one, type: "image/png", size: ATTACH_LIMITS.imageBytes + 1 },
				],
			}),
		).toThrow("too large");
		// Not an image: up to 25 MB.
		parseManifest({
			nonce: nonce(),
			files: [{ ...one, size: ATTACH_LIMITS.imageBytes + 1 }],
		});
		expect(() =>
			parseManifest({
				nonce: nonce(),
				files: [{ ...one, size: ATTACH_LIMITS.fileBytes + 1 }],
			}),
		).toThrow("too large");
		expect(() =>
			parseManifest({ nonce: nonce(), files: [{ ...one, sha256: "x" }] }),
		).toThrow("sha256");
		expect(() => parseManifest({ nonce: "short", files: [one] })).toThrow(
			"nonce",
		);
	});

	test("safe names: no folders, control or shell characters", () => {
		expect(safeName("../../etc/passwd")).toBe("passwd");
		expect(safeName("..\\x\\.ssh")).toBe("ssh");
		expect(safeName("a\u0000b`$(rm).png")).toBe("ab__(rm).png");
		expect(safeName("...")).toBe("file");
		expect(safeName(`${"x".repeat(300)}.png`)).toMatch(/^x+\.png$/);
		expect(safeName(`${"x".repeat(300)}.png`).length).toBe(
			ATTACH_LIMITS.nameChars,
		);
	});
});

describe("uploads on this node", () => {
	test("needs a passkey session", async () => {
		const data = Buffer.from("hello");
		expect(
			await code(
				service.acting.run(
					USER,
					"attachments.upload",
					{ agent: agentId },
					{ nonce: nonce(), files: [spec("a.txt", data)] },
				),
			),
		).toBe("session_required");
	});

	test("saves 0600 files in 0700 folders; images sniffed", async () => {
		const text = Buffer.from("notes\n");
		const up = await open({
			nonce: nonce(),
			files: [spec("notes.txt", text, "text/plain"), spec("shot", PNG)],
		});
		expect(up.files.map((f) => f.name)).toEqual(["notes.txt", "shot"]);
		const a = await service.attachments.write(
			OWNER,
			agentId,
			up.upload,
			0,
			0,
			text,
		);
		expect(a.file).toMatchObject({
			name: "notes.txt",
			type: "text/plain",
			size: 6,
		});
		// In two chunks.
		const half = await service.attachments.write(
			OWNER,
			agentId,
			up.upload,
			1,
			0,
			PNG.subarray(0, 100),
		);
		expect(half).toEqual({ received: 100, file: null });
		const b = await service.attachments.write(
			OWNER,
			agentId,
			up.upload,
			1,
			100,
			PNG.subarray(100),
		);
		expect(b.file!.type).toBe("image/png");
		expect(readFileSync(b.file!.path)).toEqual(PNG);
		expect(b.file!.path.startsWith(attachDir)).toBe(true);
		expect(statSync(b.file!.path).mode & 0o777).toBe(0o600);
		expect(statSync(join(b.file!.path, "..")).mode & 0o777).toBe(0o700);
		// The audit row names the op.
		const row = store.db
			.prepare(
				"SELECT ok FROM audit WHERE op = 'attachments.upload' ORDER BY id DESC",
			)
			.get() as { ok: number };
		expect(row.ok).toBe(1);
	});

	test("a claimed image that isn't one is not reported as an image", async () => {
		const data = Buffer.from("not really a png");
		const up = await open({
			nonce: nonce(),
			files: [spec("x.png", data, "image/png")],
		});
		const r = await service.attachments.write(
			OWNER,
			agentId,
			up.upload,
			0,
			0,
			data,
		);
		expect(r.file!.type).toBe("application/octet-stream");
	});

	test("an image over 10 MB declared as a file is refused once sniffed", async () => {
		const size = ATTACH_LIMITS.imageBytes + 10;
		const up = await open({
			nonce: nonce(),
			files: [{ name: "big.bin", type: "", size, sha256: "0".repeat(64) }],
		});
		expect(
			await code(
				service.attachments.write(OWNER, agentId, up.upload, 0, 0, PNG),
			),
		).toBe("too_large");
	});

	test("wrong hash, offset, login, agent, extra bytes", async () => {
		const data = Buffer.from("abcdef");
		const up = await open({ nonce: nonce(), files: [spec("a.txt", data)] });
		const w = service.attachments;
		expect(await code(w.write("other@x", agentId, up.upload, 0, 0, data))).toBe(
			"not_found",
		);
		expect(await code(w.write(OWNER, "pi:other", up.upload, 0, 0, data))).toBe(
			"not_found",
		);
		expect(await code(w.write(OWNER, agentId, up.upload, 0, 3, data))).toBe(
			"bad_request",
		);
		expect(
			await code(
				w.write(OWNER, agentId, up.upload, 0, 0, Buffer.from("abcdefg")),
			),
		).toBe("too_large");
		await expect(
			w.write(OWNER, agentId, up.upload, 0, 0, Buffer.from("abcdeX")),
		).rejects.toThrow("changed in transit");
		// Starting over at 0 works after a failure.
		const ok = await w.write(OWNER, agentId, up.upload, 0, 0, data);
		expect(ok.file!.size).toBe(6);
		// A finished upload is gone.
		expect(await code(w.write(OWNER, agentId, up.upload, 0, 0, data))).toBe(
			"not_found",
		);
		// No partial files left behind.
		expect(
			readdirSync(join(ok.file!.path, "..")).filter((n) => n.endsWith(".part")),
		).toEqual([]);
	});

	test("GC removes files older than a week", async () => {
		const data = Buffer.from("old");
		const up = await open({ nonce: nonce(), files: [spec("old.txt", data)] });
		const r = await service.attachments.write(
			OWNER,
			agentId,
			up.upload,
			0,
			0,
			data,
		);
		const keep = await open({ nonce: nonce(), files: [spec("new.txt", data)] });
		const k = await service.attachments.write(
			OWNER,
			agentId,
			keep.upload,
			0,
			0,
			data,
		);
		const old = (Date.now() - ATTACH_LIMITS.keepMs - 60_000) / 1000;
		utimesSync(r.file!.path, old, old);
		expect(await service.attachments.gc()).toBeGreaterThanOrEqual(1);
		expect(() => statSync(r.file!.path)).toThrow();
		expect(statSync(k.file!.path).isFile()).toBe(true);
	});
});

describe("HTTP", () => {
	test("PUT streams past the 2 MB JSON limit; JSON bodies keep it", async () => {
		const data = Buffer.alloc(3 * 1024 * 1024, 1);
		const up = await open({ nonce: nonce(), files: [spec("big.bin", data)] });
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/attachments/${up.upload}/0`,
			{ method: "PUT", body: data },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { file: { path: string; size: number } };
		expect(body.file.size).toBe(data.length);
		expect(sha(readFileSync(body.file.path))).toBe(sha(data));
		const big = await api("/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ body: "x".repeat(3 * 1024 * 1024) }),
		});
		expect(big.status).toBe(413);
	});

	test("PUT over 25 MB is refused by its length", async () => {
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/attachments/nope/0`,
			{
				method: "PUT",
				body: Buffer.alloc(ATTACH_LIMITS.fileBytes + 1),
			},
		);
		expect(res.status).toBe(413);
	});

	test("the manifest route needs a passkey session", async () => {
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/attachments`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					manifest: { nonce: nonce(), files: [spec("a", Buffer.from("a"))] },
				}),
			},
		);
		expect(res.status).toBe(401);
	});
});

describe("@ files", () => {
	test("tracked and untracked files and folders, never ignored ones", async () => {
		mkdirSync(join(repo, "src", "deep"), { recursive: true });
		writeFileSync(join(repo, "src", "deep", "Composer.tsx"), "x");
		writeFileSync(join(repo, "secret.env"), "x");
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/files?q=compo`,
		);
		const r = (await res.json()) as FileSearch;
		expect(r.available).toBe(true);
		expect(r.items[0]).toEqual({ path: "src/deep/Composer.tsx", kind: "file" });
		const all = (await service.files.search(agentId, "")).items.map(
			(h) => h.path,
		);
		expect(all).toContain("a.txt");
		expect(all).toContain("src");
		expect(all).not.toContain("secret.env");
	});

	test("an agent in a subfolder sees paths relative to it; links out are dropped", async () => {
		const outside = tmpFolder();
		writeFileSync(join(outside, "x.txt"), "x");
		mkdirSync(join(repo, "pkg"), { recursive: true });
		writeFileSync(join(repo, "pkg", "inner.ts"), "x");
		symlinkSync(outside, join(repo, "pkg", "out"));
		g(repo, "add", "-A");
		const sub = service.registry.upsert({
			harness: "pi",
			sessionId: "s-sub",
			pid: null,
			cwd: join(repo, "pkg"),
			project: "demo",
			branch: "main",
			tags: [],
			meta: {},
			registered: false,
		});
		const r = await service.files.search(sub.id, "");
		const paths = r.items.map((h) => h.path);
		expect(paths).toContain("inner.ts");
		expect(paths.some((p) => p.startsWith("..") || p.includes("a.txt"))).toBe(
			false,
		);
		// The link itself is listed (git tracks it); nothing through it.
		expect(paths.some((p) => p.startsWith("out/"))).toBe(false);
	});

	test("no folder, or not a repo", async () => {
		const plain = service.registry.upsert({
			harness: "pi",
			sessionId: "s-plain",
			pid: null,
			cwd: tmpFolder(),
			project: "demo",
			branch: null,
			tags: [],
			meta: {},
			registered: false,
		});
		expect(await service.files.search(plain.id, "")).toMatchObject({
			available: false,
			reason: "not_git",
		});
	});

	test("ranking: name beats folder, contiguous beats scattered", () => {
		const items = [
			{ path: "web/src/components/Composer.tsx", kind: "file" as const },
			{ path: "composer/readme.md", kind: "file" as const },
			{ path: "c/o/m/p/o/s/e/r.txt", kind: "file" as const },
			{ path: "web/composer.css", kind: "file" as const },
		];
		expect(rankFiles(items, "composer").map((h) => h.path)).toEqual([
			"web/composer.css",
			"web/src/components/Composer.tsx",
			"composer/readme.md",
			"c/o/m/p/o/s/e/r.txt",
		]);
		expect(rankFiles(items, "zzz")).toEqual([]);
	});
});
