import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaticIdentity } from "../src/http/identity.ts";
import type { FileContent, FileTree } from "../src/http/wire.ts";
import { TEXT_MAX } from "../src/service/files.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import { HttpTransport } from "../src/transport/http.ts";
import { cleanupRepos, gitRepo, tmpFolder } from "./git-repo.ts";

/**
 * The file viewer's reads (src/service/files.ts `tree`, `read`, `image`)
 * and their routes: folders as git lists them (ignored files left out,
 * ignored folders read from disk), any file in the agent's folder but
 * never in `.git` or through a link out, size caps, binary and image
 * detection, and image bytes served as inert content.
 */

const OWNER = "me@example.com";
const PNG = Buffer.concat([
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
	Buffer.alloc(64, 7),
]);

let dir: string;
let store: Store;
let service: PulsarService;
let http: HttpTransport;
let base: string;
let repo: string;
let agentId: string;

const api = (path: string) =>
	fetch(`${base}/api/v1${path}`, { headers: { "X-Pulsar": "1" } });
const agentWith = (cwd: string | null, sessionId: string) =>
	service.registry.upsert({
		harness: "pi",
		sessionId,
		pid: null,
		cwd,
		project: "demo",
		branch: "main",
		tags: [],
		meta: {},
		registered: false,
	}).id;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "pulsar-viewer-"));
	store = new Store(join(dir, "pulsar.db"));
	service = new PulsarService({ store, scan: false, machine: "studio" });
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
	mkdirSync(join(repo, "src", "deep"), { recursive: true });
	writeFileSync(join(repo, "src", "main.ts"), "export const x = 1;\n");
	writeFileSync(join(repo, "src", "deep", "util.ts"), "// util\n");
	writeFileSync(join(repo, "secret.env"), "TOKEN=1\n");
	mkdirSync(join(repo, "ignored", "qa"), { recursive: true });
	writeFileSync(join(repo, "ignored", "qa", "compare.html"), "<p>hi</p>\n");
	writeFileSync(join(repo, "shot.png"), PNG);
	writeFileSync(join(repo, "logo.svg"), "<svg><script>x</script></svg>");
	writeFileSync(join(repo, "latin1.txt"), Buffer.from([0x63, 0x61, 0xe9]));
	writeFileSync(join(repo, "big.log"), "a".repeat(TEXT_MAX + 10));
	agentId = agentWith(repo, "s-viewer");
});

afterAll(async () => {
	service.stop();
	await http.close();
	store.close();
	rmSync(dir, { recursive: true, force: true });
	cleanupRepos();
});

describe("tree", () => {
	test("the top: folders first, ignored files left out, never .git", async () => {
		const res = await api(`/agents/${encodeURIComponent(agentId)}/files/tree`);
		expect(res.status).toBe(200);
		const t = (await res.json()) as FileTree;
		expect(t.available).toBe(true);
		const names = t.entries.map((e) => e.name);
		expect(names.slice(0, 1)).toEqual(["src"]);
		expect(names).toContain("a.txt");
		expect(names).toContain("shot.png");
		expect(names).not.toContain("secret.env");
		expect(names).not.toContain("ignored");
		expect(names).not.toContain(".git");
	});

	test("a subfolder lists its direct children with full paths", async () => {
		const t = await service.files.tree(agentId, "src");
		expect(t.entries).toEqual([
			{ name: "deep", path: "src/deep", kind: "dir" },
			{ name: "main.ts", path: "src/main.ts", kind: "file" },
		]);
	});

	test("an ignored folder is read from disk", async () => {
		const t = await service.files.tree(agentId, "ignored/qa");
		expect(t.available).toBe(true);
		expect(t.entries).toEqual([
			{ name: "compare.html", path: "ignored/qa/compare.html", kind: "file" },
		]);
	});

	test("bad paths, .git and links out are refused", async () => {
		for (const p of ["../", "/etc", "src/../..", ".git", "src/./deep"])
			expect(await service.files.tree(agentId, p)).toMatchObject({
				available: false,
				reason: "not_found",
			});
		const outside = tmpFolder();
		writeFileSync(join(outside, "id_rsa"), "secret");
		symlinkSync(outside, join(repo, "ignored", "out"));
		expect(await service.files.tree(agentId, "ignored/out")).toMatchObject({
			available: false,
		});
		const t = await service.files.tree(agentId, "ignored");
		expect(t.entries.map((e) => e.name)).toEqual(["qa"]);
	});

	test("a folder outside any repo is read from disk", async () => {
		const plain = tmpFolder();
		writeFileSync(join(plain, "notes.md"), "# hi\n");
		const t = await service.files.tree(agentWith(plain, "s-plain"), "");
		expect(t.available).toBe(true);
		expect(t.entries.map((e) => e.name)).toEqual(["notes.md"]);
	});

	test("no folder", async () => {
		expect(
			await service.files.tree(agentWith(null, "s-nocwd"), ""),
		).toMatchObject({ available: false, reason: "no_cwd" });
	});
});

describe("content", () => {
	const read = async (path: string) => {
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/files/content?path=${encodeURIComponent(path)}`,
		);
		expect(res.status).toBe(200);
		return (await res.json()) as FileContent;
	};

	test("a text file, with its path from the worktree top", async () => {
		expect(await read("src/main.ts")).toEqual({
			agent: agentId,
			path: "src/main.ts",
			available: true,
			size: 20,
			repoPath: "src/main.ts",
			kind: "text",
			text: "export const x = 1;\n",
		});
	});

	test("an ignored file opens (an agent's report links to it)", async () => {
		expect(await read("ignored/qa/compare.html")).toMatchObject({
			kind: "text",
			text: "<p>hi</p>\n",
		});
	});

	test("binary, invalid UTF-8, too large, SVG as text", async () => {
		expect((await read("bin.dat")).kind).toBe("binary");
		expect((await read("latin1.txt")).kind).toBe("binary");
		const big = await read("big.log");
		expect(big.kind).toBe("text");
		expect(big.truncated).toBe(true);
		expect(big.text?.length).toBe(TEXT_MAX);
		expect((await read("logo.svg")).kind).toBe("text");
	});

	test("an image: kind on the JSON read, inert bytes with raw=1", async () => {
		expect(await read("shot.png")).toMatchObject({
			kind: "image",
			mediaType: "image/png",
		});
		const res = await api(
			`/agents/${encodeURIComponent(agentId)}/files/content?path=shot.png&raw=1`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toContain("sandbox");
		expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
		const notImage = await api(
			`/agents/${encodeURIComponent(agentId)}/files/content?path=logo.svg&raw=1`,
		);
		expect(notImage.status).toBe(415);
	});

	test(".git, folders, links out and bad paths are refused", async () => {
		expect(await read(".git/config")).toMatchObject({
			available: false,
			reason: "refused",
		});
		expect((await read("src")).reason).toBe("not_file");
		for (const p of ["../x", "/etc/passwd", "a/../../x", "nope.txt"])
			expect((await read(p)).reason).toBe("not_found");
		const outside = tmpFolder();
		writeFileSync(join(outside, "id_rsa"), "secret");
		symlinkSync(join(outside, "id_rsa"), join(repo, "key"));
		expect((await read("key")).available).toBe(false);
		symlinkSync(join(repo, ".git", "config"), join(repo, "gitcfg"));
		expect((await read("gitcfg")).reason).toBe("refused");
		symlinkSync(join(repo, "a.txt"), join(repo, "inside-link"));
		expect((await read("inside-link")).text).toBe("one\ntwo\nthree\n");
	});

	test("an agent in a subfolder: paths relative to it, repoPath from the top", async () => {
		const sub = agentWith(join(repo, "src"), "s-sub");
		expect(await service.files.read(sub, "main.ts")).toMatchObject({
			path: "main.ts",
			repoPath: "src/main.ts",
		});
		expect((await service.files.read(sub, "../a.txt")).available).toBe(false);
	});

	test("outside a repo, repoPath is null", async () => {
		const plain = tmpFolder();
		writeFileSync(join(plain, "notes.md"), "# hi\n");
		expect(
			await service.files.read(agentWith(plain, "s-plain2"), "notes.md"),
		).toMatchObject({ kind: "text", repoPath: null });
	});

	test("an unknown agent is 404; a bad query is 400", async () => {
		expect((await api("/agents/nope/files/content?path=a.txt")).status).toBe(
			404,
		);
		expect(
			(await api(`/agents/${encodeURIComponent(agentId)}/files/content`))
				.status,
		).toBe(400);
	});
});
