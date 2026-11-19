// Must come first: TanStack decides "server or browser" when it loads.
import "./window-shim.ts";
import { describe, expect, test } from "bun:test";
import { hashKey, QueryClient } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangedFile, ChangesSummary } from "../src/api/types.ts";
import { PatchView } from "../src/changes/FileDiff.tsx";
import { FileList } from "../src/changes/FileList.tsx";
import { splitPath, unavailableText } from "../src/changes/model.ts";
import { parsePatch } from "../src/changes/patch.ts";
import { keys } from "../src/data/keys.ts";
import { LiveSync } from "../src/data/live.ts";
import { deriveSubscription } from "../src/data/topics.ts";
import { hrefFor, parseHash } from "../src/lib/hash.ts";

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;
@@ -20,2 +20,3 @@ function f() {
 	return a;
+	// done
 }
\\ No newline at end of file
`;

describe("parsePatch", () => {
	test("rows index the old and new sides; hunks separate", () => {
		const p = parsePatch(PATCH);
		expect(p.hunks).toBe(2);
		expect([p.added, p.removed]).toEqual([2, 1]);
		expect(p.before.split("\n")).toEqual([
			"const a = 1;",
			"const b = 2;",
			"const c = 4;",
			"\treturn a;",
			"}",
		]);
		expect(p.after.split("\n")).toEqual([
			"const a = 1;",
			"const b = 3;",
			"const c = 4;",
			"\treturn a;",
			"\t// done",
			"}",
		]);
		const kinds = p.items.map((r) =>
			"hunk" in r ? "@" : "fold" in r ? "~" : r.sign,
		);
		expect(kinds.join("")).toBe("@ -+ @ + ");
		const plus = p.items.find(
			(r) => "sign" in r && r.sign === "+" && r.text === "\t// done",
		);
		expect(plus && "b" in plus ? plus.b : -1).toBe(4);
	});

	test("rename, mode, symlink and binary notes", () => {
		expect(
			parsePatch(
				"diff --git a/x b/y\nsimilarity index 100%\nrename from x\nrename to y\n",
			).notes,
		).toEqual(["Renamed from x"]);
		expect(
			parsePatch("diff --git a/x b/x\nold mode 100644\nnew mode 100755\n")
				.notes,
		).toEqual(["Mode 100644 → 100755"]);
		expect(
			parsePatch(
				"diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+target\n\\ No newline at end of file\n",
			),
		).toMatchObject({ notes: ["New symbolic link"], added: 1, hunks: 1 });
		expect(
			parsePatch("diff --git a/b b/b\nBinary files a/b and b/b differ\n").notes,
		).toEqual(["Binary file changed"]);
	});
});

describe("rendering", () => {
	test("PatchView renders hunk headers and add/del rows (unified and split)", () => {
		const u = renderToStaticMarkup(
			<PatchView patch={PATCH} path="src/a.ts" layout="unified" />,
		);
		expect(u).toContain('class="ds-diff-hunk"');
		expect(u).toContain("@@ -20,2 +20,3 @@ function f() {");
		expect(u.match(/ds-diff-row add/g)?.length).toBe(2);
		expect(u.match(/ds-diff-row del/g)?.length).toBe(1);
		const s = renderToStaticMarkup(
			<PatchView patch={PATCH} path="src/a.ts" layout="split" />,
		);
		expect(s).toContain("ds-diff split");
		expect(s).toContain("ds-diff-pair");
		const empty = renderToStaticMarkup(
			<PatchView
				patch={"diff --git a/e b/e\nnew file mode 100644\n"}
				path="e"
				layout="unified"
			/>,
		);
		expect(empty).toContain("Empty file");
	});

	test("FileList: status letter with a spoken label, name before folder, counts", () => {
		const f = (p: Partial<ChangedFile>): ChangedFile => ({
			path: "src/deep/a.ts",
			status: "modified",
			staged: false,
			unstaged: true,
			binary: false,
			added: 3,
			removed: 1,
			key: "k",
			...p,
		});
		const html = renderToStaticMarkup(
			<FileList
				files={[
					f({}),
					f({ path: "img.png", binary: true, added: null, removed: null }),
					f({ path: "new.txt", status: "untracked", removed: 0 }),
				]}
				selected="src/deep/a.ts"
				onSelect={() => {}}
				label="Changed files"
			/>,
		);
		expect(html).toContain('aria-label="Changed files"');
		expect(html).toContain('aria-current="true"');
		expect(html).toContain("<bdi>src/deep</bdi>");
		expect(html).toContain("3 added, 1 removed");
		expect(html).toContain(">binary<");
		expect(html).toContain("New, untracked");
		expect(splitPath("a/b/c.ts")).toEqual({ dir: "a/b/", name: "c.ts" });
		expect(
			unavailableText({ reason: "unsupported" } as ChangesSummary),
		).toContain("older pulsar");
	});
});

describe("data", () => {
	test("the newest mounted changes query gets the subscription slot", () => {
		const { sub, covered } = deriveSubscription([
			{ key: keys.changes("a1", "worktree"), seq: 1 },
			{ key: keys.changes("a2", "base"), seq: 2 },
			{ key: keys.changesPeek("a1"), seq: 3 },
		]);
		expect(sub.changes).toEqual({ agent: "a2", mode: "base" });
		expect(covered.has(hashKey(keys.changes("a2", "base")))).toBe(true);
		expect(covered.has(hashKey(keys.changes("a1", "worktree")))).toBe(false);
		// No viewer: the field is left out.
		expect("changes" in deriveSubscription([]).sub).toBe(false);
	});

	test("a changes event replaces the summary and the peek count", () => {
		const client = new QueryClient();
		const live = new LiveSync({
			client,
			transport: () => ({ close() {} }),
			subscribe: async () => {},
			frame: (fn) => fn(),
		});
		const summary = {
			agent: "a1",
			mode: "worktree",
			available: true,
			files: [],
			total: 3,
		} as unknown as ChangesSummary;
		(live as unknown as { onEvent: (e: unknown) => void }).onEvent({
			type: "changes",
			data: summary,
		});
		expect(client.getQueryData(keys.changes("a1", "worktree"))).toBe(summary);
		expect(client.getQueryData(keys.changesPeek("a1"))).toBe(summary);
		live.dispose();
	});

	test("routes: #/changes/<id>?f=<path>", () => {
		const r = { view: "changes" as const, id: "m1/pi:x", file: "src/a b.ts" };
		expect(parseHash(hrefFor(r))).toEqual(r);
		expect(parseHash("#/changes/a1")).toEqual({ view: "changes", id: "a1" });
		expect(parseHash("#/changes/")).toEqual({ view: "home" });
	});
});
