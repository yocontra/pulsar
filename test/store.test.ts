import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, Store } from "../src/store.ts";
import type { Message } from "../src/types.ts";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

/** The 1.x schema, frozen here: what every existing install has on disk. */
const SCHEMA_1X = `
PRAGMA journal_mode = WAL;
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
INSERT INTO messages VALUES ('m1', 't1', 'pi:a', 'pi@x', 'pi@y', 'hello', 'normal', NULL, 1, 1000);
INSERT INTO messages VALUES ('m2', 't1', 'pi:b', 'pi@y', 'pi@x', 'hi back', 'fyi', 'm1', 0, 2000);
INSERT INTO receipts VALUES ('m1', 'pi:b', 'pi@y', 'replied', 'extension', NULL, 1500);
INSERT INTO receipts VALUES ('m2', 'pi:a', 'pi@x', 'queued', NULL, NULL, 2000);
INSERT INTO identities VALUES ('pi:a', 'pi@x', '["workstream:auth"]', 'fixing login', 'hold', 900);
`;

const dirs: string[] = [];
function tempDb() {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-store-"));
	dirs.push(dir);
	return join(dir, "pulsar.db");
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tables(store: Store): string[] {
	return (
		store.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as Array<{ name: string }>
	).map((r) => r.name);
}

describe("migrations", () => {
	test("a 1.x database migrates to the current version with its data intact", () => {
		const path = tempDb();
		const old = new DatabaseSync(path);
		old.exec(SCHEMA_1X);
		expect(
			(old.prepare("PRAGMA user_version").get() as { user_version: number })
				.user_version,
		).toBe(0);
		old.close();

		const store = new Store(path);
		expect(SCHEMA_VERSION).toBe(13);
		expect(
			store.db.prepare("SELECT COUNT(*) AS n FROM usage_native_responses").get()
				?.n,
		).toBe(0);
		expect(store.version()).toBe(SCHEMA_VERSION);
		expect(store.getMessage("m1")).toEqual({
			id: "m1",
			threadId: "t1",
			fromId: "pi:a",
			fromName: "pi@x",
			to: "pi@y",
			body: "hello",
			priority: "normal",
			replyTo: null,
			expectReply: true,
			createdAt: 1000,
		});
		expect(store.repliesTo("m1").map((m) => m.id)).toEqual(["m2"]);
		expect(store.receiptsFor("m1")[0]?.state).toBe("replied");
		expect(store.unread("pi:a").map((m) => m.id)).toEqual(["m2"]);
		expect(store.loadIdentity("pi:a")).toEqual({
			name: "pi@x",
			tags: ["workstream:auth"],
			activity: "fixing login",
			inbound: "hold",
		});
		// New columns: received_at backfilled from created_at, no origin.
		expect(
			store.db
				.prepare(
					"SELECT id, origin_machine, received_at FROM messages ORDER BY id",
				)
				.all(),
		).toEqual([
			{ id: "m1", origin_machine: null, received_at: 1000 },
			{ id: "m2", origin_machine: null, received_at: 2000 },
		]);
		expect(tables(store)).toEqual(
			expect.arrayContaining([
				"meta",
				"outbox",
				"peers",
				"passkeys",
				"approvals",
				"audit",
			]),
		);
		const id = store.machineId();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		store.close();

		const again = new Store(path);
		expect(again.version()).toBe(SCHEMA_VERSION);
		expect(again.machineId()).toBe(id);
		expect(again.getMessage("m2")?.body).toBe("hi back");
		again.close();
	});

	test("hot reads use their indexes (queued receipts, replies)", () => {
		const store = new Store(":memory:");
		const plan = (sql: string) =>
			JSON.stringify(store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all());
		expect(
			plan(
				"SELECT agent_id FROM receipts WHERE state = 'queued' GROUP BY agent_id HAVING COUNT(*) >= 5",
			),
		).toContain("receipts_queued");
		expect(
			plan(
				"SELECT * FROM messages WHERE reply_to = 'x' ORDER BY created_at ASC",
			),
		).toContain("messages_reply_to");
		store.close();
	});

	test("a fresh database starts at the current version", () => {
		const store = new Store(tempDb());
		expect(store.version()).toBe(SCHEMA_VERSION);
		expect(tables(store)).toEqual(
			expect.arrayContaining(["messages", "receipts", "identities", "meta"]),
		);
		expect(store.machineId()).toBeString();
		store.close();
	});

	test("ensure steps repair a database that skipped them (any merge order)", () => {
		const path = tempDb();
		const first = new Store(path);
		// As if the version moved past step 3 before step 3 existed (merge order).
		first.db.exec("DROP TABLE fed_tracking");
		first.db.exec("ALTER TABLE outbox DROP COLUMN sender");
		first.close();
		const again = new Store(path);
		expect(again.version()).toBe(SCHEMA_VERSION);
		const cols = (
			again.db.prepare("PRAGMA table_info(outbox)").all() as { name: string }[]
		).map((c) => c.name);
		expect(cols).toContain("sender");
		expect(again.tracked(Date.now())).toEqual([]);
		again.close();
		// Idempotent: a third open changes nothing.
		new Store(path).close();
	});

	test("two stores opening one file agree on the machine id", () => {
		const path = tempDb();
		const a = new Store(path);
		const b = new Store(path);
		expect(b.machineId()).toBe(a.machineId());
		expect(b.version()).toBe(SCHEMA_VERSION);
		a.close();
		b.close();
	});

	test("a newer database is left alone", () => {
		const path = tempDb();
		const first = new Store(path);
		first.db.exec("PRAGMA user_version = 99");
		first.close();
		const store = new Store(path);
		expect(store.version()).toBe(99);
		store.close();
	});
});

describe("idempotent messages", () => {
	const message = (over: Partial<Message> = {}): Message => ({
		id: "m1",
		threadId: "t1",
		fromId: "pi:a",
		fromName: "pi@x",
		to: "*",
		body: "first",
		priority: "normal",
		replyTo: null,
		expectReply: false,
		createdAt: 1000,
		...over,
	});

	test("adding the same id again is a no-op", () => {
		const store = new Store(":memory:");
		expect(store.addMessage(message())).toBe(true);
		expect(store.addMessage(message({ body: "second copy" }))).toBe(false);
		expect(store.getMessage("m1")?.body).toBe("first");
		expect(
			(
				store.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as {
					n: number;
				}
			).n,
		).toBe(1);
		store.close();
	});

	test("a peer's copy records its origin and arrival", () => {
		const store = new Store(":memory:");
		store.addMessage(message({ id: "m9" }), {
			originMachine: "machine-2",
			receivedAt: 5000,
		});
		expect(
			store.db
				.prepare("SELECT origin_machine, received_at FROM messages")
				.get(),
		).toEqual({ origin_machine: "machine-2", received_at: 5000 });
		store.close();
	});
});

describe("file modes", () => {
	const mode = (p: string) => statSync(p).mode & 0o777;

	test("secure() makes the database, its WAL and -shm 0600; SQLite makes new ones the same", async () => {
		const path = tempDb();
		const store = new Store(path);
		store.audit({
			at: 1,
			principal: "t",
			op: "x",
			target: null,
			detail: null,
			ok: true,
		});
		for (const s of ["", "-wal", "-shm"]) {
			expect(existsSync(`${path}${s}`)).toBe(true);
			chmodSync(`${path}${s}`, 0o644);
		}
		await store.secure();
		for (const s of ["", "-wal", "-shm"])
			expect(mode(`${path}${s}`)).toBe(0o600);
		store.db.close();
		// Closing checkpoints and removes the WAL; the next open makes it anew.
		rmSync(`${path}-wal`, { force: true });
		rmSync(`${path}-shm`, { force: true });
		const again = new Store(path);
		again.audit({
			at: 2,
			principal: "t",
			op: "y",
			target: null,
			detail: null,
			ok: true,
		});
		for (const s of ["", "-wal", "-shm"])
			expect(mode(`${path}${s}`)).toBe(0o600);
		again.db.close();
	});

	test("secure() on a database without WAL files yet, or in memory, does not throw", async () => {
		await new Store(":memory:").secure();
		const path = tempDb();
		const store = new Store(path);
		store.db.close();
		rmSync(`${path}-wal`, { force: true });
		rmSync(`${path}-shm`, { force: true });
		const reopened = new Store(path);
		await reopened.secure();
		expect(mode(path)).toBe(0o600);
		reopened.db.close();
	});
});
