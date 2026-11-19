import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { daemonLog } from "./log.ts";
import type { Agent, Message, Receipt, ReceiptState } from "./types.ts";

// node:sqlite still prints an ExperimentalWarning on some Node versions.
// Silence only that one warning so it never lands in an MCP client's stderr log.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
	const text = typeof warning === "string" ? warning : warning.message;
	if (text.includes("SQLite")) return;
	return (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

/** Connection settings; run on every open, outside any transaction. */
const PRAGMAS = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 2000;
`;

/**
 * Schema version 1: the 1.x tables. A database with these tables and
 * `user_version` 0 (every 1.x install) is version 1.
 */
const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS messages (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	from_id TEXT NOT NULL,
	from_name TEXT NOT NULL,
	to_spec TEXT NOT NULL,
	body TEXT NOT NULL,
	priority TEXT NOT NULL,
	reply_to TEXT,
	expect_reply INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id);
CREATE TABLE IF NOT EXISTS receipts (
	message_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	agent_name TEXT NOT NULL,
	state TEXT NOT NULL,
	via TEXT,
	detail TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (message_id, agent_id)
);
CREATE INDEX IF NOT EXISTS receipts_agent ON receipts(agent_id, state);
CREATE TABLE IF NOT EXISTS identities (
	agent_id TEXT PRIMARY KEY,
	name TEXT,
	tags TEXT NOT NULL DEFAULT '[]',
	summary TEXT,
	inbound TEXT,
	updated_at INTEGER NOT NULL
);
`;

/**
 * A step that must hold whatever order branches merged in: `ensure` checks
 * for its own objects and adds what is missing. It runs when the step is
 * reached and again on every open, so a database that reached a later
 * version before this step existed still gets its tables and columns.
 */
export interface EnsureStep {
	ensure: (db: DatabaseSyncType) => void;
}

export type MigrationStep = string | EnsureStep;

/** True when `table` has `column` (for ensure steps before an ALTER TABLE). */
function hasColumn(db: DatabaseSyncType, table: string, column: string) {
	return (db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).some(
		(c) => c.name === column,
	);
}

/**
 * Migrations by `PRAGMA user_version`: entry i takes the schema from version
 * i + 1 to i + 2. Additive only (new tables, new columns with defaults), so
 * an older pulsar can still open a newer database.
 */
export const MIGRATIONS: MigrationStep[] = [
	// 2: machine id, message origin, and the tables the pool uses.
	`
CREATE TABLE IF NOT EXISTS meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
);
ALTER TABLE messages ADD COLUMN origin_machine TEXT DEFAULT NULL;
ALTER TABLE messages ADD COLUMN received_at INTEGER NOT NULL DEFAULT 0;
UPDATE messages SET received_at = created_at;
CREATE TABLE IF NOT EXISTS outbox (
	peer_machine TEXT NOT NULL,
	message_id TEXT NOT NULL,
	target_ids TEXT NOT NULL DEFAULT '[]',
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	PRIMARY KEY (peer_machine, message_id)
);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox(next_attempt_at);
CREATE TABLE IF NOT EXISTS peers (
	machine_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	node TEXT,
	dns_name TEXT,
	allowed INTEGER NOT NULL DEFAULT 0,
	pulsar_version TEXT,
	fed_protocol TEXT,
	last_seen INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
	credential_id TEXT PRIMARY KEY,
	public_key BLOB NOT NULL,
	login TEXT NOT NULL,
	rp_id TEXT NOT NULL,
	sign_count INTEGER NOT NULL DEFAULT 0,
	transports TEXT NOT NULL DEFAULT '[]',
	label TEXT,
	created_at INTEGER NOT NULL,
	last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS approvals (
	id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL,
	tool TEXT NOT NULL,
	input TEXT NOT NULL,
	input_hash TEXT NOT NULL,
	state TEXT NOT NULL DEFAULT 'pending',
	decision TEXT,
	note TEXT,
	decided_by TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS approvals_state ON approvals(state, expires_at);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	at INTEGER NOT NULL,
	principal TEXT NOT NULL,
	op TEXT NOT NULL,
	target TEXT,
	detail TEXT,
	ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS audit_at ON audit(at);
`,
	// 3: federation state that must survive a restart: who sent each outbox
	// message, and the copies peers delivered here whose receipts go back.
	{
		ensure: (db) => {
			if (!hasColumn(db, "outbox", "sender"))
				db.exec("ALTER TABLE outbox ADD COLUMN sender TEXT DEFAULT NULL");
			// The port a peer's app serves on, bound at first link (exact WebAuthn origin).
			if (!hasColumn(db, "peers", "port"))
				db.exec("ALTER TABLE peers ADD COLUMN port INTEGER DEFAULT NULL");
			db.exec(`
CREATE TABLE IF NOT EXISTS fed_tracking (
	message_id TEXT PRIMARY KEY,
	machine_id TEXT NOT NULL,
	targets TEXT NOT NULL DEFAULT '[]',
	sig TEXT NOT NULL DEFAULT '',
	until INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fed_tracking_until ON fed_tracking(until);
CREATE TABLE IF NOT EXISTS pool_members (
	node_id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	login TEXT,
	verdict TEXT NOT NULL,
	at INTEGER NOT NULL
);
`);
		},
	},
	// 4: what an approval card shows and how a prompt ended; Web Push
	// subscriptions. An ensure step, so it holds in any merge order.
	{
		ensure: (db) => {
			for (const col of [
				"harness",
				"session_id",
				"prompt_id",
				"cwd",
				"branch",
				"session_grant",
				"answered_by",
				"decided_device",
				"decided_method",
			])
				if (!hasColumn(db, "approvals", col))
					db.exec(`ALTER TABLE approvals ADD COLUMN ${col} TEXT DEFAULT NULL`);
			// Subscriptions made from a passkey session are never evicted.
			const pushCol = () =>
				hasColumn(db, "push_subscriptions", "passkey_session") ||
				db.exec(
					"ALTER TABLE push_subscriptions ADD COLUMN passkey_session INTEGER NOT NULL DEFAULT 0",
				);
			db.exec(`
CREATE INDEX IF NOT EXISTS approvals_agent ON approvals(agent_id, state);
CREATE TABLE IF NOT EXISTS push_subscriptions (
	endpoint TEXT PRIMARY KEY,
	p256dh TEXT NOT NULL,
	auth TEXT NOT NULL,
	login TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	last_ok_at INTEGER,
	failures INTEGER NOT NULL DEFAULT 0
);
`);
			pushCol();
		},
	},
	// 5: hot reads: full inboxes (queued receipts per agent, on every view
	// tick) and replies to a message (receipt topics). An ensure step, so a
	// database that reached 5 from another branch still gets them.
	{
		ensure: (db) =>
			db.exec(`
CREATE INDEX IF NOT EXISTS receipts_queued ON receipts(agent_id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to);
`),
	},
	// 6: durable delivery (docs/delivery.md): attempts, due times and the
	// session a tracked message reached. Additive columns, added only when
	// missing, so an older pulsar still opens the database.
	{
		ensure: (db) => {
			const add = (table: string, column: string, type: string) => {
				if (!hasColumn(db, table, column))
					db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
			};
			add("messages", "tracked", "INTEGER NOT NULL DEFAULT 0");
			add("receipts", "attempt", "INTEGER NOT NULL DEFAULT 1");
			add("receipts", "due_at", "INTEGER DEFAULT NULL");
			add("receipts", "delivered_gen", "TEXT DEFAULT NULL");
			add("receipts", "acked_at", "INTEGER DEFAULT NULL");
			add("receipts", "result", "TEXT DEFAULT NULL");
			add("receipts", "resume_key", "TEXT DEFAULT NULL");
			db.exec(`
CREATE INDEX IF NOT EXISTS receipts_due ON receipts(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS receipts_resume ON receipts(resume_key) WHERE resume_key IS NOT NULL;
`);
		},
	},
	// 7: interactions: what a relayed prompt asks
	// (kind, typed prompt) and the app's typed answer. Additive, ensure-style.
	{
		ensure: (db) => {
			for (const col of ["kind", "prompt", "answer", "source"])
				if (!hasColumn(db, "approvals", col))
					db.exec(`ALTER TABLE approvals ADD COLUMN ${col} TEXT DEFAULT NULL`);
		},
	},
	// 8: token usage read from harness session files (src/usage): tokens per
	// UTC hour, harness, model, folder and session; each file's read offset
	// and parser state; provider message ids already counted.
	{
		ensure: (db) =>
			db.exec(`
CREATE TABLE IF NOT EXISTS usage_hourly (
	hour INTEGER NOT NULL,
	harness TEXT NOT NULL,
	model TEXT NOT NULL,
	project TEXT NOT NULL,
	session TEXT NOT NULL,
	input INTEGER NOT NULL DEFAULT 0,
	cache_read INTEGER NOT NULL DEFAULT 0,
	cache_write_5m INTEGER NOT NULL DEFAULT 0,
	cache_write_1h INTEGER NOT NULL DEFAULT 0,
	output INTEGER NOT NULL DEFAULT 0,
	records INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (hour, harness, model, project, session)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS usage_hourly_session ON usage_hourly(harness, session);
CREATE TABLE IF NOT EXISTS usage_files (
	path TEXT PRIMARY KEY,
	harness TEXT NOT NULL,
	session TEXT NOT NULL,
	offset INTEGER NOT NULL DEFAULT 0,
	size INTEGER NOT NULL DEFAULT 0,
	mtime INTEGER NOT NULL DEFAULT 0,
	state TEXT NOT NULL DEFAULT '{}',
	model TEXT,
	context_used INTEGER,
	context_window INTEGER,
	last_at INTEGER
);
CREATE INDEX IF NOT EXISTS usage_files_session ON usage_files(harness, session);
CREATE TABLE IF NOT EXISTS usage_seen (
	key INTEGER PRIMARY KEY,
	at INTEGER NOT NULL
);
`),
	},
	// 9: finish and fail notifications: what each push subscription wants
	// (`turns`: off, notify, sound, both; NULL until the browser says, while
	// subscriptions made before this step get notify; `in_app`), and the
	// agents the operator recently started, messaged or opened. Additive,
	// ensure-style.
	{
		ensure: (db) => {
			if (!hasColumn(db, "push_subscriptions", "turns")) {
				db.exec(
					"ALTER TABLE push_subscriptions ADD COLUMN turns TEXT DEFAULT NULL",
				);
				db.exec("UPDATE push_subscriptions SET turns = 'notify'");
			}
			if (!hasColumn(db, "push_subscriptions", "in_app"))
				db.exec(
					"ALTER TABLE push_subscriptions ADD COLUMN in_app INTEGER NOT NULL DEFAULT 1",
				);
			db.exec(`
CREATE TABLE IF NOT EXISTS agent_interest (
	agent_id TEXT PRIMARY KEY,
	at INTEGER NOT NULL
);
`);
		},
	},
];

/** The schema version this pulsar writes. */
export const SCHEMA_VERSION = 1 + MIGRATIONS.length;

type Row = Record<string, string | number | null>;

function toMessage(r: Row): Message {
	return {
		id: String(r.id),
		threadId: String(r.thread_id),
		fromId: String(r.from_id),
		fromName: String(r.from_name),
		to: String(r.to_spec),
		body: String(r.body),
		priority: r.priority as Message["priority"],
		replyTo: (r.reply_to as string | null) ?? null,
		expectReply: Number(r.expect_reply) === 1,
		createdAt: Number(r.created_at),
		...(Number(r.tracked) > 0 ? { tracked: Number(r.tracked) as 1 | 2 } : {}),
	};
}

function toReceipt(r: Row): Receipt {
	return {
		messageId: String(r.message_id),
		agentId: String(r.agent_id),
		agentName: String(r.agent_name),
		state: r.state as ReceiptState,
		via: (r.via as string | null) ?? null,
		detail: (r.detail as string | null) ?? null,
		updatedAt: Number(r.updated_at),
		attempt: Number(r.attempt ?? 1) || 1,
		result: (r.result as string | null) ?? null,
	};
}

/** A tracked receipt with what the redelivery scheduler needs. */
export interface PendingDelivery {
	receipt: Receipt;
	tracked: 1 | 2;
	createdAt: number;
	dueAt: number | null;
	deliveredGen: string | null;
	ackedAt: number | null;
	resumeKey: string | null;
}

function toPending(r: Row): PendingDelivery {
	return {
		receipt: toReceipt(r),
		tracked: Number(r.tracked) as 1 | 2,
		createdAt: Number(r.created_at),
		dueAt: r.due_at === null ? null : Number(r.due_at),
		deliveredGen: (r.delivered_gen as string | null) ?? null,
		ackedAt: r.acked_at === null ? null : Number(r.acked_at),
		resumeKey: (r.resume_key as string | null) ?? null,
	};
}

/** Final states as an SQL list. */
const FINAL_SQL = "('replied', 'done', 'nacked', 'expired', 'dead')";
const PENDING_SELECT = `SELECT r.*, m.tracked, m.created_at FROM receipts r
	JOIN messages m ON m.id = r.message_id
	WHERE m.tracked > 0 AND r.state NOT IN ${FINAL_SQL}`;

/** Saved self-description that survives a restart of the same session. */
interface SavedIdentity {
	name: string | null;
	tags: string[];
	/** Stored in the `summary` column (its 1.0 name). */
	activity: string | null;
	inbound: Agent["inbound"] | null;
}

/**
 * Durable state: messages, receipts and self-set identity. Live presence is
 * kept in memory by the daemon, because it is only true while the daemon runs.
 */
export class Store {
	readonly db: DatabaseSyncType;

	private machine: string | null = null;
	private writes = 0;

	/**
	 * Goes up on every write to messages or receipts (a send, a delivery, an
	 * inbox read, a reply, a prune): views of receipts recompute only when
	 * it moved.
	 */
	get messageWrites(): number {
		return this.writes;
	}

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(PRAGMAS);
		this.migrate();
		// Two daemons may open the database at once; the first id written wins.
		this.db
			.prepare(
				"INSERT OR IGNORE INTO meta (key, value) VALUES ('machine_id', ?)",
			)
			.run(randomUUID());
	}

	/** The schema version on disk. */
	version(): number {
		const row = this.db.prepare("PRAGMA user_version").get() as Row;
		return Number(row.user_version);
	}

	/**
	 * Brings the schema to SCHEMA_VERSION, one transaction per step. Each step
	 * re-reads the version under the write lock, so a second process opening
	 * the same file skips what the first already did. A newer database is left
	 * alone.
	 */
	private migrate() {
		this.migrateSteps();
		// Ensure steps hold on every open (see `EnsureStep`).
		const ensures = MIGRATIONS.filter(
			(m): m is EnsureStep => typeof m !== "string",
		);
		if (ensures.length === 0 || this.version() < SCHEMA_VERSION) return;
		this.db.exec("BEGIN IMMEDIATE");
		try {
			for (const m of ensures) m.ensure(this.db);
			this.db.exec("COMMIT");
		} catch (e) {
			this.db.exec("ROLLBACK");
			throw e;
		}
	}

	private migrateSteps() {
		for (;;) {
			const before = this.version();
			if (before >= SCHEMA_VERSION) return;
			this.db.exec("BEGIN IMMEDIATE");
			try {
				const current = this.version();
				if (current === 0) {
					// Fresh, or a 1.x database (same tables, no version yet).
					this.db.exec(SCHEMA_V1);
					this.db.exec("PRAGMA user_version = 1");
				} else if (current < SCHEMA_VERSION) {
					const step = MIGRATIONS[current - 1]!;
					if (typeof step === "string") this.db.exec(step);
					else step.ensure(this.db);
					this.db.exec(`PRAGMA user_version = ${current + 1}`);
				}
				this.db.exec("COMMIT");
			} catch (e) {
				this.db.exec("ROLLBACK");
				throw e;
			}
		}
	}

	/** A `meta` value (pool owner, …); null when unset. */
	metaGet(key: string): string | null {
		const row = this.db
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get(key) as Row | undefined;
		return row ? String(row.value) : null;
	}

	/** Pool membership entries (allow/deny by Tailscale node id). */
	poolMembers(): PoolMemberRow[] {
		return (
			this.db.prepare("SELECT * FROM pool_members ORDER BY name").all() as Row[]
		).map((r) => ({
			nodeId: String(r.node_id),
			name: String(r.name),
			login: (r.login as string | null) ?? null,
			verdict: r.verdict === "deny" ? "deny" : "allow",
			at: Number(r.at),
		}));
	}

	setPoolMember(m: PoolMemberRow) {
		this.db
			.prepare(
				`INSERT INTO pool_members (node_id, name, login, verdict, at) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(node_id) DO UPDATE SET name = excluded.name, login = excluded.login,
				   verdict = excluded.verdict, at = excluded.at`,
			)
			.run(m.nodeId, m.name, m.login, m.verdict, m.at);
	}

	removePoolMember(nodeId: string) {
		this.db.prepare("DELETE FROM pool_members WHERE node_id = ?").run(nodeId);
	}

	/** Recipient ids of a message that start with `prefix` (a range on the key, no full scan). */
	receiptIdsWithPrefix(messageId: string, prefix: string): Set<string> {
		const rows = this.db
			.prepare(
				"SELECT agent_id FROM receipts WHERE message_id = ? AND agent_id >= ? AND agent_id < ?",
			)
			.all(messageId, prefix, `${prefix}\uffff`) as Row[];
		return new Set(rows.map((r) => String(r.agent_id)));
	}

	/** Forgets a peer's machine-id binding (`pulsar mesh forget`). */
	removePeer(machineId: string) {
		this.db.prepare("DELETE FROM peers WHERE machine_id = ?").run(machineId);
	}

	/** This machine's stable random id, created on first run. */
	machineId(): string {
		if (!this.machine) {
			const row = this.db
				.prepare("SELECT value FROM meta WHERE key = 'machine_id'")
				.get() as Row;
			this.machine = String(row.value);
		}
		return this.machine;
	}

	close() {
		this.db.close();
	}

	/**
	 * Stores a message. Idempotent: a message id already stored is left as it
	 * is (a copy delivered twice by a peer). True when it was new.
	 * `originMachine` is the machine id of a message that came from a peer.
	 */
	addMessage(
		m: Message,
		opts: { originMachine?: string | null; receivedAt?: number } = {},
	): boolean {
		this.writes++;
		const r = this.db
			.prepare(
				`INSERT OR IGNORE INTO messages (id, thread_id, from_id, from_name, to_spec, body, priority, reply_to, expect_reply, created_at, origin_machine, received_at, tracked)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				m.id,
				m.threadId,
				m.fromId,
				m.fromName,
				m.to,
				m.body,
				m.priority,
				m.replyTo,
				m.expectReply ? 1 : 0,
				m.createdAt,
				opts.originMachine ?? null,
				opts.receivedAt ?? m.createdAt,
				m.tracked ?? 0,
			);
		return Number(r.changes) > 0;
	}

	getMessage(id: string): Message | null {
		const row = this.db
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(id) as Row | undefined;
		return row ? toMessage(row) : null;
	}

	/**
	 * Writes a receipt, guarded: within one
	 * attempt a final state never changes and `acked` never falls back to
	 * sent/delivered/read (a late extension ack after a reply). A higher
	 * attempt (a redelivery) always applies. `attempt` absent keeps the
	 * stored one. Returns false when the guard dropped the write.
	 */
	setReceipt(r: Receipt): boolean {
		this.writes++;
		const attempt = r.attempt ?? null;
		const result = this.db
			.prepare(
				`INSERT INTO receipts (message_id, agent_id, agent_name, state, via, detail, updated_at, attempt, result)
				 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, 1), ?9)
				 ON CONFLICT(message_id, agent_id) DO UPDATE SET
				   state = excluded.state, via = COALESCE(excluded.via, receipts.via),
				   detail = excluded.detail, updated_at = excluded.updated_at,
				   attempt = COALESCE(?8, receipts.attempt),
				   result = COALESCE(excluded.result, receipts.result)
				 WHERE COALESCE(?8, receipts.attempt) > receipts.attempt
				   OR (receipts.state NOT IN ${FINAL_SQL}
				     AND NOT (receipts.state = 'acked' AND excluded.state IN ('sent', 'delivered', 'read')))`,
			)
			.run(
				r.messageId,
				r.agentId,
				r.agentName,
				r.state,
				r.via,
				r.detail,
				r.updatedAt,
				attempt,
				r.result ?? null,
			);
		return Number(result.changes) > 0;
	}

	/** Writes a receipt without the guard (`done` after the agent's own reply). */
	forceReceipt(r: Receipt) {
		this.writes++;
		this.db
			.prepare(
				`UPDATE receipts SET state = ?, via = COALESCE(?, via), detail = ?, updated_at = ?,
				   attempt = COALESCE(?, attempt), result = COALESCE(?, result)
				 WHERE message_id = ? AND agent_id = ?`,
			)
			.run(
				r.state,
				r.via,
				r.detail,
				r.updatedAt,
				r.attempt ?? null,
				r.result ?? null,
				r.messageId,
				r.agentId,
			);
	}

	/** Sets how a stored message is tracked (a `nack retry` on an untracked one). */
	setTracked(messageId: string, level: 0 | 1 | 2) {
		this.db
			.prepare("UPDATE messages SET tracked = ? WHERE id = ?")
			.run(level, messageId);
	}

	/** One agent's receipt for a message. */
	receipt(messageId: string, agentId: string): Receipt | null {
		const row = this.db
			.prepare("SELECT * FROM receipts WHERE message_id = ? AND agent_id = ?")
			.get(messageId, agentId) as Row | undefined;
		return row ? toReceipt(row) : null;
	}

	/** Tracked receipts not yet final for one agent. */
	pendingFor(agentId: string): PendingDelivery[] {
		return (
			this.db
				.prepare(`${PENDING_SELECT} AND r.agent_id = ? ORDER BY m.created_at`)
				.all(agentId) as Row[]
		).map(toPending);
	}

	/** Tracked receipts not yet final that reached a session with this resume key. */
	pendingByResumeKey(key: string): PendingDelivery[] {
		return (
			this.db
				.prepare(`${PENDING_SELECT} AND r.resume_key = ? ORDER BY m.created_at`)
				.all(key) as Row[]
		).map(toPending);
	}

	/** Tracked receipts whose next scheduler action is due. */
	dueDeliveries(now: number, limit = 200): PendingDelivery[] {
		return (
			this.db
				.prepare(
					`${PENDING_SELECT} AND r.due_at IS NOT NULL AND r.due_at <= ? ORDER BY r.due_at LIMIT ?`,
				)
				.all(now, limit) as Row[]
		).map(toPending);
	}

	/** Clears the due time of receipts that became final (nothing left to schedule). */
	clearFinalDue() {
		this.db
			.prepare(
				`UPDATE receipts SET due_at = NULL WHERE due_at IS NOT NULL AND state IN ${FINAL_SQL}`,
			)
			.run();
	}

	/**
	 * Updates a receipt's delivery bookkeeping. `undefined` keeps a field;
	 * `null` clears it.
	 */
	setDelivery(
		messageId: string,
		agentId: string,
		f: {
			dueAt?: number | null;
			deliveredGen?: string | null;
			ackedAt?: number | null;
			resumeKey?: string | null;
		},
	) {
		const sets: string[] = [];
		const args: Array<string | number | null> = [];
		const put = (col: string, v: string | number | null | undefined) => {
			if (v === undefined) return;
			sets.push(`${col} = ?`);
			args.push(v);
		};
		put("due_at", f.dueAt);
		put("delivered_gen", f.deliveredGen);
		put("acked_at", f.ackedAt);
		put("resume_key", f.resumeKey);
		if (sets.length === 0) return;
		this.db
			.prepare(
				`UPDATE receipts SET ${sets.join(", ")} WHERE message_id = ? AND agent_id = ?`,
			)
			.run(...args, messageId, agentId);
	}

	/** Moves one receipt to another agent (a pi/omp session resumed under a new pid). */
	moveReceipt(
		messageId: string,
		fromAgentId: string,
		toAgentId: string,
		toName: string,
	) {
		this.writes++;
		this.db
			.prepare(
				"UPDATE OR IGNORE receipts SET agent_id = ?, agent_name = ? WHERE message_id = ? AND agent_id = ?",
			)
			.run(toAgentId, toName, messageId, fromAgentId);
	}

	receiptsFor(messageId: string): Receipt[] {
		return (
			this.db
				.prepare("SELECT * FROM receipts WHERE message_id = ?")
				.all(messageId) as Row[]
		).map(toReceipt);
	}

	/** One page of a message's receipts, optionally in one state, in a stable order. */
	receiptPage(
		messageId: string,
		state: ReceiptState | null,
		offset: number,
		limit: number,
	): Receipt[] {
		const rows = state
			? this.db
					.prepare(
						`SELECT * FROM receipts WHERE message_id = ? AND state = ?
						 ORDER BY agent_name, agent_id LIMIT ? OFFSET ?`,
					)
					.all(messageId, state, limit, offset)
			: this.db
					.prepare(
						`SELECT * FROM receipts WHERE message_id = ?
						 ORDER BY agent_name, agent_id LIMIT ? OFFSET ?`,
					)
					.all(messageId, limit, offset);
		return (rows as Row[]).map(toReceipt);
	}

	/** Agents with at least `cap` unread messages (one query for a whole page or send). */
	fullInboxes(cap: number): Set<string> {
		const rows = this.db
			.prepare(
				`SELECT agent_id FROM receipts WHERE state = 'queued'
				 GROUP BY agent_id HAVING COUNT(*) >= ?`,
			)
			.all(cap) as Row[];
		return new Set(rows.map((r) => String(r.agent_id)));
	}

	/** Small daemon state in the `meta` table, by key prefix (`session:`). */
	metaByPrefix(prefix: string): Array<{ key: string; value: string }> {
		return (
			this.db
				.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?")
				.all(prefix, `${prefix}\uffff`) as Row[]
		).map((r) => ({ key: String(r.key), value: String(r.value) }));
	}

	metaSet(key: string, value: string) {
		this.db
			.prepare(
				"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			)
			.run(key, value);
	}

	metaDelete(key: string) {
		this.db.prepare("DELETE FROM meta WHERE key = ?").run(key);
	}

	/** Records an action taken on someone's behalf (who, what, on whom, outcome). */
	audit(row: {
		principal: string;
		op: string;
		target: string | null;
		detail: string | null;
		ok: boolean;
		at?: number;
	}) {
		this.db
			.prepare(
				"INSERT INTO audit (at, principal, op, target, detail, ok) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				row.at ?? Date.now(),
				row.principal,
				row.op,
				row.target,
				row.detail,
				row.ok ? 1 : 0,
			);
	}

	/** The newest audit rows, newest first. */
	auditLog(limit = 50): Array<{
		at: number;
		principal: string;
		op: string;
		target: string | null;
		detail: string | null;
		ok: boolean;
	}> {
		return (
			this.db
				.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?")
				.all(limit) as Row[]
		).map((r) => ({
			at: Number(r.at),
			principal: String(r.principal),
			op: String(r.op),
			target: r.target === null ? null : String(r.target),
			detail: r.detail === null ? null : String(r.detail),
			ok: Number(r.ok) === 1,
		}));
	}

	/** How many of a message's receipts are in each state. */
	receiptTotals(messageId: string): Partial<Record<ReceiptState, number>> {
		const rows = this.db
			.prepare(
				"SELECT state, COUNT(*) AS n FROM receipts WHERE message_id = ? GROUP BY state",
			)
			.all(messageId) as Row[];
		const totals: Partial<Record<ReceiptState, number>> = {};
		for (const r of rows) totals[r.state as ReceiptState] = Number(r.n);
		return totals;
	}

	/**
	 * Messages waiting for an agent, oldest first. A message pushed into the
	 * agent's conversation is `delivered`, not waiting, so it is not repeated.
	 */
	unread(agentId: string, limit = 50): Message[] {
		return (
			this.db
				.prepare(
					`SELECT m.* FROM messages m JOIN receipts r ON r.message_id = m.id
					 WHERE r.agent_id = ? AND r.state = 'queued'
					 ORDER BY m.created_at ASC LIMIT ?`,
				)
				.all(agentId, limit) as Row[]
		).map(toMessage);
	}

	unreadCount(agentId: string): number {
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n FROM receipts WHERE agent_id = ? AND state = 'queued'`,
			)
			.get(agentId) as Row;
		return Number(row.n);
	}

	markRead(agentId: string, messageIds: string[], now: number) {
		this.writes++;
		const stmt = this.db.prepare(
			`UPDATE receipts SET state = 'read', updated_at = ?
			 WHERE agent_id = ? AND message_id = ? AND state IN ('queued', 'delivered', 'held')`,
		);
		for (const id of messageIds) stmt.run(now, agentId, id);
	}

	/** A reply moves the original's receipt for the replier to `replied`. */
	markReplied(agentId: string, messageId: string, now: number) {
		this.writes++;
		this.db
			.prepare(
				`UPDATE receipts SET state = 'replied', updated_at = ? WHERE agent_id = ? AND message_id = ?`,
			)
			.run(now, agentId, messageId);
	}

	/** Held messages for an agent (inbound policy `hold`), oldest first. */
	held(agentId: string): Message[] {
		return (
			this.db
				.prepare(
					`SELECT m.* FROM messages m JOIN receipts r ON r.message_id = m.id
					 WHERE r.agent_id = ? AND r.state = 'held' ORDER BY m.created_at ASC`,
				)
				.all(agentId) as Row[]
		).map(toMessage);
	}

	/**
	 * Moves an agent's receipts to a new id (a session re-registered). Where the
	 * new id already has a receipt for the same message, that one is kept and the
	 * old id's copy is dropped.
	 */
	reassign(fromAgentId: string, toAgentId: string) {
		this.writes++;
		if (fromAgentId === toAgentId) return;
		this.db
			.prepare("UPDATE OR IGNORE receipts SET agent_id = ? WHERE agent_id = ?")
			.run(toAgentId, fromAgentId);
		this.db.prepare("DELETE FROM receipts WHERE agent_id = ?").run(fromAgentId);
	}

	repliesTo(messageId: string): Message[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM messages WHERE reply_to = ? ORDER BY created_at ASC",
				)
				.all(messageId) as Row[]
		).map(toMessage);
	}

	thread(threadId: string, limit = 200): Message[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?",
				)
				.all(threadId, limit) as Row[]
		).map(toMessage);
	}

	/** Search messages an agent sent or received. Empty query = most recent. */
	search(agentId: string | null, query: string, limit = 50): Message[] {
		const like = `%${query.replace(/[%_]/g, "\\$&")}%`;
		const rows = agentId
			? this.db
					.prepare(
						`SELECT DISTINCT m.* FROM messages m LEFT JOIN receipts r ON r.message_id = m.id
						 WHERE (m.from_id = ? OR r.agent_id = ?) AND m.body LIKE ? ESCAPE '\\'
						 ORDER BY m.created_at DESC LIMIT ?`,
					)
					.all(agentId, agentId, like, limit)
			: this.db
					.prepare(
						`SELECT * FROM messages WHERE body LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?`,
					)
					.all(like, limit);
		return (rows as Row[]).map(toMessage);
	}

	saveIdentity(agentId: string, id: SavedIdentity, now: number) {
		this.db
			.prepare(
				`INSERT INTO identities (agent_id, name, tags, summary, inbound, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_id) DO UPDATE SET name = excluded.name, tags = excluded.tags,
				   summary = excluded.summary, inbound = excluded.inbound, updated_at = excluded.updated_at`,
			)
			.run(
				agentId,
				id.name,
				JSON.stringify(id.tags),
				id.activity,
				id.inbound,
				now,
			);
	}

	loadIdentity(agentId: string): SavedIdentity | null {
		const row = this.db
			.prepare("SELECT * FROM identities WHERE agent_id = ?")
			.get(agentId) as Row | undefined;
		if (!row) return null;
		let tags: string[] = [];
		try {
			const parsed: unknown = JSON.parse(String(row.tags));
			if (
				Array.isArray(parsed) &&
				parsed.every((t): t is string => typeof t === "string")
			)
				tags = parsed;
			else
				daemonLog(`saved tags for ${agentId} are not a string list; ignored`);
		} catch (e) {
			daemonLog(
				`saved tags for ${agentId} unreadable: ${(e as Error).message}`,
			);
		}
		return {
			name: (row.name as string | null) ?? null,
			tags,
			activity: (row.summary as string | null) ?? null,
			inbound: (row.inbound as Agent["inbound"] | null) ?? null,
		};
	}

	/** Drops messages older than `maxAgeMs`. */
	prune(now: number, maxAgeMs: number) {
		this.writes++;
		const cutoff = now - maxAgeMs;
		this.db
			.prepare(
				"DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)",
			)
			.run(cutoff);
		this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
	}

	// --- Federation (the pool): message origin, outbox, peers ---

	/** The machine id a stored message came from; null for one sent on this node. */
	originOf(messageId: string): string | null {
		const row = this.db
			.prepare("SELECT origin_machine FROM messages WHERE id = ?")
			.get(messageId) as Row | undefined;
		return (row?.origin_machine as string | null | undefined) ?? null;
	}

	/** Queues (or widens) one message for agents on a peer machine. */
	outboxAdd(
		peer: string,
		messageId: string,
		targetIds: string[],
		now: number,
		expiresAt: number,
		sender: string | null = null,
	) {
		const existing = this.db
			.prepare(
				"SELECT target_ids FROM outbox WHERE peer_machine = ? AND message_id = ?",
			)
			.get(peer, messageId) as Row | undefined;
		const ids = existing
			? [
					...new Set([
						...(JSON.parse(String(existing.target_ids)) as string[]),
						...targetIds,
					]),
				]
			: targetIds;
		this.db
			.prepare(
				`INSERT INTO outbox (peer_machine, message_id, target_ids, attempts, next_attempt_at, created_at, expires_at, sender)
				 VALUES (?, ?, ?, 0, ?, ?, ?, ?)
				 ON CONFLICT(peer_machine, message_id) DO UPDATE SET
				   target_ids = excluded.target_ids, next_attempt_at = excluded.next_attempt_at,
				   sender = COALESCE(excluded.sender, outbox.sender)`,
			)
			.run(peer, messageId, JSON.stringify(ids), now, now, expiresAt, sender);
	}

	/** One peer's outbox entries due by `now`, oldest first. */
	outboxDue(peer: string, now: number, limit = 200): OutboxEntry[] {
		const rows = this.db
			.prepare(
				`SELECT * FROM outbox WHERE peer_machine = ? AND next_attempt_at <= ?
				 ORDER BY created_at LIMIT ?`,
			)
			.all(peer, now, limit) as Row[];
		return rows.map(toOutbox);
	}

	/** The peers with at least one entry due by `now`. */
	outboxDuePeers(now: number): string[] {
		const rows = this.db
			.prepare(
				"SELECT DISTINCT peer_machine FROM outbox WHERE next_attempt_at <= ?",
			)
			.all(now) as Row[];
		return rows.map((r) => String(r.peer_machine));
	}

	/** Every queued entry for a peer (for receipts and counts). */
	outboxFor(peer: string): OutboxEntry[] {
		return (
			this.db
				.prepare(
					"SELECT * FROM outbox WHERE peer_machine = ? ORDER BY created_at",
				)
				.all(peer) as Row[]
		).map(toOutbox);
	}

	outboxDone(peer: string, messageId: string) {
		this.db
			.prepare("DELETE FROM outbox WHERE peer_machine = ? AND message_id = ?")
			.run(peer, messageId);
	}

	outboxRetry(peer: string, messageId: string, next: number, error: string) {
		this.db
			.prepare(
				`UPDATE outbox SET attempts = attempts + 1, next_attempt_at = ?, last_error = ?
				 WHERE peer_machine = ? AND message_id = ?`,
			)
			.run(next, error.slice(0, 500), peer, messageId);
	}

	/** Makes every entry for a peer due now (its link came back). */
	outboxWake(peer: string, now: number) {
		this.db
			.prepare("UPDATE outbox SET next_attempt_at = ? WHERE peer_machine = ?")
			.run(now, peer);
	}

	/** Removes and returns entries past their expiry. */
	outboxExpire(now: number): OutboxEntry[] {
		const rows = (
			this.db
				.prepare("SELECT * FROM outbox WHERE expires_at <= ?")
				.all(now) as Row[]
		).map(toOutbox);
		if (rows.length)
			this.db.prepare("DELETE FROM outbox WHERE expires_at <= ?").run(now);
		return rows;
	}

	/** Starts (or replaces) tracking a copy a peer delivered, for its receipts. */
	trackSet(t: TrackedCopy) {
		this.db
			.prepare(
				`INSERT INTO fed_tracking (message_id, machine_id, targets, sig, until) VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(message_id) DO UPDATE SET machine_id = excluded.machine_id,
				   targets = excluded.targets, sig = excluded.sig, until = excluded.until`,
			)
			.run(t.messageId, t.machineId, JSON.stringify(t.targets), t.sig, t.until);
	}

	trackSig(messageId: string, sig: string) {
		this.db
			.prepare("UPDATE fed_tracking SET sig = ? WHERE message_id = ?")
			.run(sig, messageId);
	}

	/** Live tracked copies; drops the expired ones. */
	tracked(now: number): TrackedCopy[] {
		this.db.prepare("DELETE FROM fed_tracking WHERE until < ?").run(now);
		return (this.db.prepare("SELECT * FROM fed_tracking").all() as Row[]).map(
			(r) => ({
				messageId: String(r.message_id),
				machineId: String(r.machine_id),
				targets: JSON.parse(String(r.targets)) as string[],
				sig: String(r.sig),
				until: Number(r.until),
			}),
		);
	}

	/** Remembers a pool peer (what its hello said). */
	savePeer(p: PeerRecord, now: number) {
		this.db
			.prepare(
				`INSERT INTO peers (machine_id, name, node, dns_name, allowed, pulsar_version, fed_protocol, last_seen, created_at, port)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(machine_id) DO UPDATE SET
				   name = excluded.name, node = excluded.node, dns_name = excluded.dns_name,
				   allowed = excluded.allowed, pulsar_version = excluded.pulsar_version,
				   fed_protocol = excluded.fed_protocol, last_seen = excluded.last_seen,
				   port = COALESCE(peers.port, excluded.port)`,
			)
			.run(
				p.machineId,
				p.name,
				p.node,
				p.dnsName,
				p.allowed ? 1 : 0,
				p.pulsarVersion,
				JSON.stringify(p.fedProtocol),
				p.lastSeen,
				now,
				p.port ?? null,
			);
	}

	peers(): PeerRecord[] {
		return (
			this.db.prepare("SELECT * FROM peers ORDER BY name").all() as Row[]
		).map((r) => ({
			machineId: String(r.machine_id),
			name: String(r.name),
			node: (r.node as string | null) ?? null,
			dnsName: (r.dns_name as string | null) ?? null,
			port: r.port === null || r.port === undefined ? null : Number(r.port),
			allowed: Number(r.allowed) === 1,
			pulsarVersion: (r.pulsar_version as string | null) ?? null,
			fedProtocol: r.fed_protocol
				? (JSON.parse(String(r.fed_protocol)) as [number, number])
				: null,
			lastSeen: Number(r.last_seen),
		}));
	}
}

/** One message waiting for a peer machine. */
export interface OutboxEntry {
	peer: string;
	messageId: string;
	targetIds: string[];
	attempts: number;
	nextAttemptAt: number;
	lastError: string | null;
	createdAt: number;
	expiresAt: number;
	/** The sender frame (JSON) the message goes out with. */
	sender: string | null;
}

function toOutbox(r: Row): OutboxEntry {
	return {
		peer: String(r.peer_machine),
		messageId: String(r.message_id),
		targetIds: JSON.parse(String(r.target_ids)) as string[],
		attempts: Number(r.attempts),
		nextAttemptAt: Number(r.next_attempt_at),
		lastError: (r.last_error as string | null) ?? null,
		createdAt: Number(r.created_at),
		expiresAt: Number(r.expires_at),
		sender: (r.sender as string | null) ?? null,
	};
}

/** A pool peer as last seen. */
export interface PeerRecord {
	machineId: string;
	name: string;
	node: string | null;
	dnsName: string | null;
	allowed: boolean;
	pulsarVersion: string | null;
	fedProtocol: [number, number] | null;
	lastSeen: number;
	/** The port its app serves on, bound at first link. */
	port?: number | null;
}

/** A copy a peer delivered here, whose receipts go back as they change. */
export interface TrackedCopy {
	messageId: string;
	machineId: string;
	targets: string[];
	sig: string;
	until: number;
}

/** One pool membership entry: a tailnet node (by stable id) allowed or denied. */
export interface PoolMemberRow {
	nodeId: string;
	/** Its name when added (display only; matching is by `nodeId`). */
	name: string;
	/** The login it had when added (`tagged-devices` for tagged nodes); it must still match. */
	login: string | null;
	verdict: "allow" | "deny";
	at: number;
}
