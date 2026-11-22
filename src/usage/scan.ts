import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { configDir } from "../harnesses/claude-ident.ts";
import type { LimitState } from "../http/wire.ts";
import { lazyCrypto } from "../lazy.ts";
import type { Store } from "../store.ts";
import { answeredKey, mergeLimits, saveLimits } from "./limits.ts";
import {
	type FileState,
	parseLine,
	type UsageHarness,
	type UsageRecord,
} from "./parse.ts";

/** Where each harness keeps its session files (null: don't scan it). */
export type UsageRoots = Record<UsageHarness, string | null>;

/** The harnesses' own folders, read at call time (tests point HOME elsewhere). */
export function defaultRoots(): UsageRoots {
	const home = homedir();
	return {
		claude: join(configDir(), "projects"),
		codex: join(process.env.CODEX_HOME ?? join(home, ".codex"), "sessions"),
		pi: join(home, ".pi", "agent", "sessions"),
		omp: join(home, ".omp", "agent", "sessions"),
	};
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Usage older than this is not read, and rows older than `KEEP_MS` are pruned. */
export const WINDOW_MS = 90 * DAY;
const KEEP_MS = 100 * DAY;
const CHUNK = 1 << 20;
/** Commit progress (rows + offset) at least this often in a long file. */
const COMMIT_BYTES = 32 << 20;
/** A single line longer than this is skipped (no usage line is near it). */
const MAX_LINE = 64 << 20;
/** The one-time limit backfill: files changed this recently, this much of each. */
const BACKFILL_MS = 8 * DAY;
const BACKFILL_BYTES = 256 * 1024;
const BACKFILL_CODEX_BYTES = 8 << 20;
const BACKFILL_KEY = "usage.limitsBackfilled";

interface Found {
	path: string;
	harness: UsageHarness;
	/** The session the file belongs to (a subagent's file: its parent's). */
	session: string;
	size: number;
	mtime: number;
}

interface FileRow {
	offset: number;
	size: number;
	mtime: number;
	state: FileState;
}

type Row = Record<string, string | number | null>;

async function dir(path: string) {
	try {
		return await readdir(path, { withFileTypes: true });
	} catch {
		return [];
	}
}

/** `…_<id>.jsonl` (pi/omp) or `rollout-…-<uuid>.jsonl` (Codex): the session id. */
function idFromName(name: string, harness: UsageHarness): string {
	const stem = name.replace(/\.jsonl$/, "");
	if (harness === "codex") {
		const m =
			/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(
				stem,
			);
		return m ? m[1]! : stem;
	}
	if (harness === "claude") return stem;
	const us = stem.indexOf("_");
	return us >= 0 ? stem.slice(us + 1) : stem;
}

/**
 * Reads session files incrementally into `usage_hourly`: each file's byte
 * offset and parser state are saved with the rows they produced, in one
 * transaction, so a re-scan only reads what was appended and never counts
 * a line twice. Provider message ids are counted once across all files.
 */
/** Read sizes, and a hook after each commit (tests: small chunks, a crash mid-file). */
export interface ScanTuning {
	chunkBytes?: number;
	commitBytes?: number;
	onCommit?: () => void;
}

export class UsageScanner {
	private readonly store: Store;
	private readonly roots: () => UsageRoots;
	private running: Promise<void> | null = null;
	/** When the last full scan finished (ms), null before the first. */
	scannedAt: number | null = null;

	private readonly chunk: number;
	private readonly commitBytes: number;
	private readonly onCommit: (() => void) | undefined;

	constructor(
		store: Store,
		roots: () => UsageRoots = defaultRoots,
		tuning: ScanTuning = {},
	) {
		this.store = store;
		this.roots = roots;
		this.chunk = tuning.chunkBytes ?? CHUNK;
		this.commitBytes = tuning.commitBytes ?? COMMIT_BYTES;
		this.onCommit = tuning.onCommit;
	}

	get scanning(): boolean {
		return this.running !== null;
	}

	/** One scan at a time; a call during a scan shares it. */
	scan(now = Date.now()): Promise<void> {
		this.running ??= this.scanOnce(now).finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async scanOnce(now: number) {
		const since = now - WINDOW_MS;
		const roots = this.roots();
		const found: Found[] = [];
		for (const h of ["claude", "codex", "pi", "omp"] as const) {
			const root = roots[h];
			if (root) found.push(...(await this.find(h, root, since)));
		}
		// Newest first: today's numbers show before the backlog is read.
		found.sort((a, b) => b.mtime - a.mtime);
		const known = this.knownFiles();
		await this.backfillLimits(found, known, now);
		for (const f of found) {
			const k = known.get(f.path);
			if (k && k.size === f.size && k.mtime === f.mtime) continue;
			await this.readFile(f, k, since);
		}
		this.prune(now);
		this.scannedAt = Date.now();
	}

	/**
	 * Once per database: limit readings for files read before Pulsar kept
	 * them (their offsets are already at the end, so a normal scan would
	 * show no limits until the harness writes again). Reads the last
	 * `BACKFILL_BYTES` before each recent file's saved offset for limit
	 * lines and answers only: no tokens are counted, no offset moves. The
	 * readings keep their own times, so old ones do not warn.
	 */
	private async backfillLimits(
		found: Found[],
		known: Map<string, FileRow>,
		now: number,
	) {
		if (this.store.metaGet(BACKFILL_KEY)) return;
		const batch = new Batch();
		for (const f of found) {
			const k = known.get(f.path);
			const end = Math.min(k?.offset ?? 0, f.size);
			if (end <= 0 || f.mtime < now - BACKFILL_MS) continue;
			// Codex writes its limits on every token count: read back until one
			// turns up (long tool output can hide it). The others: the tail only.
			const cap = f.harness === "codex" ? BACKFILL_CODEX_BYTES : BACKFILL_BYTES;
			const fh = await open(f.path, "r").catch(() => null);
			if (!fh) continue;
			try {
				let to = end;
				while (to > 0) {
					const from = Math.max(0, to - BACKFILL_BYTES, end - cap);
					const buf = Buffer.alloc(to - from);
					await fh.read(buf, 0, buf.length, from);
					// Whole lines only: the cut line is read with the next window.
					const cut = from > 0 ? buf.indexOf(10) + 1 : 0;
					if (from > 0 && cut === 0) break;
					let seen = 0;
					const onLimit = (l: LimitState) => {
						seen++;
						batch.onLimit(l);
					};
					for (const line of buf.subarray(cut).toString("utf8").split("\n")) {
						if (!line) continue;
						const rec = parseLine(f.harness, line, {}, onLimit);
						if (rec) batch.answer(rec, f.harness);
					}
					// Found one, or read as far back as allowed.
					if (f.harness !== "codex" || seen > 0 || from <= end - cap) break;
					to = from + cut;
				}
			} finally {
				await fh.close();
			}
		}
		const db = this.store.db;
		db.exec("BEGIN IMMEDIATE");
		try {
			if (batch.limits.size || batch.answered.size)
				saveLimits(this.store, batch.limits.values(), batch.answered);
			this.store.metaSet(BACKFILL_KEY, String(now));
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	}

	private async find(
		harness: UsageHarness,
		root: string,
		since: number,
	): Promise<Found[]> {
		const out: Found[] = [];
		const add = async (path: string, session: string) => {
			try {
				const s = await stat(path);
				if (s.isFile() && s.mtimeMs >= since)
					out.push({
						path,
						harness,
						session,
						size: s.size,
						mtime: Math.floor(s.mtimeMs),
					});
			} catch {}
		};
		const jsonl = (n: string) => n.endsWith(".jsonl");
		if (harness === "codex") {
			// sessions/YYYY/MM/DD/rollout-….jsonl; whole days before `since` are skipped.
			const cutoff = new Date(since - DAY).toISOString().slice(0, 10);
			for (const y of await dir(root)) {
				if (!y.isDirectory()) continue;
				for (const m of await dir(join(root, y.name))) {
					if (!m.isDirectory()) continue;
					for (const d of await dir(join(root, y.name, m.name))) {
						if (!d.isDirectory()) continue;
						if (`${y.name}-${m.name}-${d.name}` < cutoff) continue;
						const day = join(root, y.name, m.name, d.name);
						for (const f of await dir(day))
							if (f.isFile() && jsonl(f.name))
								await add(join(day, f.name), idFromName(f.name, harness));
					}
				}
			}
			return out;
		}
		// Claude: projects/<folder>/<session>.jsonl and
		// <session>/subagents/agent-*.jsonl. pi/omp: sessions/<folder>/<time>_<id>.jsonl
		// and subagents under <time>_<id>/. Subagents count toward their parent.
		for (const folder of await dir(root)) {
			if (!folder.isDirectory()) continue;
			const fdir = join(root, folder.name);
			for (const e of await dir(fdir)) {
				if (e.isFile() && jsonl(e.name)) {
					await add(join(fdir, e.name), idFromName(e.name, harness));
					continue;
				}
				if (!e.isDirectory()) continue;
				const parent = idFromName(e.name, harness);
				const sub =
					harness === "claude"
						? join(fdir, e.name, "subagents")
						: join(fdir, e.name);
				for (const s of await dir(sub))
					if (s.isFile() && jsonl(s.name)) await add(join(sub, s.name), parent);
			}
		}
		return out;
	}

	private knownFiles(): Map<string, FileRow> {
		const rows = this.store.db
			.prepare("SELECT path, offset, size, mtime, state FROM usage_files")
			.all() as Row[];
		const out = new Map<string, FileRow>();
		for (const r of rows) out.set(String(r.path), fileRow(r));
		return out;
	}

	/** Reads `f` from its saved offset to its last complete line. */
	private async readFile(f: Found, known: FileRow | undefined, since: number) {
		let offset = known?.offset ?? 0;
		let state: FileState = known?.state ?? {};
		// Shorter than what was read: the file was replaced. Start over;
		// message ids already counted stay counted.
		if (offset > f.size) {
			offset = 0;
			state = {};
		}
		const fh = await open(f.path, "r").catch(() => null);
		if (!fh) return;
		try {
			const buf = Buffer.alloc(this.chunk);
			let carry: Buffer[] = [];
			let carryLen = 0;
			let pos = offset;
			let batch = new Batch();
			let sinceCommit = 0;
			for (;;) {
				const chunkAt = pos;
				const { bytesRead } = await fh.read(buf, 0, this.chunk, pos);
				if (bytesRead === 0) break;
				pos += bytesRead;
				let start = 0;
				for (;;) {
					const nl = buf.indexOf(10, start);
					if (nl < 0 || nl >= bytesRead) break;
					const piece = buf.subarray(start, nl);
					let line = "";
					if (!carryLen) line = piece.toString("utf8");
					else if (carryLen + piece.length <= MAX_LINE)
						line = Buffer.concat([...carry, piece]).toString("utf8");
					carry = [];
					carryLen = 0;
					start = nl + 1;
					offset = chunkAt + start;
					const rec = line
						? parseLine(f.harness, line, state, batch.onLimit)
						: null;
					if (rec && rec.t >= since) batch.add(rec, state, f.harness);
				}
				if (start < bytesRead) {
					if (carryLen + bytesRead - start <= MAX_LINE)
						carry.push(Buffer.from(buf.subarray(start, bytesRead)));
					carryLen += bytesRead - start;
				}
				sinceCommit += bytesRead;
				if (sinceCommit >= this.commitBytes) {
					// Not done: a size of -1 makes the next scan read on from here.
					this.commit(f, offset, state, batch, -1);
					batch = new Batch();
					sinceCommit = 0;
				}
			}
			this.commit(f, offset, state, batch, f.size);
		} finally {
			await fh.close();
		}
	}

	/** Rows, seen ids and the file's offset, together. */
	private commit(
		f: Found,
		offset: number,
		state: FileState,
		batch: Batch,
		size: number,
	) {
		const db = this.store.db;
		db.exec("BEGIN IMMEDIATE");
		try {
			const seen = db.prepare(
				"INSERT OR IGNORE INTO usage_seen (key, at) VALUES (?, ?)",
			);
			const upsert = db.prepare(`
INSERT INTO usage_hourly (hour, harness, model, project, session, input, cache_read, cache_write_5m, cache_write_1h, output, records)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (hour, harness, model, project, session) DO UPDATE SET
	input = input + excluded.input,
	cache_read = cache_read + excluded.cache_read,
	cache_write_5m = cache_write_5m + excluded.cache_write_5m,
	cache_write_1h = cache_write_1h + excluded.cache_write_1h,
	output = output + excluded.output,
	records = records + excluded.records`);
			const sums = new Map<
				string,
				UsageRecord & { hour: number; n: number; project: string }
			>();
			for (const { rec, project } of batch.items) {
				if (rec.dedupeId) {
					const r = seen.run(dedupeKey(f.harness, rec.dedupeId), rec.t);
					if (Number(r.changes) === 0) continue;
				}
				const hour = Math.floor(rec.t / HOUR) * HOUR;
				const key = `${hour}\0${rec.model}\0${project}`;
				const s = sums.get(key);
				if (!s) {
					sums.set(key, { ...rec, hour, n: 1, project });
					continue;
				}
				s.input += rec.input;
				s.cacheRead += rec.cacheRead;
				s.cacheWrite5m += rec.cacheWrite5m;
				s.cacheWrite1h += rec.cacheWrite1h;
				s.output += rec.output;
				s.n++;
			}
			for (const s of sums.values())
				upsert.run(
					s.hour,
					f.harness,
					s.model,
					s.project,
					f.session,
					s.input,
					s.cacheRead,
					s.cacheWrite5m,
					s.cacheWrite1h,
					s.output,
					s.n,
				);
			db.prepare(`
INSERT INTO usage_files (path, harness, session, offset, size, mtime, state, model, context_used, context_window, last_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (path) DO UPDATE SET
	offset = excluded.offset, size = excluded.size, mtime = excluded.mtime,
	state = excluded.state, model = excluded.model,
	context_used = excluded.context_used, context_window = excluded.context_window,
	last_at = COALESCE(excluded.last_at, usage_files.last_at)`).run(
				f.path,
				f.harness,
				f.session,
				offset,
				// A partial last line waits: the writer finishing it changes size and mtime.
				size,
				f.mtime,
				JSON.stringify(state),
				state.model ?? null,
				state.context?.used ?? null,
				state.context?.window ?? null,
				batch.lastAt,
			);
			if (batch.limits.size || batch.answered.size)
				saveLimits(this.store, batch.limits.values(), batch.answered);
			db.exec("COMMIT");
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
		this.onCommit?.();
	}

	private prune(now: number) {
		const before = now - KEEP_MS;
		const db = this.store.db;
		db.prepare("DELETE FROM usage_hourly WHERE hour < ?").run(before);
		db.prepare("DELETE FROM usage_seen WHERE at < ?").run(before);
		db.prepare("DELETE FROM usage_files WHERE mtime < ?").run(before);
	}
}

/** What one commit adds: records with the folder they ran in, and the newest limit readings. */
class Batch {
	items: { rec: UsageRecord; project: string }[] = [];
	lastAt: number | null = null;
	limits = new Map<string, LimitState>();
	/** The newest answer per harness and account (a reached limit before it is over). */
	answered = new Map<string, number>();
	readonly onLimit = (s: LimitState) => mergeLimits(this.limits, [s]);
	add(rec: UsageRecord, state: FileState, harness: UsageHarness) {
		this.items.push({ rec, project: state.cwd ?? "" });
		this.answer(rec, harness);
		if (this.lastAt === null || rec.t > this.lastAt) this.lastAt = rec.t;
	}
	/** A model answered at `rec.t` (clears an earlier hard stop). */
	answer(rec: UsageRecord, harness: UsageHarness) {
		const k = answeredKey(harness, rec.account ?? "");
		if (rec.t > (this.answered.get(k) ?? 0)) this.answered.set(k, rec.t);
	}
}

function fileRow(r: Row): FileRow {
	let state: FileState = {};
	try {
		state = JSON.parse(String(r.state ?? "{}")) as FileState;
	} catch {}
	return {
		offset: Number(r.offset) || 0,
		size: Number(r.size),
		mtime: Number(r.mtime),
		state,
	};
}

/** A 52-bit integer key for a message id (compact; collisions are negligible). */
function dedupeKey(harness: UsageHarness, id: string): number {
	const h = lazyCrypto().createHash("sha1").update(`${harness}:${id}`).digest();
	return h.readUIntBE(0, 6) * 16 + (h[6]! >> 4);
}
