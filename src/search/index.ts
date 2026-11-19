import type { DatabaseSync } from "node:sqlite";
import { debugLog } from "../log.ts";
import { ftsExpression, matches, type Query, words } from "./text.ts";

/**
 * The message index: one row per transcript event worth finding, in the
 * `search_docs` table (store migration 10), and an engine that finds rows by
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

/**
 * What the stored rows were made with. Bump it when what is stored changes
 * (redaction, which events are kept): rows from another version are dropped
 * on open and indexed again. 2: names like GITHUB_TOKEN= and Basic auth
 * are redacted.
 */
export const INDEX_VERSION = 2;
/** Rows deleted per transaction (between yields to the event loop). */
const DELETE_CHUNK = 100;
/** Candidates one query reads before scoring. */
export const CANDIDATES = 300;
/**
 * Matches read, most recently indexed first, before the newest by time are
 * picked: a word in every message (`the`) costs this many rows, not all.
 */
export const RECENT = 10_000;

/** What an engine indexes of a row. */
interface Indexed {
	text: string;
	agentId: string;
}

interface Engine {
	readonly kind: "fts5" | "memory";
	/** A row was added or its text changed (old values given when it had them). */
	put(id: number, row: Indexed, old: Indexed | null): void;
	drop(id: number, row: Indexed): void;
	/** Every row went. */
	reset(): void;
	/** Ids of rows that may match (at most `RECENT`, recently indexed first); the caller checks each. */
	find(query: Query, agentId: string | null): number[];
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

/** An agent id as one FTS5 phrase over its words (the SQL checks the exact id). */
function agentPhrase(agentId: string): string {
	return `"${words(agentId).join(" ").replaceAll('"', '""')}"`;
}

class FtsEngine implements Engine {
	readonly kind = "fts5" as const;
	private readonly db: DatabaseSync;

	constructor(db: DatabaseSync) {
		this.db = db;
		let existed = Boolean(
			db
				.prepare(
					"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_fts'",
				)
				.get(),
		);
		// A table from before agent ids were indexed: make it again.
		if (
			existed &&
			!(db.prepare("PRAGMA table_info(search_fts)").all() as Row[]).some(
				(c) => c.name === "agent_id",
			)
		) {
			db.exec("DROP TABLE search_fts");
			existed = false;
		}
		db.exec(
			"CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(text, agent_id, content='search_docs', content_rowid='id', tokenize='unicode61 remove_diacritics 2')",
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

	put(id: number, row: Indexed, old: Indexed | null) {
		if (old !== null) this.drop(id, old);
		this.db
			.prepare(
				"INSERT INTO search_fts (rowid, text, agent_id) VALUES (?, ?, ?)",
			)
			.run(id, row.text, row.agentId);
	}

	drop(id: number, row: Indexed) {
		this.db
			.prepare(
				"INSERT INTO search_fts (search_fts, rowid, text, agent_id) VALUES ('delete', ?, ?, ?)",
			)
			.run(id, row.text, row.agentId);
	}

	reset() {
		this.db.exec("INSERT INTO search_fts (search_fts) VALUES ('delete-all')");
	}

	find(query: Query, agentId: string | null): number[] {
		const terms = `text : (${ftsExpression(query)})`;
		const match = agentId
			? `agent_id : ${agentPhrase(agentId)} AND ${terms}`
			: terms;
		// FTS5 walks rowids in order, so the LIMIT stops it early.
		return (
			this.db
				.prepare(
					"SELECT rowid FROM search_fts WHERE search_fts MATCH ? ORDER BY rowid DESC LIMIT ?",
				)
				.all(match, RECENT) as Row[]
		).map((r) => Number(r.rowid));
	}
}

/** The postings key of an agent's rows (never a word: words have no NUL). */
const agentKey = (agentId: string) => `\u0000${agentId}`;

/**
 * Word → row ids, kept in step with every write, and loaded from
 * `search_docs` in the background a chunk at a time (a query before the load
 * finishes sees what is loaded so far).
 */
class MemoryEngine implements Engine {
	readonly kind = "memory" as const;
	private readonly db: DatabaseSync;
	private postings = new Map<string, Set<number>>();
	private marked = false;
	/** Bumps on reset, so a load that started before stops. */
	private generation = 0;

	constructor(db: DatabaseSync) {
		this.db = db;
		setImmediate(() => void this.load());
	}

	/** Reads every row into the postings, yielding between chunks. */
	private async load() {
		const gen = this.generation;
		let after = 0;
		for (;;) {
			if (gen !== this.generation) return;
			let rows: Row[];
			try {
				rows = this.db
					.prepare(
						"SELECT id, text, agent_id FROM search_docs WHERE id > ? ORDER BY id LIMIT 250",
					)
					.all(after) as Row[];
			} catch {
				return; // The database closed.
			}
			if (rows.length === 0) return;
			for (const r of rows)
				this.add(this.postings, Number(r.id), {
					text: String(r.text),
					agentId: String(r.agent_id),
				});
			after = Number(rows[rows.length - 1]!.id);
			await new Promise<void>((r) => setImmediate(r));
		}
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

	private keys(row: Indexed): Set<string> {
		const keys = new Set(words(row.text));
		keys.add(agentKey(row.agentId));
		return keys;
	}

	private add(map: Map<string, Set<number>>, id: number, row: Indexed) {
		for (const k of this.keys(row)) {
			const set = map.get(k);
			if (set) set.add(id);
			else map.set(k, new Set([id]));
		}
	}

	put(id: number, row: Indexed, old: Indexed | null) {
		this.markStale();
		if (old !== null) this.remove(id, old);
		this.add(this.postings, id, row);
	}

	drop(id: number, row: Indexed) {
		this.markStale();
		this.remove(id, row);
	}

	reset() {
		this.markStale();
		this.generation++;
		this.postings = new Map();
	}

	private remove(id: number, row: Indexed) {
		for (const k of this.keys(row)) {
			const set = this.postings.get(k);
			set?.delete(id);
			if (set?.size === 0) this.postings.delete(k);
		}
	}

	find(query: Query, agentId: string | null): number[] {
		const map = this.postings;
		const last = query.terms.length - 1;
		const sets = query.terms.map((t, i) => {
			if (!(query.prefix && i === last)) return map.get(t) ?? new Set<number>();
			const union = new Set<number>();
			for (const [w, set] of map)
				if (w.startsWith(t)) for (const id of set) union.add(id);
			return union;
		});
		if (agentId) sets.push(map.get(agentKey(agentId)) ?? new Set<number>());
		// Smallest set first.
		let ids: Set<number> | null = null;
		for (const set of sets.sort((a, b) => a.size - b.size)) {
			if (!ids) ids = new Set(set);
			else for (const id of ids) if (!set.has(id)) ids.delete(id);
			if (ids.size === 0) return [];
		}
		return [...(ids ?? [])].sort((a, b) => b - a).slice(0, RECENT);
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
		// Rows from an older index (an older redaction): drop them; the backfill
		// reads the transcripts again.
		const stored = db
			.prepare("SELECT value FROM meta WHERE key = 'search_index_version'")
			.get() as Row | undefined;
		if (stored?.value !== String(INDEX_VERSION)) {
			this.clear();
			db.prepare(
				"INSERT OR REPLACE INTO meta (key, value) VALUES ('search_index_version', ?)",
			).run(String(INDEX_VERSION));
		}
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
					this.engine.put(
						Number(r.lastInsertRowid),
						{ text: d.text, agentId: d.agentId },
						null,
					);
					continue;
				}
				const cursor = d.cursor ?? (old.cursor as string | null);
				update.run(d.ts, d.role, d.from, d.text, cursor, Number(old.id));
				if (old.text !== d.text)
					this.engine.put(
						Number(old.id),
						{ text: d.text, agentId: d.agentId },
						{ text: String(old.text), agentId: d.agentId },
					);
			}
		});
	}

	/** Rows that may match, newest first, at most `limit`; every row returned has every term. */
	find(
		query: Query,
		opts: { agentId?: string | null; limit?: number } = {},
	): FoundDoc[] {
		const agentId = opts.agentId ?? null;
		const ids = this.engine.find(query, agentId);
		if (ids.length === 0) return [];
		// The newest by time among the candidates; only those are read whole.
		const rows = this.db
			.prepare(
				`SELECT * FROM search_docs WHERE id IN (
					SELECT id FROM search_docs WHERE id IN (SELECT value FROM json_each(?))${agentId ? " AND agent_id = ?" : ""}
					ORDER BY ts DESC LIMIT ?)`,
			)
			.all(
				JSON.stringify(ids),
				...(agentId ? [agentId] : []),
				opts.limit ?? CANDIDATES,
			) as Row[];
		return rows
			.map(toDoc)
			.filter((d) => matches(query, d.text))
			.sort((a, b) => b.ts - a.ts);
	}

	/**
	 * Deletes rows matching `where` (on `search_docs`): a small chunk per
	 * transaction, yielding to the event loop between chunks (each delete
	 * re-reads the row's text for FTS5).
	 */
	private async deleteWhere(
		where: string,
		...args: (string | number)[]
	): Promise<number> {
		let n = 0;
		for (;;) {
			const rows = this.db
				.prepare(
					`SELECT id, text, agent_id FROM search_docs WHERE ${where} LIMIT ${DELETE_CHUNK}`,
				)
				.all(...args) as Row[];
			if (rows.length === 0) return n;
			this.tx(() => {
				const del = this.db.prepare("DELETE FROM search_docs WHERE id = ?");
				for (const r of rows) {
					this.engine.drop(Number(r.id), {
						text: String(r.text),
						agentId: String(r.agent_id),
					});
					del.run(Number(r.id));
				}
			});
			n += rows.length;
			await new Promise<void>((r) => setImmediate(r));
		}
	}

	/** Forgets one agent's events and where its backfill stopped. */
	async forgetAgent(agentId: string): Promise<number> {
		this.db.prepare("DELETE FROM search_state WHERE agent_id = ?").run(agentId);
		return this.deleteWhere("agent_id = ?", agentId);
	}

	/** Forgets events older than `cutoff`. */
	prune(cutoff: number): Promise<number> {
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
