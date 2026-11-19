import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
	appendFileSync,
	mkdirSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	cachedSummaries,
	clearChangesCache,
	insideRepo,
	MAX_DIFF_BYTES,
	newFilePatch,
	parseNameStatus,
	parseNumstat,
	parseStatus,
	readChanges,
	readFileDiff,
} from "../src/changes/read.ts";
import { cleanupRepos, g, gitRepo, tmpFolder } from "./git-repo.ts";

const tmp = tmpFolder;
const repo = gitRepo;
afterAll(cleanupRepos);

/** A later mtime, so an edit within the same second still counts. */
function touchLater(path: string, s = 5) {
	const t = new Date(Date.now() + s * 1000);
	utimesSync(path, t, t);
}

beforeEach(() => clearChangesCache());

describe("parsers", () => {
	test("porcelain v2 with branch headers, renames and untracked", () => {
		const out = [
			"# branch.oid abc",
			"# branch.head feature x",
			"# branch.upstream origin/feature",
			"# branch.ab +2 -1",
			"1 .M N... 100644 100644 100644 h1 h2 dir/a file.txt",
			"2 R. N... 100644 100644 100644 h1 h2 R100 new name.txt",
			"old name.txt",
			"u UU N... 100644 100644 100644 100644 h1 h2 h3 conflict.txt",
			"? new\nline.txt",
			"",
		].join("\u0000");
		const s = parseStatus(out);
		expect(s.head).toBe("feature x");
		expect(s.upstream).toBe("origin/feature");
		expect([s.ahead, s.behind]).toEqual([2, 1]);
		expect(s.entries.map((e) => [e.kind, e.path, e.oldPath])).toEqual([
			["changed", "dir/a file.txt", undefined],
			["renamed", "new name.txt", "old name.txt"],
			["unmerged", "conflict.txt", undefined],
			["untracked", "new\nline.txt", undefined],
		]);
	});

	test("name-status and numstat with renames", () => {
		expect(
			parseNameStatus("M\u0000a.txt\u0000R090\u0000old\u0000new x\u0000"),
		).toEqual([
			{ status: "modified", path: "a.txt" },
			{ status: "renamed", path: "new x", oldPath: "old" },
		]);
		expect(
			parseNumstat(
				"1\t2\ta.txt\u0000-\t-\tb.bin\u00003\t0\t\u0000old\u0000new\u0000",
			),
		).toEqual([
			{ path: "a.txt", added: 1, removed: 2, binary: false },
			{ path: "b.bin", added: null, removed: null, binary: true },
			{ path: "new", added: 3, removed: 0, binary: false },
		]);
	});

	test("a new file's patch, with and without a final newline", () => {
		expect(newFilePatch("x", "a\nb\n", "100644")).toBe(
			"diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1,2 @@\n+a\n+b\n",
		);
		expect(newFilePatch("x", "a", "100644")).toContain(
			"@@ -0,0 +1 @@\n+a\n\\ No newline at end of file\n",
		);
		expect(newFilePatch("x", "", "100644")).toBe(
			"diff --git a/x b/x\nnew file mode 100644\n",
		);
	});
});

describe("readChanges", () => {
	test("modified, staged, untracked, deleted, renamed, binary; ignored hidden", async () => {
		const d = repo();
		appendFileSync(join(d, "a.txt"), "four\n");
		writeFileSync(join(d, "staged.txt"), "s\n");
		g(d, "add", "staged.txt");
		rmSync(join(d, "gone.txt"));
		g(d, "mv", "old name.txt", "new name.txt");
		writeFileSync(join(d, "bin.dat"), Buffer.from([0, 9, 9, 9, 9]));
		mkdirSync(join(d, "sub dir"));
		writeFileSync(join(d, "sub dir", "ünï.txt"), "x\ny\n");
		writeFileSync(join(d, "secret.env"), "TOKEN=1\n");
		mkdirSync(join(d, "ignored"));
		writeFileSync(join(d, "ignored", "x.txt"), "no\n");

		const { summary } = await readChanges(d, "worktree", "user");
		expect(summary.available).toBe(true);
		expect(summary.branch).toBe("main");
		expect(summary.head).toMatch(/^[0-9a-f]{12}$/);
		const by = new Map(summary.files.map((f) => [f.path, f]));
		expect([...by.keys()].sort()).toEqual(
			[
				"a.txt",
				"bin.dat",
				"gone.txt",
				"new name.txt",
				"staged.txt",
				"sub dir/ünï.txt",
			].sort(),
		);
		expect(by.get("a.txt")).toMatchObject({
			status: "modified",
			added: 1,
			removed: 0,
			staged: false,
			unstaged: true,
		});
		expect(by.get("staged.txt")).toMatchObject({
			status: "added",
			staged: true,
			unstaged: false,
		});
		expect(by.get("gone.txt")).toMatchObject({ status: "deleted", removed: 1 });
		expect(by.get("new name.txt")).toMatchObject({
			status: "renamed",
			oldPath: "old name.txt",
			staged: true,
		});
		expect(by.get("bin.dat")).toMatchObject({ binary: true, added: null });
		expect(by.get("sub dir/ünï.txt")).toMatchObject({
			status: "untracked",
			added: 2,
		});
		expect(summary.added).toBeGreaterThanOrEqual(4);
		// Ignored files never show, neither in the list nor as a diff.
		expect(await readFileDiff(d, "worktree", "secret.env", "user")).toBeNull();
		expect(
			await readFileDiff(d, "worktree", "ignored/x.txt", "user"),
		).toBeNull();

		const a = await readFileDiff(d, "worktree", "a.txt", "user");
		expect(a?.patch).toContain("+four");
		expect(a?.patch).toContain("diff --git a/a.txt b/a.txt");
		const u = await readFileDiff(d, "worktree", "sub dir/ünï.txt", "user");
		expect(u?.patch).toContain("+++ b/sub dir/ünï.txt");
		expect(u?.patch).toContain("+y");
		const r = await readFileDiff(d, "worktree", "new name.txt", "user");
		expect(r?.patch).toContain("rename from old name.txt");
		const b = await readFileDiff(d, "worktree", "bin.dat", "user");
		expect(b).toMatchObject({ binary: true, patch: null });
		const gone = await readFileDiff(d, "worktree", "gone.txt", "user");
		expect(gone?.patch).toContain("-bye");
	});

	test("editing an already-modified file again changes the stamp and key", async () => {
		const d = repo();
		appendFileSync(join(d, "a.txt"), "four\n");
		const first = (await readChanges(d, "worktree", "background")).summary;
		const same = (await readChanges(d, "worktree", "background")).summary;
		expect(same.stamp).toBe(first.stamp);
		appendFileSync(join(d, "a.txt"), "five\n");
		touchLater(join(d, "a.txt"));
		const next = (await readChanges(d, "worktree", "background")).summary;
		expect(next.stamp).not.toBe(first.stamp);
		expect(next.files[0]!.key).not.toBe(first.files[0]!.key);
		expect(next.files[0]!.added).toBe(2);
	});

	test("a file over the cap is too large; untracked binaries are binary", async () => {
		const d = repo();
		writeFileSync(join(d, "a.txt"), "x".repeat(MAX_DIFF_BYTES + 10));
		writeFileSync(join(d, "huge-new.txt"), "y\n".repeat(MAX_DIFF_BYTES));
		writeFileSync(join(d, "new.bin"), Buffer.from([1, 0, 2]));
		await readChanges(d, "worktree", "user");
		expect(await readFileDiff(d, "worktree", "a.txt", "user")).toMatchObject({
			tooLarge: true,
			patch: null,
		});
		expect(
			await readFileDiff(d, "worktree", "huge-new.txt", "user"),
		).toMatchObject({ tooLarge: true, patch: null });
		expect(await readFileDiff(d, "worktree", "new.bin", "user")).toMatchObject({
			binary: true,
			patch: null,
		});
	});

	test("an untracked symlink shows its target and is never followed", async () => {
		const d = repo();
		const outside = tmp();
		writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
		symlinkSync(join(outside, "secret.txt"), join(d, "link.txt"));
		// A linked folder: git lists the link itself, not what is inside.
		symlinkSync(outside, join(d, "linkdir"));
		const { summary } = await readChanges(d, "worktree", "user");
		const paths = summary.files.map((f) => f.path);
		expect(paths).toContain("link.txt");
		expect(paths).not.toContain("linkdir/secret.txt");
		const link = await readFileDiff(d, "worktree", "link.txt", "user");
		expect(link?.patch).toContain("new file mode 120000");
		expect(link?.patch).toContain(`+${join(outside, "secret.txt")}`);
		expect(link?.patch).not.toContain("TOP SECRET");
		// Paths outside the repo or through a link never resolve.
		expect(await insideRepo(d, "../x")).toBeNull();
		expect(await insideRepo(d, "/etc/passwd")).toBeNull();
		expect(await insideRepo(d, "linkdir/secret.txt")).toBeNull();
		expect(await readFileDiff(d, "worktree", "../x", "user")).toBeNull();
		expect(
			await readFileDiff(d, "worktree", "linkdir/secret.txt", "user"),
		).toBeNull();
	});

	test("not a repo, a missing folder, detached HEAD, no commits", async () => {
		const plain = tmp();
		expect(
			(await readChanges(plain, "worktree", "user")).summary,
		).toMatchObject({ available: false, reason: "not_a_repo" });
		expect(
			(await readChanges(join(plain, "nope"), "worktree", "user")).summary
				.available,
		).toBe(false);

		const d = repo();
		const sha = g(d, "rev-parse", "HEAD").trim();
		g(d, "checkout", "-q", "--detach", sha);
		appendFileSync(join(d, "a.txt"), "x\n");
		const det = (await readChanges(d, "worktree", "user")).summary;
		expect(det.branch).toBeNull();
		expect(det.head).toBe(sha.slice(0, 12));
		expect(det.files.map((f) => f.path)).toEqual(["a.txt"]);

		const empty = tmp();
		g(empty, "init", "-q");
		writeFileSync(join(empty, "first.txt"), "hello\n");
		writeFileSync(join(empty, "staged.txt"), "s\n");
		g(empty, "add", "staged.txt");
		const fresh = (await readChanges(empty, "worktree", "user")).summary;
		expect(fresh.available).toBe(true);
		expect(fresh.head).toBeNull();
		expect(fresh.files.map((f) => [f.path, f.status])).toEqual([
			["first.txt", "untracked"],
			["staged.txt", "added"],
		]);
		const staged = await readFileDiff(empty, "worktree", "staged.txt", "user");
		expect(staged?.patch).toContain("+s");
	});

	test("a subfolder cwd reports the whole worktree", async () => {
		const d = repo();
		mkdirSync(join(d, "deep"));
		writeFileSync(join(d, "deep", "n.txt"), "n\n");
		appendFileSync(join(d, "a.txt"), "x\n");
		const s = (await readChanges(join(d, "deep"), "worktree", "user")).summary;
		expect(s.files.map((f) => f.path).sort()).toEqual(["a.txt", "deep/n.txt"]);
		const a = await readFileDiff(join(d, "deep"), "worktree", "a.txt", "user");
		expect(a?.patch).toContain("+x");
	});

	test("base mode: committed on the branch plus dirty, ahead of main", async () => {
		const d = repo();
		g(d, "checkout", "-q", "-b", "feature");
		writeFileSync(join(d, "feat.txt"), "f\n");
		g(d, "add", "feat.txt");
		g(d, "commit", "-q", "-m", "feat");
		appendFileSync(join(d, "a.txt"), "dirty\n");
		const wt = (await readChanges(d, "worktree", "user")).summary;
		expect(wt.files.map((f) => f.path)).toEqual(["a.txt"]);
		expect(wt.base).toMatchObject({ ref: "main", ahead: 1, behind: 0 });
		const base = (await readChanges(d, "base", "user")).summary;
		expect(base.mode).toBe("base");
		expect(base.files.map((f) => f.path).sort()).toEqual(["a.txt", "feat.txt"]);
		const feat = await readFileDiff(d, "base", "feat.txt", "user");
		expect(feat?.patch).toContain("+f");

		// No default branch anywhere: base mode says so.
		const lone = tmp();
		g(lone, "init", "-q", "-b", "trunk");
		writeFileSync(join(lone, "x"), "x\n");
		g(lone, "add", "x");
		g(lone, "commit", "-q", "-m", "x");
		expect((await readChanges(lone, "base", "user")).summary).toMatchObject({
			available: false,
			reason: "no_base",
			branch: "trunk",
		});
	});

	test("the file list is capped; the rest are counted", async () => {
		const d = repo();
		mkdirSync(join(d, "many"));
		for (let i = 0; i < 520; i++)
			writeFileSync(
				join(d, "many", `f${String(i).padStart(3, "0")}.txt`),
				"x\n",
			);
		const s = (await readChanges(d, "worktree", "user")).summary;
		expect(s.files.length).toBe(500);
		expect(s.total).toBe(520);
		expect(s.truncated).toBe(true);
		// A file past the listed 500 still has a diff.
		const last = await readFileDiff(d, "worktree", "many/f519.txt", "user");
		expect(last?.patch).toContain("+x");
		expect(cachedSummaries()).toBeGreaterThan(0);
	});

	test("never takes the index lock (GIT_OPTIONAL_LOCKS=0)", async () => {
		const d = repo();
		appendFileSync(join(d, "a.txt"), "x\n");
		// Another process holds the lock: status still answers.
		writeFileSync(join(d, ".git", "index.lock"), "");
		const s = (await readChanges(d, "worktree", "user")).summary;
		expect(s.available).toBe(true);
		expect(s.files.map((f) => f.path)).toEqual(["a.txt"]);
	});
});

describe("remote changes", () => {
	test("an older home node (no changes ops) reads as unsupported", async () => {
		const { RemoteChangesReader } = await import(
			"../src/federation/changes.ts"
		);
		const { RpcError } = await import("../src/rpc.ts");
		const fed = {
			act: async () => {
				throw new RpcError("unsupported", "unknown action changes.summary");
			},
		};
		const r = new RemoteChangesReader(fed as never);
		expect(await r.summary("m1/pi:x", "worktree")).toMatchObject({
			agent: "m1/pi:x",
			available: false,
			reason: "unsupported",
		});
		r.close();
	});
});
