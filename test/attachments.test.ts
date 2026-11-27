import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { runGit } from "../src/git-write.ts";
import { acpPrompt } from "../src/harnesses/acp-prompt.ts";
import { StaticIdentity } from "../src/http/identity.ts";
import type {
	AttachmentManifest,
	AttachmentUpload,
	FileSearch,
} from "../src/http/wire.ts";
import {
	ATTACH_LIMITS,
	Attachments,
	parseManifest,
	safeName,
} from "../src/service/attachments.ts";
import { Files, MAX_PATHS, rankFiles } from "../src/service/files.ts";
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

test("image references survive retries and a reopened store, bound to the signed upload", async () => {
	const upload = await open({
		nonce: nonce(),
		files: [spec("pixel.png", PNG, "image/png")],
	});
	await service.attachments.write(
		OWNER,
		agentId,
		upload.upload,
		0,
		0,
		PNG.subarray(0, 2),
	);
	const done = await service.attachments.write(
		OWNER,
		agentId,
		upload.upload,
		0,
		2,
		PNG.subarray(2),
	);
	const ref = done.file!.imageRef!;
	expect(ref).toMatch(/^[A-Za-z0-9_-]{24}$/);
	expect(
		(await service.attachments.write(OWNER, agentId, upload.upload, 0, 0, PNG))
			.file?.imageRef,
	).toBe(ref);
	const reopened = new Store(join(dir, "pulsar.db"));
	try {
		const images = reopened.uploadedImages([ref], OWNER, agentId)!;
		expect(await acpPrompt("pixel", images)).toEqual([
			{ type: "text", text: "pixel" },
			{ type: "image", mimeType: "image/png", data: PNG.toString("base64") },
		]);
		await expect(
			acpPrompt("pixel", [{ ...images[0]!, expiresAt: 0 }]),
		).rejects.toThrow("expired");
		expect(reopened.uploadedImages([ref], OWNER, "other")).toBeNull();
		expect(reopened.uploadedImages([ref], "other", agentId)).toBeNull();
		expect(
			reopened.uploadedImages(
				[ref],
				OWNER,
				agentId,
				Date.now() + ATTACH_LIMITS.keepMs + 1,
			),
		).toBeNull();
		expect(
			reopened.uploadedImages(["A".repeat(24)], OWNER, agentId),
		).toBeNull();
		await expect(
			service.app.send(USER, {
				ids: [agentId],
				body: "image",
				imageRefs: ["A".repeat(24)],
			}),
		).rejects.toThrow("Attach it again");
		const text = `Attached: ${images[0]!.path} (image/png, 208 B)`;
		expect(await acpPrompt(text)).toEqual([{ type: "text", text }]);
		writeFileSync(images[0]!.path, Buffer.alloc(PNG.length, 0));
		await expect(acpPrompt("pixel", images)).rejects.toThrow("changed");
		rmSync(images[0]!.path);
		await expect(acpPrompt("pixel", images)).rejects.toThrow("unavailable");
	} finally {
		reopened.close();
	}
});

test("failed verification, persistence, and rename can retry from zero", async () => {
	let fail = true;
	const attachments = new Attachments({
		dir: () => attachDir,
		isLocal: () => true,
		rememberImage() {
			if (fail) throw Error("unable to remember");
		},
	});
	const text = Buffer.alloc(PNG.length, 65);
	const first = (await attachments.handler({
		user: VERIFIED,
		agent: agentId,
		params: { nonce: nonce(), files: [spec("first", text)] },
	} as Parameters<typeof attachments.handler>[0])) as AttachmentUpload;
	await expect(
		attachments.write(OWNER, agentId, first.upload, 0, 0, PNG),
	).rejects.toThrow("changed in transit");
	const file = (
		await attachments.write(OWNER, agentId, first.upload, 0, 0, text)
	).file!;
	expect(file.imageRef).toBeUndefined();
	expect(file.type).toBe("application/octet-stream");
	const second = (await attachments.handler({
		user: VERIFIED,
		agent: agentId,
		params: { nonce: nonce(), files: [spec("second", PNG)] },
	} as Parameters<typeof attachments.handler>[0])) as AttachmentUpload;
	await expect(
		attachments.write(OWNER, agentId, second.upload, 0, 0, PNG),
	).rejects.toThrow("unable to remember");
	fail = false;
	expect(
		(await attachments.write(OWNER, agentId, second.upload, 0, 0, PNG)).file
			?.imageRef,
	).toMatch(/^[\w-]{24}$/);
	const third = (await attachments.handler({
		user: VERIFIED,
		agent: agentId,
		params: { nonce: nonce(), files: [spec("rename", PNG)] },
	} as Parameters<typeof attachments.handler>[0])) as AttachmentUpload;
	await attachments.write(
		OWNER,
		agentId,
		third.upload,
		0,
		0,
		PNG.subarray(0, 2),
	);
	const folder = join(
		attachDir,
		readdirSync(attachDir).find((d) =>
			readdirSync(join(attachDir, d)).some((n) => n.endsWith("-rename.part")),
		)!,
	);
	const part = readdirSync(folder).find((n) => n.endsWith("-rename.part"))!;
	const blocker = join(folder, part.slice(0, -5));
	mkdirSync(blocker);
	await expect(
		attachments.write(OWNER, agentId, third.upload, 0, 2, PNG.subarray(2)),
	).rejects.toThrow();
	rmSync(blocker, { recursive: true });
	expect(
		(await attachments.write(OWNER, agentId, third.upload, 0, 0, PNG)).file
			?.imageRef,
	).toMatch(/^[\w-]{24}$/);
});

test("queue edits may keep or remove only originally attached images", async () => {
	const refs = ["a".repeat(24), "b".repeat(24)];
	const lines = refs.map(
		(id) => `Attached: /work/up_${id}-pic.png (image/png, 70 B)`,
	);
	const sent = await service.app.send(USER, {
		ids: [agentId],
		body: "queue fixture",
		priority: "fyi",
	});
	if (sent.dryRun) throw Error("expected message");
	const message = {
		...sent.message,
		id: "edited-uploads-fixture",
		body: ["caption", ...lines].join("\n"),
		imageRefs: refs,
	};
	store.addMessage(message);
	store.setMessageBody(message.id, ["new caption", ...lines].join("\n"));
	expect(store.getMessage(message.id)?.imageRefs).toEqual(refs);
	store.setMessageBody(message.id, ["new caption", lines[1]].join("\n"));
	expect(store.getMessage(message.id)?.imageRefs).toEqual([refs[1]!]);
	store.setMessageBody(message.id, ["new caption", ...lines].join("\n"));
	expect(store.getMessage(message.id)?.imageRefs).toEqual([refs[1]!]);
	store.setMessageBody(message.id, "caption only");
	expect(store.getMessage(message.id)?.imageRefs).toBeUndefined();
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
		// A retry whose answer was lost gets the saved file, not an error.
		expect(
			(await w.write(OWNER, agentId, up.upload, 0, 0, data)).file!.path,
		).toBe(ok.file!.path);
		// Only a write past its start is refused.
		expect(await code(w.write(OWNER, agentId, up.upload, 0, 3, data))).toBe(
			"bad_request",
		);
		// No partial files left behind.
		expect(
			readdirSync(join(ok.file!.path, "..")).filter((n) => n.endsWith(".part")),
		).toEqual([]);
	});

	test("a local write in pieces continues at the returned offset", async () => {
		const data = Buffer.from("0123456789abcdefghij");
		const up = await open({ nonce: nonce(), files: [spec("parts.txt", data)] });
		let at = 0;
		let saved = null as Awaited<
			ReturnType<typeof service.attachments.write>
		>["file"];
		for (const n of [7, 7, 6]) {
			const r = await service.attachments.write(
				OWNER,
				agentId,
				up.upload,
				0,
				at,
				data.subarray(at, at + n),
			);
			at = r.received;
			saved = r.file;
		}
		expect(at).toBe(20);
		expect(readFileSync(saved!.path, "utf8")).toBe(data.toString());
		// Through receive(): a stream of pieces, written as they come.
		const up2 = await open({ nonce: nonce(), files: [spec("s.txt", data)] });
		const r = await service.attachments.receive(
			USER,
			agentId,
			up2.upload,
			0,
			new ReadableStream({
				start(c) {
					for (let i = 0; i < data.length; i += 3)
						c.enqueue(data.subarray(i, i + 3));
					c.close();
				},
			}),
		);
		expect(readFileSync(r.file.path, "utf8")).toBe(data.toString());
	});

	test("an upload expires: gone, and no partial file left", async () => {
		let t = 1_000_000;
		const dirX = join(dir, "expiry");
		const att = new Attachments({
			dir: () => dirX,
			isLocal: () => true,
			now: () => t,
		});
		const data = Buffer.from("abcdef");
		const up = (await att.handler({
			user: VERIFIED,
			agent: "pi:x",
			params: { nonce: nonce(), files: [spec("e.txt", data)] },
		})) as AttachmentUpload;
		await att.write(OWNER, "pi:x", up.upload, 0, 0, data.subarray(0, 3));
		t += ATTACH_LIMITS.uploadMs + 1;
		expect(
			await code(att.write(OWNER, "pi:x", up.upload, 0, 3, data.subarray(3))),
		).toBe("gone");
		expect(
			readdirSync(join(dirX, "pi_x")).filter((n) => n.endsWith(".part")),
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

	test("a short body: the upload ended before the whole file arrived", async () => {
		const data = Buffer.from("the whole file");
		const up = await open({ nonce: nonce(), files: [spec("short.txt", data)] });
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/attachments/${up.upload}/0`,
			{ method: "PUT", body: data.subarray(0, 5) },
		);
		expect(res.status).toBe(400);
		expect(
			((await res.json()) as { error: { message: string } }).error.message,
		).toBe("the upload ended before the whole file arrived");
	});

	test("a PUT repeated after its answer was lost answers the saved file", async () => {
		const data = Buffer.from("saved once");
		const up = await open({ nonce: nonce(), files: [spec("twice.txt", data)] });
		const put = () =>
			api(`/agents/${encodeURIComponent(agentId)}/attachments/${up.upload}/0`, {
				method: "PUT",
				body: data,
			});
		const a = (await (await put()).json()) as { file: { path: string } };
		const res = await put();
		expect(res.status).toBe(200);
		expect(((await res.json()) as { file: { path: string } }).file.path).toBe(
			a.file.path,
		);
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
		// Nothing through a link out, and not the link itself.
		expect(paths.some((p) => p.startsWith("out/"))).toBe(false);
		expect(paths).not.toContain("out");
	});

	test("a link to a file outside the folder is not listed", async () => {
		const outside = tmpFolder();
		writeFileSync(join(outside, "id_rsa"), "secret");
		symlinkSync(join(outside, "id_rsa"), join(repo, "key"));
		symlinkSync(join(repo, "a.txt"), join(repo, "inside-link"));
		g(repo, "add", "-A");
		const files = new Files(
			(id) => service.registry.get(id),
			() => Date.now(),
		);
		const paths = (await files.search(agentId, "")).items.map((h) => h.path);
		expect(paths).not.toContain("key");
		// A link that stays inside is fine.
		expect(paths).toContain("inside-link");
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

	test("git that times out is unavailable, not 'no repository'; a cut list says so", async () => {
		const fail = (async (_cwd: string) => ({
			ok: false,
			code: "timeout",
			message: "git took longer than 10 s and was stopped",
			exitCode: null,
			stdout: "",
			stderr: "",
		})) as unknown as typeof runGit;
		const slow = new Files((id) => service.registry.get(id), Date.now, fail);
		expect(await slow.search(agentId, "")).toMatchObject({
			available: false,
			reason: "unavailable",
		});
		const many = (async (cwd: string) => ({
			ok: true,
			stdout: Array.from({ length: MAX_PATHS + 5 }, (_, i) => `f${i}.txt`).join(
				"\0",
			),
			stderr: "",
			root: realpathSync(cwd),
		})) as unknown as typeof runGit;
		const big = new Files((id) => service.registry.get(id), Date.now, many);
		const r = await big.search(agentId, "f1");
		expect(r.available).toBe(true);
		expect(r.truncated).toBe(true);
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
