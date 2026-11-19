import { realpath } from "node:fs/promises";
import { relative, sep } from "node:path";
import { insideRepo } from "../changes/read.ts";
import { runGit } from "../git-write.ts";
import type { FileHit, FileSearch } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import type { RemoteAttachments } from "./pool.ts";

/** Results per query. */
export const FILES_MAX = 50;
/** A listing is reused this long (typing a query asks once per keystroke). */
const CACHE_MS = 10_000;
/** Paths read from one worktree at most. */
const MAX_PATHS = 200_000;

interface Listing {
	at: number;
	items: FileHit[];
}

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

	constructor(
		lookup: (agentId: string) => Agent | undefined,
		now: () => number = Date.now,
	) {
		this.lookup = lookup;
		this.now = now;
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
		if (!listed)
			return { agent: agentId, available: false, reason: "not_git", items: [] };
		const ranked = rankFiles(listed.items, q).slice(0, FILES_MAX * 2);
		// Only what stays in the agent's folder, links resolved.
		const safe = await Promise.all(
			ranked.map(async (h) =>
				(await insideRepo(listed.base, h.path)) ? h : null,
			),
		);
		return {
			agent: agentId,
			available: true,
			items: safe.filter((h): h is FileHit => h !== null).slice(0, FILES_MAX),
		};
	}

	private async list(
		cwd: string,
	): Promise<{ base: string; items: FileHit[] } | null> {
		let base: string;
		try {
			base = await realpath(cwd);
		} catch {
			return null;
		}
		const hit = this.cache.get(base);
		if (hit && this.now() - hit.at < CACHE_MS)
			return { base, items: hit.items };
		const r = await runGit(
			base,
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ mode: "read", lane: "user" },
		);
		if (!r.ok) return null;
		const prefix = relative(r.root, base);
		if (prefix.startsWith("..")) return null;
		const lead = prefix ? `${prefix.split(sep).join("/")}/` : "";
		const files = new Set<string>();
		const dirs = new Set<string>();
		for (const raw of r.stdout.split("\0")) {
			if (files.size >= MAX_PATHS) break;
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
		this.cache.set(base, { at: this.now(), items });
		if (this.cache.size > 8)
			this.cache.delete(this.cache.keys().next().value as string);
		return { base, items };
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
