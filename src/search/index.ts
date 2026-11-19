import type { DatabaseSync } from "node:sqlite";
import { debugLog } from "../log.ts";
import { ftsExpression, matches, type Query, words } from "./text.ts";

/**
 * The message index: one row per transcript event worth finding, in the
 * `search_docs` table (store migration 8), and an engine that finds rows by
 * word. SQLite's FTS5 when the runtime has it (Node 22.16+, Node 24+, Bun);
 * else an in-memory word index built from the same rows (Node 22.13–22.15
 * ship SQLite without FTS5). The FTS5 table is never part of the schema: a
 * database made on one runtime opens on the other.
 */

export type DocRole = "user" | "agent" | "peer" | "tool";

export interface Doc {
	agentId: string;
	eventId: string;
	ts: number;
	role: DocRole;
	/** Who sent a peer message. */
	from: string | null;
	/** Already redacted. */
	text: string;
	/** The transcript page cursor whose page holds this event; null for the newest pages. */
	cursor: string | null;
}

export interface FoundDoc extends Doc {
	id: number;
}

/** Where an agent's backfill stopped. */
export interface IndexState {
	/** The transcript file indexed (null for a harness API source). */
	path: string | null;
	/** Bytes of it indexed. */
	top: number;
}

/** Candidates one query reads before scoring. */
export const CANDIDATES = 300;

interface Engine {
	readonly kind: "fts5" | "memory";
	/** A row was added or its text changed (old text given when it had one). */
	put(id: number, text: string, old: string | null): void;
	drop(id: number, text: string): void;
	/** Every row went. */
	reset(): void;
	/** Ids of rows that may match, newest first; the caller checks each. */
	find(query: Query, agentId: string | null, limit: number): number[];
}

/** True when this runtime's SQLite has FTS5. */
export function hasFts5(db: DatabaseSync): boolean {
	try {
		db.exec(
			"CREATE VIRTUAL TABLE IF NOT EXISTS temp.pulsar_fts_probe USING fts5(x)",
		);
		db.exec("DROP TABLE IF EXISTS temp.pulsar_fts_probe");
		return true;
	} catch {
		return false;
	}
}

type Row = Record<string, string | number | null>;

class FtsEngine implements Engine {
	readonly kind = "fts5" as const;
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
		const existed = Boolean(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
				)
				.get(),
		);
		db.exec(
			"CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, content='search_docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2')",
		);
		const stale = db
			.prepare("SELECT value FROM meta WHERE key = 'search_fts_stale'")
			.get() as Row | undefined;
		// Rows written without FTS5 (or before the table existed): index them all again.
		if (!existed || stale) {
			db.exec("INSERT INTO search_fts(search_fts) VALUES ('rebuild')");
			db.exec("DELETE FROM meta WHERE key = 'search_fts_stale'");
		}
	}

	put(id: number, text: string, old: string | null) {
		if (old !== null) this.drop(id, old);
		this.db
			.prepare("INSERT INTO search_fts (rowid, text) VALUES (?, ?)")
			.run(id, text);
	}

	drop(id: number, text: string) {
		this.db
			.prepare(
				"INSERT INTO search_fts (search_fts, rowid, text) VALUES ('delete', ?, ?)",
			)
			.run(id, text);
	}

	reset() {
		this.db.exec("INSERT INTO search_fts (search_fts) VALUES ('delete-all')");
	}

	find(query: Query, agentId: string | null, limit: number): number[] {
		const sql = `SELECT d.id FROM search_fts f JOIN search_docs d ON d.id = f.rowid
			WHERE search_fts MATCH ?${agentId ? " AND d.agent_id = ?" : ""}
			ORDER BY d.ts DESC LIMIT ?`;
		const args: (string | number)[] = [ftsExpression(query)];
		if (agentId) args.push(agentId);
		args.push(limit);
		return (this.db.prepare(sql).all(...args) as Row[]).map((r) =>
			Number(r.id),
		);
	}
}

/**
 * Word → row ids, built from `search_docs` on the first query and kept in
 * step with every write after that.
 */
class MemoryEngine implements Engine {
	readonly kind = "memory" as const;
	private readonly db: DatabaseSync;
	private postings: Map<string, Set<number>> | null = null;
	private marked = false;

	constructor(db: DatabaseSync) {
		this.db = db;
	}

	/** FTS5 (on a later open with a newer runtime) must index these rows again. */
	private markStale() {
		if (this.marked) return;
		this.marked = true;
		this.db
			.prepare(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('search_fts_stale', '1')",
			)
			.run();
	}

	private index(): Map<string, Set<number>> {
		if (this.postings) return this.postings;
		const map = new Map<string, Set<number>>();
		for (const r of this.db
			.prepare("SELECT id, text FROM search_docs")
			.iterate() as Iterable<Row>)
			this.add(map, Number(r.id), String(r.text));
		this.postings = map;
		return map;
	}

	private add(map: Map<string, Set<number>>, id: number, text: string) {
		for (const w of new Set(words(text))) {
			const set = map.get(w);
			if (set) set.add(id);
			else map.set(w, new Set([id]));
		}
	}

	put(id: number, text: string, old: string | null) {
		this.markStale();
		if (!this.postings) return;
		if (old !== null) this.remove(id, old);
		this.add(this.postings, id, text);
	}

	drop(id: number, text: string) {
		this.markStale();
		if (this.postings) this.remove(id, text);
	}

	reset() {
		this.markStale();
		this.postings = null;
	}

	private remove(id: number, text: string) {
		for (const w of new Set(words(text))) {
			const set = this.postings!.get(w);
			set?.delete(id);
			if (set?.size === 0) this.postings!.delete(w);
		}
	}

	find(query: Query, agentId: string | null, limit: number): number[] {
		const map = this.index();
		const last = query.terms.length - 1;
		let ids: Set<number> | null = null;
		// Rarest exact terms first; the prefix term last.
		const sets = query.terms.map((t, i) => {
			if (!(query.prefix && i === last)) return map.get(t) ?? new Set<number>();
			const union = new Set<number>();
			for (const [w, set] of map)
				if (w.startsWith(t)) for (const id of set) union.add(id);
			return union;
		});
		for (const set of sets.sort((a, b) => a.size - b.size)) {
			if (!ids) ids = new Set(set);
			else for (const id of ids) if (!set.has(id)) ids.delete(id);
			if (ids.size === 0) return [];
		}
		const all = [...(ids ?? [])];
		const out: { id: number; ts: number }[] = [];
		for (let i = 0; i < all.length; i += 500) {
			const chunk = all.slice(i, i + 500);
			const rows = this.db
				.prepare(
					`SELECT id, ts, agent_id FROM search_docs WHERE id IN (${chunk.map(() => "?").join(",")})`,
				)
				.all(...chunk) as Row[];
			for (const r of rows)
				if (!agentId || r.agent_id === agentId)
					out.push({ id: Number(r.id), ts: Number(r.ts) });
		}
		return out
			.sort((a, b) => b.ts - a.ts)
			.slice(0, limit)
			.map((r) => r.id);
	}
}

function toDoc(r: Row): FoundDoc {
	return {
		id: Number(r.id),
		agentId: String(r.agent_id),
		eventId: String(r.event_id),
		ts: Number(r.ts),
		role: String(r.role) as DocRole,
		from: (r.sender as string | null) ?? null,
		text: String(r.text),
		cursor: (r.cursor as string | null) ?? null,
	};
}

export class MessageIndex {
	private readonly db: DatabaseSync;
	private readonly engine: Engine;

	constructor(db: DatabaseSync, opts: { engine?: "fts5" | "memory" } = {}) {
		this.db = db;
		const want = opts.engine ?? (hasFts5(db) ? "fts5" : "memory");
		let engine: Engine;
		try {
			engine = want === "fts5" ? new FtsEngine(db) : new MemoryEngine(db);
		} catch (e) {
			debugLog(`search: FTS5 unavailable (${(e as Error).message})`);
			engine = new MemoryEngine(db);
		}
		this.engine = engine;
	}

	/** Which engine finds rows. */
	get kind(): "fts5" | "memory" {
		return this.engine.kind;
	}

	/**
	 * Adds or updates events, in one transaction. A known event keeps its row:
	 * new text replaces the old (a block that grew), and a null cursor never
	 * erases a known one (a live event is the same event a page held).
	 */
	upsert(docs: Doc[]) {
		if (docs.length === 0) return;
		const get = this.db.prepare(
			"SELECT id, text, cursor FROM search_docs WHERE agent_id = ? AND event_id = ?",
		);
		const insert = this.db.prepare(
			"INSERT INTO search_docs (agent_id, event_id, ts, role, sender, text, cursor) VALUES (?, ?, ?, ?, ?, ?, ?)",
		);
		const update = this.db.prepare(
			"UPDATE search_docs SET ts = ?, role = ?, sender = ?, text = ?, cursor = ? WHERE id = ?",
		);
		this.tx(() => {
			for (const d of docs) {
				const old = get.get(d.agentId, d.eventId) as Row | undefined;
				if (!old) {
					const r = insert.run(
						d.agentId,
						d.eventId,
						d.ts,
						d.role,
						d.from,
						d.text,
						d.cursor,
					);
					this.engine.put(Number(r.lastInsertRowid), d.text, null);
					continue;
				}
				const cursor = d.cursor ?? (old.cursor as string | null);
				update.run(d.ts, d.role, d.from, d.text, cursor, Number(old.id));
				if (old.text !== d.text)
					this.engine.put(Number(old.id), d.text, String(old.text));
			}
		});
	}

	/** Rows that may match, newest first, at most `limit`; every row returned has every term. */
	find(
		query: Query,
		opts: { agentId?: string | null; limit?: number } = {},
	): FoundDoc[] {
		const ids = this.engine.find(
			query,
			opts.agentId ?? null,
			opts.limit ?? CANDIDATES,
		);
		if (ids.length === 0) return [];
		const rows = this.db
			.prepare(
				`SELECT * FROM search_docs WHERE id IN (${ids.map(() => "?").join(",")})`,
			)
			.all(...ids) as Row[];
		return rows
			.map(toDoc)
			.filter((d) => matches(query, d.text))
			.sort((a, b) => b.ts - a.ts);
	}

	/** Deletes rows matching `where` (on `search_docs`), a chunk per transaction. */
	private deleteWhere(where: string, ...args: (string | number)[]): number {
		let n = 0;
		for (;;) {
			const rows = this.db
				.prepare(`SELECT id, text FROM search_docs WHERE ${where} LIMIT 500`)
				.all(...args) as Row[];
			if (rows.length === 0) return n;
			this.tx(() => {
				const del = this.db.prepare("DELETE FROM search_docs WHERE id = ?");
				for (const r of rows) {
					this.engine.drop(Number(r.id), String(r.text));
					del.run(Number(r.id));
				}
			});
			n += rows.length;
		}
	}

	/** Forgets one agent's events and where its backfill stopped. */
	forgetAgent(agentId: string): number {
		const n = this.deleteWhere("agent_id = ?", agentId);
		this.db.prepare("DELETE FROM search_state WHERE agent_id = ?").run(agentId);
		return n;
	}

	/** Forgets events older than `cutoff`. */
	prune(cutoff: number): number {
		return this.deleteWhere("ts < ?", cutoff);
	}

	/** Forgets everything. */
	clear() {
		this.tx(() => {
			this.db.exec("DELETE FROM search_docs");
			this.db.exec("DELETE FROM search_state");
			this.engine.reset();
		});
	}

	/** Indexed events (all agents, or one). */
	count(agentId?: string): number {
		const r = (
			agentId
				? this.db
						.prepare("SELECT COUNT(*) n FROM search_docs WHERE agent_id = ?")
						.get(agentId)
				: this.db.prepare("SELECT COUNT(*) n FROM search_docs").get()
		) as Row;
		return Number(r.n);
	}

	state(agentId: string): IndexState | null {
		const r = this.db
			.prepare("SELECT path, top FROM search_state WHERE agent_id = ?")
			.get(agentId) as Row | undefined;
		return r
			? { path: (r.path as string | null) ?? null, top: Number(r.top) }
			: null;
	}

	setState(agentId: string, s: IndexState) {
		this.db
			.prepare(
				`INSERT INTO search_state (agent_id, path, top, updated_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET path = excluded.path, top = excluded.top, updated_at = excluded.updated_at`,
			)
			.run(agentId, s.path, s.top, Date.now());
	}

	private tx(fn: () => void) {
		// A savepoint nests inside any transaction the caller holds.
		this.db.exec("SAVEPOINT search_write");
		try {
			fn();
			this.db.exec("RELEASE search_write");
		} catch (e) {
			this.db.exec("ROLLBACK TO search_write");
			this.db.exec("RELEASE search_write");
			throw e;
		}
	}
}
