import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readlink, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { exec, type Lane } from "../exec.ts";
import type {
	BranchCompare,
	ChangedFile,
	ChangeStatus,
	ChangesMode,
	ChangesSummary,
	FileDiff,
} from "../http/wire.ts";

/**
 * What an agent's worktree has dirty, read with git. Read-only and safe to
 * run under a working agent: every git runs asynchronously (src/exec.ts),
 * with `GIT_OPTIONAL_LOCKS=0` (never the index lock), no pager, no colors,
 * no external diff tools or textconv, no fsmonitor hook, literal pathspecs.
 * Untracked files are read here, never through a symbolic link and never
 * outside the repo. Summaries are cached per worktree and recomputed only
 * when `git status`, the listed files' sizes and mtimes, HEAD or the base
 * moved.
 */

/** Files listed in a summary; the rest are counted (`total`, `truncated`). */
const MAX_FILES = 500;
/** Files remembered per summary (so a diff can be served for any listed path). */
const MAX_KNOWN = 5000;
/** A file's diff over this is "too large"; also the largest untracked file read. */
export const MAX_DIFF_BYTES = 512 * 1024;
/** Untracked bytes read per summary to count lines; past it counts are null. */
const COUNT_BUDGET = 8 * 1024 * 1024;
/** Summaries kept (per worktree and mode). */
const MAX_CACHED = 64;
const SNIFF = 8000;

const GIT_CONFIG = [
	"--no-pager",
	"-c",
	"core.quotepath=off",
	"-c",
	"core.fsmonitor=false",
	"-c",
	"color.ui=false",
	"-c",
	"diff.noprefix=false",
	"-c",
	"diff.mnemonicPrefix=false",
	"-c",
	"diff.relative=false",
	"-c",
	"diff.external=",
];

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

function gitEnv(): NodeJS.ProcessEnv {
	return {
		...process.env,
		GIT_OPTIONAL_LOCKS: "0",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
	};
}

function git(
	dir: string,
	args: string[],
	opts: { lane: Lane; maxBuffer?: number; timeoutMs?: number },
) {
	return exec("git", [...GIT_CONFIG, "-C", dir, ...args], {
		lane: opts.lane,
		env: gitEnv(),
		timeoutMs: opts.timeoutMs ?? 10_000,
		maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
	});
}

const sha1 = (...parts: string[]) => {
	const h = createHash("sha1");
	for (const p of parts) h.update(p).update("\u0000");
	return h.digest("hex").slice(0, 16);
};

// --------------------------------------------------------------- parsing

export interface StatusEntry {
	path: string;
	oldPath?: string;
	/** Porcelain v2 XY ("M.", ".M", "??"). */
	xy: string;
	kind: "changed" | "renamed" | "unmerged" | "untracked";
	/** The whole record, for cache keys. */
	raw: string;
}

export interface StatusInfo {
	oid: string | null;
	head: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	entries: StatusEntry[];
}

/** Parses `git status --porcelain=v2 -z --branch`. */
export function parseStatus(out: string): StatusInfo {
	const info: StatusInfo = {
		oid: null,
		head: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		entries: [],
	};
	const fields = out.split("\u0000");
	for (let i = 0; i < fields.length; i++) {
		const f = fields[i]!;
		if (!f) continue;
		if (f.startsWith("# ")) {
			const [key = "", ...rest] = f.slice(2).split(" ");
			const val = rest.join(" ");
			if (key === "branch.oid") info.oid = val === "(initial)" ? null : val;
			else if (key === "branch.head")
				info.head = val === "(detached)" ? null : val;
			else if (key === "branch.upstream") info.upstream = val;
			else if (key === "branch.ab") {
				const m = /^\+(\d+) -(\d+)$/.exec(val);
				if (m) {
					info.ahead = Number(m[1]);
					info.behind = Number(m[2]);
				}
			}
			continue;
		}
		const type = f[0];
		if (type === "1") {
			// 1 XY sub mH mI mW hH hI path
			const parts = f.split(" ");
			info.entries.push({
				path: parts.slice(8).join(" "),
				xy: parts[1] ?? "..",
				kind: "changed",
				raw: f,
			});
		} else if (type === "2") {
			// 2 XY sub mH mI mW hH hI Xscore path \0 origPath
			const parts = f.split(" ");
			const oldPath = fields[++i] ?? "";
			info.entries.push({
				path: parts.slice(9).join(" "),
				oldPath,
				xy: parts[1] ?? "..",
				kind: "renamed",
				raw: `${f}\u0000${oldPath}`,
			});
		} else if (type === "u") {
			// u XY sub m1 m2 m3 mW h1 h2 h3 path
			const parts = f.split(" ");
			info.entries.push({
				path: parts.slice(10).join(" "),
				xy: parts[1] ?? "UU",
				kind: "unmerged",
				raw: f,
			});
		} else if (type === "?") {
			info.entries.push({
				path: f.slice(2),
				xy: "??",
				kind: "untracked",
				raw: f,
			});
		}
	}
	return info;
}

/** A status record whose HEAD, index or worktree mode is a symbolic link. */
function isLink(raw: string): boolean {
	const parts = raw.split(" ");
	return parts.slice(3, 6).includes("120000");
}

export interface NameStatus {
	status: ChangeStatus;
	path: string;
	oldPath?: string;
}

const LETTER: Record<string, ChangeStatus> = {
	M: "modified",
	A: "added",
	D: "deleted",
	R: "renamed",
	C: "copied",
	T: "typechange",
	U: "conflicted",
};

/** Parses `git diff -z --name-status`. */
export function parseNameStatus(out: string): NameStatus[] {
	const f = out.split("\u0000");
	const list: NameStatus[] = [];
	for (let i = 0; i < f.length; ) {
		const code = f[i++];
		if (!code) continue;
		const status = LETTER[code[0]!] ?? "modified";
		if (code[0] === "R" || code[0] === "C") {
			const oldPath = f[i++] ?? "";
			const path = f[i++] ?? "";
			list.push({ status, path, oldPath });
		} else list.push({ status, path: f[i++] ?? "" });
	}
	return list;
}

export interface NumStat {
	path: string;
	added: number | null;
	removed: number | null;
	binary: boolean;
}

/** Parses `git diff -z --numstat` (renames: `a\tr\t\0old\0new\0`). */
export function parseNumstat(out: string): NumStat[] {
	const f = out.split("\u0000");
	const list: NumStat[] = [];
	for (let i = 0; i < f.length; ) {
		const rec = f[i++];
		if (!rec) continue;
		const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
		if (!m) continue;
		let path = m[3]!;
		if (path === "") {
			i++; // old path
			path = f[i++] ?? "";
		}
		const binary = m[1] === "-" && m[2] === "-";
		list.push({
			path,
			added: binary ? null : Number(m[1]),
			removed: binary ? null : Number(m[2]),
			binary,
		});
	}
	return list;
}

// ------------------------------------------------------------ the repo

export interface Repo {
	root: string;
	gitDir: string;
}

/** The worktree a folder belongs to; null outside a repo (or a bare one). */
async function findRepo(
	cwd: string,
	lane: Lane,
): Promise<Repo | null | "failed"> {
	const r = await git(
		cwd,
		["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir"],
		{ lane, timeoutMs: 4000 },
	);
	if (!r.ok) return r.timedOut || r.code === null ? "failed" : null;
	const [root = "", gitDir = ""] = r.stdout.trim().split("\n");
	return root ? { root, gitDir } : null;
}

interface BaseInfo {
	ref: string;
	sha: string;
}

/** The default branch to compare with: origin's HEAD, else main / master. */
async function findBase(root: string, lane: Lane): Promise<BaseInfo | null> {
	const r = await git(
		root,
		[
			"for-each-ref",
			"--format=%(refname)%00%(objectname)%00%(symref)",
			"refs/remotes/origin/HEAD",
			"refs/remotes/origin/main",
			"refs/remotes/origin/master",
			"refs/heads/main",
			"refs/heads/master",
		],
		{ lane, timeoutMs: 4000 },
	);
	if (!r.ok) return null;
	const refs = new Map<string, { sha: string; symref: string }>();
	for (const line of r.stdout.split("\n")) {
		const [name = "", sha = "", symref = ""] = line.split("\u0000");
		if (name) refs.set(name, { sha, symref });
	}
	const head = refs.get("refs/remotes/origin/HEAD");
	const order = [
		head?.symref,
		"refs/remotes/origin/main",
		"refs/remotes/origin/master",
		"refs/heads/main",
		"refs/heads/master",
	];
	for (const name of order) {
		if (!name) continue;
		const hit = refs.get(name) ?? (name === head?.symref ? head : undefined);
		if (hit?.sha)
			return {
				ref: name.replace(/^refs\/(remotes|heads)\//, ""),
				sha: hit.sha,
			};
	}
	return null;
}

interface BaseCompare extends BranchCompare {
	mergeBase: string | null;
}

const baseCache = new Map<string, BaseCompare>();

async function compareBase(
	root: string,
	head: string,
	base: BaseInfo,
	lane: Lane,
): Promise<BaseCompare> {
	const key = `${root}\u0000${head}\u0000${base.sha}`;
	const hit = baseCache.get(key);
	if (hit) return hit;
	const [mb, counts] = await Promise.all([
		git(root, ["merge-base", head, base.sha], { lane }),
		git(
			root,
			["rev-list", "--left-right", "--count", `${base.sha}...${head}`],
			{
				lane,
			},
		),
	]);
	const [behind = "0", ahead = "0"] = counts.ok
		? counts.stdout.trim().split(/\s+/)
		: [];
	const out: BaseCompare = {
		ref: base.ref,
		mergeBase: mb.ok ? mb.stdout.trim() || null : null,
		ahead: Number(ahead) || 0,
		behind: Number(behind) || 0,
	};
	if (!mb.timedOut && !counts.timedOut) {
		baseCache.set(key, out);
		if (baseCache.size > MAX_CACHED)
			baseCache.delete(baseCache.keys().next().value!);
	}
	return out;
}

const emptyTrees = new Map<string, string>();

/** The empty tree's id (for a repo with no commits; differs in SHA-256 repos). */
async function emptyTree(root: string, lane: Lane): Promise<string> {
	const hit = emptyTrees.get(root);
	if (hit) return hit;
	const r = await git(root, ["hash-object", "-t", "tree", "/dev/null"], {
		lane,
	});
	const id = r.ok
		? r.stdout.trim()
		: "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
	if (r.ok) emptyTrees.set(root, id);
	return id;
}

// ------------------------------------------------------- untracked files

/**
 * A path from git, inside the repo: relative, no `..` or empty segments,
 * and its folder (symbolic links resolved) still under the repo's root.
 * Returns the absolute path of the entry itself (never resolved: it may be
 * a link), or null.
 */
export async function insideRepo(
	root: string,
	path: string,
): Promise<string | null> {
	if (!path || isAbsolute(path) || path.includes("\u0000")) return null;
	const segs = path.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	try {
		const realRoot = await realpath(root);
		const abs = join(realRoot, path);
		const parent = await realpath(dirname(abs));
		if (parent !== realRoot && !parent.startsWith(realRoot + sep)) return null;
		return join(parent, basename(abs));
	} catch {
		return null;
	}
}

interface Untracked {
	symlink: boolean;
	binary: boolean;
	tooLarge: boolean;
	/** Lines for a text file or a link (its target); null otherwise. */
	text: string | null;
	mode: string;
}

/** Reads an untracked file: never follows a link, at most `MAX_DIFF_BYTES`. */
async function readUntracked(
	root: string,
	path: string,
	budget?: { left: number },
): Promise<Untracked | null> {
	const abs = await insideRepo(root, path);
	if (!abs) return null;
	try {
		const st = await lstat(abs);
		if (st.isSymbolicLink())
			return {
				symlink: true,
				binary: false,
				tooLarge: false,
				text: await readlink(abs),
				mode: "120000",
			};
		const mode = st.mode & 0o111 ? "100755" : "100644";
		if (!st.isFile())
			return {
				symlink: false,
				binary: true,
				tooLarge: false,
				text: null,
				mode,
			};
		if (st.size > MAX_DIFF_BYTES)
			return {
				symlink: false,
				binary: false,
				tooLarge: true,
				text: null,
				mode,
			};
		if (budget) {
			if (budget.left < st.size)
				return {
					symlink: false,
					binary: false,
					tooLarge: true,
					text: null,
					mode,
				};
			budget.left -= st.size;
		}
		const fh = await open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
		let buf: Buffer;
		try {
			buf = await fh.readFile();
		} finally {
			await fh.close();
		}
		if (buf.length > MAX_DIFF_BYTES)
			return {
				symlink: false,
				binary: false,
				tooLarge: true,
				text: null,
				mode,
			};
		if (buf.subarray(0, SNIFF).includes(0))
			return {
				symlink: false,
				binary: true,
				tooLarge: false,
				text: null,
				mode,
			};
		return {
			symlink: false,
			binary: false,
			tooLarge: false,
			text: buf.toString("utf8"),
			mode,
		};
	} catch {
		return null;
	}
}

function lineCount(text: string): number {
	if (!text) return 0;
	let n = 0;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
	return text.endsWith("\n") ? n : n + 1;
}

/** A unified diff for a new file, as git would print it. */
export function newFilePatch(path: string, text: string, mode: string): string {
	const head = `diff --git a/${path} b/${path}\nnew file mode ${mode}\n`;
	if (!text) return head;
	const lines = text.split("\n");
	const noEol = !text.endsWith("\n");
	if (!noEol) lines.pop();
	const n = lines.length;
	return (
		`${head}--- /dev/null\n+++ b/${path}\n@@ -0,0 +1${n === 1 ? "" : `,${n}`} @@\n` +
		lines.map((l) => `+${l}\n`).join("") +
		(noEol ? "\\ No newline at end of file\n" : "")
	);
}

// --------------------------------------------------------------- summaries

interface Known extends ChangedFile {}

interface Cached {
	digest: string;
	/** When this summary was last confirmed current (ms). */
	at: number;
	summary: Omit<ChangesSummary, "agent">;
	/** Every changed file (up to MAX_KNOWN), by path. */
	known: Map<string, Known>;
	/** The ref the diffs compare with (HEAD, the empty tree, the merge base). */
	ref: string | null;
}

const cache = new Map<string, Cached>();
const pending = new Map<string, Promise<Cached>>();

/** Cached summaries (for tests and memory bounds). */
export function cachedSummaries(): number {
	return cache.size;
}

export function clearChangesCache() {
	cache.clear();
	baseCache.clear();
	emptyTrees.clear();
}

function unavailable(
	mode: ChangesMode,
	reason: NonNullable<ChangesSummary["reason"]>,
	extra: Partial<ChangesSummary> = {},
): Omit<ChangesSummary, "agent"> {
	return {
		mode,
		available: false,
		reason,
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
		stamp: reason,
		...extra,
	};
}

async function statStamp(abs: string): Promise<string> {
	try {
		const st = await lstat(abs);
		return `${st.size}:${st.mtimeMs}:${st.ino}`;
	} catch {
		return "-";
	}
}

/**
 * A folder's worktree changes. `lane`: "user" for a viewer's request,
 * "background" for live refreshes.
 */
export async function readChanges(
	cwd: string,
	mode: ChangesMode,
	lane: Lane,
	/** Reuse a summary confirmed this recently (file diffs: Expand all asks for many). */
	maxAgeMs = 0,
): Promise<{ summary: Omit<ChangesSummary, "agent">; cached?: Cached }> {
	const repo = await findRepo(cwd, lane);
	if (repo === "failed") return { summary: unavailable(mode, "git_failed") };
	if (!repo) return { summary: unavailable(mode, "not_a_repo") };
	const key = `${repo.root}\u0000${mode}`;
	const recent = cache.get(key);
	if (recent && maxAgeMs > 0 && Date.now() - recent.at < maxAgeMs)
		return { summary: recent.summary, cached: recent };
	let p = pending.get(key);
	if (!p) {
		p = summarize(repo, mode, lane).finally(() => pending.delete(key));
		pending.set(key, p);
	}
	try {
		const c = await p;
		return { summary: c.summary, cached: c };
	} catch {
		return { summary: unavailable(mode, "git_failed") };
	}
}

class GitFailed extends Error {}

async function summarize(
	repo: Repo,
	mode: ChangesMode,
	lane: Lane,
): Promise<Cached> {
	const { root } = repo;
	const key = `${root}\u0000${mode}`;
	const [st, base, indexStamp] = await Promise.all([
		git(
			root,
			[
				"status",
				"--porcelain=v2",
				"-z",
				"--branch",
				"--untracked-files=all",
				"--ignore-submodules=dirty",
			],
			{ lane },
		),
		findBase(root, lane),
		statStamp(join(repo.gitDir, "index")),
	]);
	if (!st.ok) throw new GitFailed(st.error ?? "git status failed");
	const status = parseStatus(st.stdout);
	const head = status.oid;
	const cmp = head && base ? await compareBase(root, head, base, lane) : null;
	const upstream: BranchCompare | null = status.upstream
		? { ref: status.upstream, ahead: status.ahead, behind: status.behind }
		: null;
	const info = {
		repo: basename(root),
		root,
		branch: status.head,
		head: head ? head.slice(0, 12) : null,
		upstream,
		base: cmp,
	};

	// Unchanged status, file stamps, HEAD and base: the last answer stands.
	const listed = status.entries.slice(0, MAX_KNOWN);
	const stamps = await Promise.all(
		listed.map((e) => statStamp(join(root, e.path))),
	);
	const digest = sha1(
		mode,
		st.stdout,
		indexStamp,
		head ?? "",
		cmp ? `${cmp.ref}:${cmp.mergeBase}:${cmp.ahead}:${cmp.behind}` : "",
		stamps.join("\n"),
	);
	const prev = cache.get(key);
	if (prev && prev.digest === digest) {
		prev.at = Date.now();
		cache.delete(key);
		cache.set(key, prev);
		return prev;
	}

	let ref: string | null;
	if (mode === "base") {
		ref = cmp?.mergeBase ?? null;
		if (!ref) {
			const c: Cached = {
				digest,
				at: Date.now(),
				summary: unavailable(mode, "no_base", { ...info, stamp: digest }),
				known: new Map(),
				ref: null,
			};
			remember(key, c);
			return c;
		}
	} else ref = head ?? (await emptyTree(root, lane));

	const [ns, num] = await Promise.all([
		git(root, ["diff", "-z", "--name-status", ...DIFF_FLAGS, ref], { lane }),
		git(root, ["diff", "-z", "--numstat", ...DIFF_FLAGS, ref], { lane }),
	]);
	if (!ns.ok || !num.ok)
		throw new GitFailed(ns.error ?? num.error ?? "git diff failed");
	const counts = new Map(parseNumstat(num.stdout).map((n) => [n.path, n]));
	const byPath = new Map(status.entries.map((e, i) => [e.path, { e, i }]));
	const stampOf = (path: string) => {
		const hit = byPath.get(path);
		return hit && hit.i < stamps.length ? stamps[hit.i]! : "";
	};

	const known = new Map<string, Known>();
	for (const n of parseNameStatus(ns.stdout)) {
		if (known.size >= MAX_KNOWN) break;
		const c = counts.get(n.path);
		const s = byPath.get(n.path)?.e;
		const conflicted = s?.kind === "unmerged";
		const status: ChangeStatus = conflicted ? "conflicted" : n.status;
		known.set(n.path, {
			path: n.path,
			...(n.oldPath ? { oldPath: n.oldPath } : {}),
			status,
			staged: mode === "worktree" && !!s && s.xy[0] !== ".",
			unstaged: mode === "worktree" && !!s && s.xy[1] !== ".",
			binary: c?.binary ?? false,
			added: c?.added ?? null,
			removed: c?.removed ?? null,
			...(s && isLink(s.raw) ? { symlink: true } : {}),
			// HEAD too: in base mode a new commit changes a diff the status never shows.
			key: sha1(
				ref,
				head ?? "",
				n.status,
				n.oldPath ?? "",
				s?.raw ?? "",
				stampOf(n.path),
			),
		});
	}
	const budget = { left: COUNT_BUDGET };
	const untracked = status.entries.filter((e) => e.kind === "untracked");
	for (const e of untracked) {
		if (known.size >= MAX_KNOWN) break;
		const u =
			known.size < MAX_FILES ? await readUntracked(root, e.path, budget) : null;
		known.set(e.path, {
			path: e.path,
			status: "untracked",
			staged: false,
			unstaged: true,
			binary: u?.binary ?? false,
			...(u?.symlink ? { symlink: true } : {}),
			added: u?.text != null ? lineCount(u.text) : null,
			removed: u?.text != null ? 0 : null,
			key: sha1(ref, "?", stampOf(e.path)),
		});
	}
	const all = [...known.values()].sort((a, b) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
	);
	const total =
		all.length +
		Math.max(
			0,
			status.entries.length - MAX_KNOWN,
		); /* entries past the known cap */
	let added = 0;
	let removed = 0;
	for (const f of all) {
		added += f.added ?? 0;
		removed += f.removed ?? 0;
	}
	const c: Cached = {
		digest,
		at: Date.now(),
		summary: {
			mode,
			available: true,
			...info,
			files: all.slice(0, MAX_FILES),
			total,
			truncated: total > MAX_FILES,
			added,
			removed,
			stamp: digest,
		},
		known,
		ref,
	};
	remember(key, c);
	return c;
}

function remember(key: string, c: Cached) {
	cache.delete(key);
	cache.set(key, c);
	if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
}

/**
 * One file's diff. The path must be one the current summary lists (so no
 * path outside the repo, and nothing `git status` hides, is ever read).
 * Returns null when the file is not (or no longer) changed.
 */
export async function readFileDiff(
	cwd: string,
	mode: ChangesMode,
	path: string,
	lane: Lane,
): Promise<FileDiff | null> {
	const { cached } = await readChanges(cwd, mode, lane, 2000);
	const f = cached?.known.get(path);
	if (!cached || !f || !cached.ref || !cached.summary.root) return null;
	const root = cached.summary.root;
	const base = {
		path: f.path,
		...(f.oldPath ? { oldPath: f.oldPath } : {}),
		status: f.status,
		key: f.key,
	};
	if (f.status === "untracked") {
		const u = await readUntracked(root, f.path);
		if (!u) return null;
		return {
			...base,
			binary: u.binary,
			tooLarge: u.tooLarge,
			patch:
				u.text != null && !u.binary && !u.tooLarge
					? newFilePatch(f.path, u.text, u.mode)
					: null,
		};
	}
	if (f.binary) return { ...base, binary: true, tooLarge: false, patch: null };
	const r = await git(
		root,
		[
			"diff",
			...DIFF_FLAGS,
			cached.ref,
			"--",
			...(f.oldPath ? [f.oldPath] : []),
			f.path,
		],
		{ lane, maxBuffer: MAX_DIFF_BYTES + 1 },
	);
	if (r.overflow)
		return { ...base, binary: false, tooLarge: true, patch: null };
	if (!r.ok) return null;
	const binary =
		/^Binary files .* differ$/m.test(r.stdout) && !/^@@/m.test(r.stdout);
	return {
		...base,
		binary,
		tooLarge: false,
		patch: binary ? null : r.stdout,
	};
}
