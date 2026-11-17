import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
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

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 2000;
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
	};
}

/** Saved self-description that survives a restart of the same session. */
export interface SavedIdentity {
	name: string | null;
	tags: string[];
	summary: string | null;
	inbound: Agent["inbound"] | null;
}

/**
 * Durable state: messages, receipts and self-set identity. Live presence is
 * kept in memory by the daemon, because it is only true while the daemon runs.
 */
export class Store {
	readonly db: DatabaseSyncType;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(SCHEMA);
	}

	close() {
		this.db.close();
	}

	addMessage(m: Message) {
		this.db
			.prepare(
				`INSERT INTO messages (id, thread_id, from_id, from_name, to_spec, body, priority, reply_to, expect_reply, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
			);
	}

	getMessage(id: string): Message | null {
		const row = this.db
			.prepare("SELECT * FROM messages WHERE id = ?")
			.get(id) as Row | undefined;
		return row ? toMessage(row) : null;
	}

	setReceipt(r: Receipt) {
		this.db
			.prepare(
				`INSERT INTO receipts (message_id, agent_id, agent_name, state, via, detail, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(message_id, agent_id) DO UPDATE SET
				   state = excluded.state, via = COALESCE(excluded.via, receipts.via),
				   detail = excluded.detail, updated_at = excluded.updated_at`,
			)
			.run(
				r.messageId,
				r.agentId,
				r.agentName,
				r.state,
				r.via,
				r.detail,
				r.updatedAt,
			);
	}

	receiptsFor(messageId: string): Receipt[] {
		return (
			this.db
				.prepare("SELECT * FROM receipts WHERE message_id = ?")
				.all(messageId) as Row[]
		).map(toReceipt);
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
		const stmt = this.db.prepare(
			`UPDATE receipts SET state = 'read', updated_at = ?
			 WHERE agent_id = ? AND message_id = ? AND state IN ('queued', 'delivered', 'held')`,
		);
		for (const id of messageIds) stmt.run(now, agentId, id);
	}

	/** A reply moves the original's receipt for the replier to `replied`. */
	markReplied(agentId: string, messageId: string, now: number) {
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

	/** Moves an agent's pending receipts to a new id (a session re-registered). */
	reassign(fromAgentId: string, toAgentId: string) {
		if (fromAgentId === toAgentId) return;
		this.db
			.prepare("UPDATE OR IGNORE receipts SET agent_id = ? WHERE agent_id = ?")
			.run(toAgentId, fromAgentId);
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
				id.summary,
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
			tags = JSON.parse(String(row.tags)) as string[];
		} catch {}
		return {
			name: (row.name as string | null) ?? null,
			tags,
			summary: (row.summary as string | null) ?? null,
			inbound: (row.inbound as Agent["inbound"] | null) ?? null,
		};
	}

	/** Drops messages older than `maxAgeMs`. */
	prune(now: number, maxAgeMs: number) {
		const cutoff = now - maxAgeMs;
		this.db
			.prepare(
				"DELETE FROM receipts WHERE message_id IN (SELECT id FROM messages WHERE created_at < ?)",
			)
			.run(cutoff);
		this.db.prepare("DELETE FROM messages WHERE created_at < ?").run(cutoff);
	}
}
