import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { insideRepo } from "../changes/read.ts";
import { runGit } from "../git-write.ts";
import type {
	FileContent,
	FileEntry,
	FileHit,
	FileSearch,
	FileTree,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import { sniffImage } from "../transcripts/tailer.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import type { RemoteAttachments } from "./pool.ts";

/** Results per query. */
export const FILES_MAX = 50;
/** A listing is reused this long (typing a query asks once per keystroke). */
const CACHE_MS = 10_000;
/** Paths read from one worktree at most. */
export const MAX_PATHS = 200_000;

interface Listing {
	at: number;
	items: FileHit[];
	/** The agent's folder from the worktree's top (`pkg/`), "" at the top. */
	lead: string;
	/** Cut at MAX_PATHS. */
	truncated: boolean;
}

type Listed =
	| {
			ok: true;
			base: string;
			items: FileHit[];
			lead: string;
			truncated: boolean;
	  }
	/** `not_git`: no worktree here; `unavailable`: git timed out, overflowed, or is missing. */
	| { ok: false; reason: "not_git" | "unavailable" };

/**
 * The `@` menu's files: what git tracks plus untracked files it doesn't
 * ignore, in the agent's folder (`git ls-files` through the read-only git
 * runner), with their folders, ranked for a query. Paths are relative to
 * the agent's folder; any path that leaves it (`..`, a link out of the
 * repo) is dropped. Remote agents are listed by their home node. Callers
 * authorize `transcript.read` first.
 */
export class Files {
	remote: RemoteAttachments | null = null;
	private readonly lookup: (agentId: string) => Agent | undefined;
	private cache = new Map<string, Listing>();
	private readonly now: () => number;

	private readonly git: typeof runGit;

	constructor(
		lookup: (agentId: string) => Agent | undefined,
		now: () => number = Date.now,
		/** The git runner (tests pass a fake one). */
		git: typeof runGit = runGit,
	) {
		this.lookup = lookup;
		this.now = now;
		this.git = git;
	}

	async search(
		agentId: string,
		q: string,
		as?: Principal,
	): Promise<FileSearch> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.files(agentId, q, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		if (!agent.cwd)
			return { agent: agentId, available: false, reason: "no_cwd", items: [] };
		const listed = await this.list(agent.cwd);
		if (!listed.ok)
			return {
				agent: agentId,
				available: false,
				reason: listed.reason,
				items: [],
			};
		const ranked = rankFiles(listed.items, q).slice(0, FILES_MAX * 2);
		// Only what stays in the agent's folder, links resolved.
		const safe = await Promise.all(
			ranked.map(async (h) =>
				(await staysIn(listed.base, h.path)) ? h : null,
			),
		);
		return {
			agent: agentId,
			available: true,
			items: safe.filter((h): h is FileHit => h !== null).slice(0, FILES_MAX),
			...(listed.truncated ? { truncated: true } : {}),
		};
	}

	/**
	 * One folder for the file viewer: what git lists (ignored files left
	 * out); a folder git doesn't list (ignored, or no repo) is read from
	 * disk. Never `.git`, never through a link that leaves the folder.
	 */
	async tree(agentId: string, path: string, as?: Principal): Promise<FileTree> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.tree(agentId, path, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		const none = (reason: string): FileTree => ({
			agent: agentId,
			path,
			available: false,
			reason,
			entries: [],
		});
		if (!agent.cwd) return none("no_cwd");
		const dir = cleanPath(path, true);
		if (dir === null) return none("not_found");
		let base: string;
		try {
			base = await realpath(agent.cwd);
		} catch {
			return none("not_found");
		}
		const listed = await this.list(agent.cwd);
		let entries: FileEntry[] | null = null;
		if (
			listed.ok &&
			(dir === "" ||
				listed.items.some((h) => h.kind === "dir" && h.path === dir))
		) {
			const lead = dir ? `${dir}/` : "";
			const kids = listed.items.filter(
				(h) =>
					h.path.startsWith(lead) &&
					!h.path.slice(lead.length).includes("/") &&
					!isGitPath(h.path),
			);
			const safe = await Promise.all(
				kids.map(async (h) => ((await staysIn(base, h.path)) ? h : null)),
			);
			entries = safe
				.filter((h): h is FileHit => h !== null)
				.map((h) => ({
					name: h.path.slice(lead.length),
					path: h.path,
					kind: h.kind,
				}));
		} else entries = await readFolder(base, dir);
		if (entries === null) return none("not_found");
		entries.sort(
			(a, b) =>
				(a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) ||
				a.name.localeCompare(b.name),
		);
		return {
			agent: agentId,
			path: dir,
			available: true,
			entries: entries.slice(0, TREE_MAX),
			...(entries.length > TREE_MAX ? { truncated: true } : {}),
		};
	}

	/**
	 * One file for the viewer: text (up to `TEXT_MAX`), or what it is
	 * (image, binary, too large). Any file in the agent's folder, ignored
	 * ones too (an agent's report links to its own output), but never in
	 * `.git` and never through a link that leaves the folder.
	 */
	async read(
		agentId: string,
		path: string,
		as?: Principal,
	): Promise<FileContent> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.read(agentId, path, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		const opened = await this.openFile(agent, path);
		if (!opened.ok)
			return {
				agent: agentId,
				path,
				available: false,
				reason: opened.reason,
			};
		const { file, size, rel } = opened;
		const listed = await this.list(agent.cwd!);
		const out: FileContent = {
			agent: agentId,
			path: rel,
			available: true,
			size,
			repoPath: listed.ok ? listed.lead + rel : null,
		};
		const head = await readHead(file, Math.min(size, TEXT_MAX));
		const image = sniffImage(head);
		if (image)
			return size > IMAGE_MAX
				? { ...out, kind: "too_large" }
				: { ...out, kind: "image", mediaType: image };
		if (head.subarray(0, 8000).includes(0)) return { ...out, kind: "binary" };
		const truncated = size > TEXT_MAX;
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: !truncated }).decode(head);
		} catch {
			return { ...out, kind: "binary" };
		}
		return { ...out, kind: "text", text, ...(truncated ? { truncated } : {}) };
	}

	/** An image file's bytes (png, jpeg, gif, webp, by their first bytes). */
	async image(
		agentId: string,
		path: string,
		as?: Principal,
	): Promise<{ mediaType: string; data: Buffer }> {
		const agent = this.lookup(agentId);
		if (!agent) {
			if (this.remote && agentId.includes("/"))
				return this.remote.image(agentId, path, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		const opened = await this.openFile(agent, path);
		if (!opened.ok) throw new RpcError("not_found", "no such file");
		if (opened.size > IMAGE_MAX)
			throw new RpcError("too_large", "the image is over 10 MB");
		const data = await readHead(opened.file, opened.size);
		const mediaType = sniffImage(data);
		if (!mediaType)
			throw new RpcError("unsupported_media", "the file is not an image");
		return { mediaType, data };
	}

	/** Resolves a viewer path to a regular file in the agent's folder. */
	private async openFile(
		agent: Agent,
		path: string,
	): Promise<
		| { ok: true; file: string; size: number; rel: string }
		| { ok: false; reason: string }
	> {
		if (!agent.cwd) return { ok: false, reason: "no_cwd" };
		const rel = cleanPath(path, false);
		if (rel === null) return { ok: false, reason: "not_found" };
		if (isGitPath(rel)) return { ok: false, reason: "refused" };
		try {
			const base = await realpath(agent.cwd);
			const abs = await insideRepo(base, rel);
			if (!abs) return { ok: false, reason: "not_found" };
			// A link must end inside the folder, and not in its `.git`.
			const real = await realpath(abs);
			if (!real.startsWith(base + sep))
				return { ok: false, reason: "not_found" };
			if (isGitPath(relative(base, real).split(sep).join("/")))
				return { ok: false, reason: "refused" };
			const st = await stat(real);
			if (!st.isFile()) return { ok: false, reason: "not_file" };
			return { ok: true, file: real, size: st.size, rel };
		} catch {
			return { ok: false, reason: "not_found" };
		}
	}

	private async list(cwd: string): Promise<Listed> {
		let base: string;
		try {
			base = await realpath(cwd);
		} catch {
			return { ok: false, reason: "not_git" };
		}
		const hit = this.cache.get(base);
		if (hit && this.now() - hit.at < CACHE_MS)
			return {
				ok: true,
				base,
				items: hit.items,
				lead: hit.lead,
				truncated: hit.truncated,
			};
		const r = await this.git(
			base,
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ mode: "read", lane: "user" },
		);
		if (!r.ok)
			return {
				ok: false,
				reason: r.code === "not_a_worktree" ? "not_git" : "unavailable",
			};
		const prefix = relative(r.root, base);
		if (prefix.startsWith("..")) return { ok: false, reason: "not_git" };
		const lead = prefix ? `${prefix.split(sep).join("/")}/` : "";
		const files = new Set<string>();
		const dirs = new Set<string>();
		let truncated = false;
		for (const raw of r.stdout.split("\0")) {
			if (files.size >= MAX_PATHS) {
				truncated = true;
				break;
			}
			if (!raw?.startsWith(lead)) continue;
			const p = raw.slice(lead.length);
			// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
			if (!p || /[\u0000-\u001f\u007f]/.test(p)) continue;
			const segs = p.split("/");
			if (segs.some((s) => s === "" || s === "." || s === "..")) continue;
			files.add(p);
			for (let i = 1; i < segs.length; i++)
				dirs.add(segs.slice(0, i).join("/"));
		}
		const items: FileHit[] = [
			...[...dirs].map((path) => ({ path, kind: "dir" as const })),
			...[...files].map((path) => ({ path, kind: "file" as const })),
		];
		this.cache.set(base, { at: this.now(), items, lead, truncated });
		if (this.cache.size > 8)
			this.cache.delete(this.cache.keys().next().value as string);
		return { ok: true, base, items, lead, truncated };
	}
}

/**
 * True when the path stays in `base`: its folders (insideRepo) and, for a
 * symbolic link, what the link itself resolves to (a link to ~/.ssh is dropped).
 */
async function staysIn(base: string, path: string): Promise<boolean> {
	const abs = await insideRepo(base, path);
	if (!abs) return false;
	try {
		if (!(await lstat(abs)).isSymbolicLink()) return true;
		const real = await realpath(abs);
		const root = await realpath(base);
		return real === root || real.startsWith(root + sep);
	} catch {
		return false;
	}
}

/** Entries per folder listing. */
export const TREE_MAX = 2000;
/** Text the viewer shows at most. */
export const TEXT_MAX = 1024 * 1024;
/** Images the viewer shows at most (the same limit as transcript images). */
export const IMAGE_MAX = 10 * 1024 * 1024;

/**
 * A viewer path, checked: relative, `/`-separated, no empty, `.` or `..`
 * segment, no control characters. "" is the top (only for a folder).
 */
function cleanPath(path: string, folder: boolean): string | null {
	const p = path.replace(/\/+$/, "");
	if (!p) return folder ? "" : null;
	if (p.length > 4096 || p.startsWith("/")) return null;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
	if (/[\u0000-\u001f\u007f]/.test(p)) return null;
	const segs = p.split("/");
	if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
	return p;
}

/** In a `.git` folder (which can hold credentials in its config). */
const isGitPath = (p: string) => p.split("/").includes(".git");

/**
 * A folder read from disk (ignored, or not in a repo): its entries, never
 * `.git`, and a link only when it resolves inside `base`. Null when the
 * folder is not there or leaves `base`.
 */
async function readFolder(
	base: string,
	dir: string,
): Promise<FileEntry[] | null> {
	if (isGitPath(dir)) return null;
	try {
		const abs = dir ? await insideRepo(base, dir) : base;
		if (!abs) return null;
		const real = await realpath(abs);
		if (real !== base && !real.startsWith(base + sep)) return null;
		const out: FileEntry[] = [];
		for (const d of await readdir(real, { withFileTypes: true })) {
			if (out.length > TREE_MAX) break;
			if (d.name === ".git") continue;
			// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
			if (/[\u0000-\u001f\u007f/]/.test(d.name)) continue;
			const path = dir ? `${dir}/${d.name}` : d.name;
			let isDir = d.isDirectory();
			if (d.isSymbolicLink()) {
				try {
					const to = await realpath(join(real, d.name));
					if (!to.startsWith(base + sep)) continue;
					isDir = (await stat(to)).isDirectory();
				} catch {
					continue;
				}
			} else if (!isDir && !d.isFile()) continue;
			out.push({ name: d.name, path, kind: isDir ? "dir" : "file" });
		}
		return out;
	} catch {
		return null;
	}
}

/** The first `n` bytes of a file (a regular file, not a link). */
async function readHead(file: string, n: number): Promise<Buffer> {
	const fh = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const buf = Buffer.alloc(n);
		let got = 0;
		while (got < n) {
			const { bytesRead } = await fh.read(buf, got, n - got, got);
			if (!bytesRead) break;
			got += bytesRead;
		}
		return buf.subarray(0, got);
	} finally {
		await fh.close();
	}
}

/**
 * Ranks paths for a query: every word must appear in order (a fuzzy
 * subsequence); a match in the file name beats one in its folders, a
 * contiguous match beats a scattered one, and shorter paths win ties. An
 * empty query lists the shallowest paths first.
 */
export function rankFiles(items: FileHit[], q: string): FileHit[] {
	const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
	if (!words.length)
		return [...items]
			.sort(
				(a, b) =>
					depth(a.path) - depth(b.path) ||
					(a.kind === b.kind ? 0 : a.kind === "dir" ? -1 : 1) ||
					a.path.localeCompare(b.path),
			)
			.slice(0, FILES_MAX * 2);
	const scored: { h: FileHit; s: number }[] = [];
	for (const h of items) {
		let total = 0;
		for (const w of words) {
			const s = scoreWord(h.path, w);
			if (s === null) {
				total = -1;
				break;
			}
			total += s;
		}
		if (total >= 0) scored.push({ h, s: total - h.path.length * 0.01 });
	}
	scored.sort((a, b) => b.s - a.s || a.h.path.localeCompare(b.h.path));
	return scored.map((x) => x.h);
}

const depth = (p: string) => p.split("/").length;

function scoreWord(path: string, w: string): number | null {
	const lower = path.toLowerCase();
	const slash = lower.lastIndexOf("/");
	const name = lower.slice(slash + 1);
	if (name === w) return 100;
	if (name.startsWith(w)) return 80;
	if (name.includes(w)) return 60;
	if (lower.includes(w)) return 40;
	// In order, scattered: better when the letters bunch together.
	let at = -1;
	let gaps = 0;
	for (const ch of w) {
		const next = lower.indexOf(ch, at + 1);
		if (next < 0) return null;
		if (at >= 0) gaps += next - at - 1;
		at = next;
	}
	return Math.max(1, 20 - gaps * 0.5);
}
