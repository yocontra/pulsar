/**
 * Mock worktree changes for the diff viewer: a few agents have dirty
 * worktrees (every status, a binary and a too-large file), one has a clean
 * one, one has no repo; `edit` (the realtime control) changes a file so
 * live updates can be tested.
 */
import type {
	ChangedFile,
	ChangesMode,
	ChangesSummary,
	FileDiff,
} from "../../src/http/wire.ts";
import type { MockAgent } from "./data.ts";

interface MockFile {
	file: Omit<ChangedFile, "key">;
	patch: string | null;
	tooLarge?: boolean;
	/** Only in branch-vs-base mode (committed on the branch). */
	committed?: boolean;
	rev: number;
}

const AUTH_TS = `diff --git a/src/auth/refresh.ts b/src/auth/refresh.ts
index 3f2a1c0..9b7e4d2 100644
--- a/src/auth/refresh.ts
+++ b/src/auth/refresh.ts
@@ -1,9 +1,10 @@
 import { Mutex } from "../util/mutex.ts";
 import type { Session } from "./session.ts";

-let refreshing: Promise<Session> | null = null;
+const lock = new Mutex();

 /** Refreshes the session's token once, however many callers race. */
 export async function refresh(session: Session): Promise<Session> {
-	if (refreshing) return refreshing;
-	refreshing = doRefresh(session).finally(() => (refreshing = null));
-	return refreshing;
+	return lock.run(async () => {
+		if (!session.expired()) return session;
+		return doRefresh(session);
+	});
 }
@@ -40,7 +41,7 @@ async function doRefresh(session: Session): Promise<Session> {
 	const res = await fetch("/oauth/token", {
 		method: "POST",
 		body: new URLSearchParams({ grant_type: "refresh_token" }),
-		credentials: "same-origin",
+		credentials: "include",
 	});
 	if (!res.ok) throw new RefreshError(res.status);
 	return session.with(await res.json());
`;

const TEST_TS = `diff --git a/test/refresh.test.ts b/test/refresh.test.ts
new file mode 100644
--- /dev/null
+++ b/test/refresh.test.ts
@@ -0,0 +1,12 @@
+import { expect, test } from "bun:test";
+import { refresh } from "../src/auth/refresh.ts";
+import { fakeSession } from "./helpers.ts";
+
+test("concurrent refreshes share one request", async () => {
+	const s = fakeSession({ expired: true });
+	const [a, b] = await Promise.all([refresh(s), refresh(s)]);
+	expect(a).toBe(b);
+	expect(s.requests).toBe(1);
+});
+
+test.todo("a failed refresh releases the lock");
`;

const OLD_MD = `diff --git a/docs/old-auth.md b/docs/old-auth.md
deleted file mode 100644
--- a/docs/old-auth.md
+++ /dev/null
@@ -1,3 +1,0 @@
-# Token refresh (old)
-
-Callers must hold the global refresh flag.
`;

const RENAME = `diff --git a/src/util/lock.ts b/src/util/mutex.ts
similarity index 92%
rename from src/util/lock.ts
rename to src/util/mutex.ts
--- a/src/util/lock.ts
+++ b/src/util/mutex.ts
@@ -1,4 +1,4 @@
-export class Lock {
+export class Mutex {
 	private tail: Promise<unknown> = Promise.resolve();
 	run<T>(fn: () => Promise<T>): Promise<T> {
 		const next = this.tail.then(fn);
`;

const NOTES = `diff --git a/NOTES.md b/NOTES.md
new file mode 100644
--- /dev/null
+++ b/NOTES.md
@@ -0,0 +1,3 @@
+# fix-1378
+
+- [x] serialize refreshes behind one mutex
`;

const CHANGELOG = `diff --git a/CHANGELOG.md b/CHANGELOG.md
index 1111111..2222222 100644
--- a/CHANGELOG.md
+++ b/CHANGELOG.md
@@ -1,4 +1,6 @@
 # Changelog

 ## Unreleased
+
+- Fixed: concurrent token refreshes no longer log users out (#1378).

`;

function authFiles(): MockFile[] {
	return [
		{
			file: {
				path: "src/auth/refresh.ts",
				status: "modified",
				staged: false,
				unstaged: true,
				binary: false,
				added: 6,
				removed: 4,
			},
			patch: AUTH_TS,
			rev: 0,
		},
		{
			file: {
				path: "test/refresh.test.ts",
				status: "added",
				staged: true,
				unstaged: false,
				binary: false,
				added: 12,
				removed: 0,
			},
			patch: TEST_TS,
			rev: 0,
		},
		{
			file: {
				path: "docs/old-auth.md",
				status: "deleted",
				staged: false,
				unstaged: true,
				binary: false,
				added: 0,
				removed: 3,
			},
			patch: OLD_MD,
			rev: 0,
		},
		{
			file: {
				path: "src/util/mutex.ts",
				oldPath: "src/util/lock.ts",
				status: "renamed",
				staged: true,
				unstaged: false,
				binary: false,
				added: 1,
				removed: 1,
			},
			patch: RENAME,
			rev: 0,
		},
		{
			file: {
				path: "NOTES.md",
				status: "untracked",
				staged: false,
				unstaged: true,
				binary: false,
				added: 3,
				removed: 0,
			},
			patch: NOTES,
			rev: 0,
		},
		{
			file: {
				path: "assets/logo.png",
				status: "modified",
				staged: false,
				unstaged: true,
				binary: true,
				added: null,
				removed: null,
			},
			patch: null,
			rev: 0,
		},
		{
			file: {
				path: "fixtures/recording.json",
				status: "modified",
				staged: false,
				unstaged: true,
				binary: false,
				added: 18_211,
				removed: 17_904,
			},
			patch: null,
			tooLarge: true,
			rev: 0,
		},
		{
			file: {
				path: "CHANGELOG.md",
				status: "modified",
				staged: false,
				unstaged: false,
				binary: false,
				added: 2,
				removed: 0,
			},
			patch: CHANGELOG,
			committed: true,
			rev: 0,
		},
	];
}

/** Per agent name: its worktree, or why it has none. */
const state = new Map<string, MockFile[] | "not_a_repo">();
function filesOf(a: MockAgent): MockFile[] | "not_a_repo" {
	let s = state.get(a.name);
	if (!s) {
		s =
			a.name === "apparish-auth"
				? authFiles()
				: a.name === "omp@apparish"
					? "not_a_repo"
					: [];
		state.set(a.name, s);
	}
	return s;
}

export function resetChanges() {
	state.clear();
}

const keyOf = (f: MockFile, mode: ChangesMode) =>
	`${mode}:${f.file.path}:${f.rev}`;

export function changesSummary(
	a: MockAgent,
	mode: ChangesMode,
): ChangesSummary {
	const s = filesOf(a);
	const base = {
		agent: a.id,
		mode,
		repo: a.project,
		root: `~/Projects/${a.project}`,
		branch: a.branch,
		head: "9b7e4d2c1a0f",
		upstream: a.branch
			? { ref: `origin/${a.branch}`, ahead: 1, behind: 0 }
			: null,
		base: { ref: "origin/main", ahead: 1, behind: 3, mergeBase: "1111111" },
	};
	if (s === "not_a_repo")
		return {
			...base,
			available: false,
			reason: "not_a_repo",
			repo: null,
			root: null,
			branch: null,
			head: null,
			upstream: null,
			base: null,
			files: [],
			total: 0,
			truncated: false,
			added: 0,
			removed: 0,
			stamp: "not_a_repo",
		};
	const shown = s.filter((f) => mode === "base" || !f.committed);
	const files = shown.map((f) => ({ ...f.file, key: keyOf(f, mode) }));
	return {
		...base,
		available: true,
		files,
		total: files.length,
		truncated: false,
		added: files.reduce((n, f) => n + (f.added ?? 0), 0),
		removed: files.reduce((n, f) => n + (f.removed ?? 0), 0),
		stamp: files.map((f) => f.key).join("|") || "clean",
	};
}

export function changeFile(
	a: MockAgent,
	mode: ChangesMode,
	path: string,
): FileDiff | null {
	const s = filesOf(a);
	if (s === "not_a_repo") return null;
	const f = s.find(
		(x) => x.file.path === path && (mode === "base" || !x.committed),
	);
	if (!f) return null;
	return {
		path: f.file.path,
		...(f.file.oldPath ? { oldPath: f.file.oldPath } : {}),
		status: f.file.status,
		binary: f.file.binary,
		tooLarge: !!f.tooLarge,
		patch: f.patch,
		key: keyOf(f, mode),
	};
}

/**
 * The realtime control's `changes` action: appends a line to a file (or
 * adds `path` as a new untracked file). Returns false for an agent with no repo.
 */
export function editChanges(a: MockAgent, path: string, line: string): boolean {
	const s = filesOf(a);
	if (s === "not_a_repo") return false;
	const f = s.find((x) => x.file.path === path);
	if (f?.patch) {
		// The viewer draws lines, not hunk counts: appending is enough.
		f.patch = `${f.patch}+${line}\n`;
		f.file.added = (f.file.added ?? 0) + 1;
		f.rev++;
		return true;
	}
	s.push({
		file: {
			path,
			status: "untracked",
			staged: false,
			unstaged: true,
			binary: false,
			added: 1,
			removed: 0,
		},
		patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${line}\n`,
		rev: 0,
	});
	s.sort((x, y) => (x.file.path < y.file.path ? -1 : 1));
	return true;
}

/**
 * The git actions' commit (web/mock/git.ts): the files leave the working
 * tree and stay in branch-vs-base mode, as a commit on the branch would.
 * Returns how many matched.
 */
export function commitChanges(a: MockAgent, paths: string[]): number {
	const s = filesOf(a);
	if (s === "not_a_repo") return 0;
	let n = 0;
	for (const f of s)
		if (!f.committed && paths.includes(f.file.path)) {
			f.committed = true;
			f.rev++;
			n++;
		}
	return n;
}
