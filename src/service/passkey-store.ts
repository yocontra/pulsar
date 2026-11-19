import { randomBytes } from "node:crypto";
import type { Store } from "../store.ts";
import type { PasskeyStore, StoredPasskey } from "./passkeys.ts";

type Row = Record<string, string | number | null | Uint8Array>;

function toPasskey(r: Row): StoredPasskey {
	let transports: string[] = [];
	try {
		const t: unknown = JSON.parse(String(r.transports));
		if (Array.isArray(t)) transports = t.filter((x) => typeof x === "string");
	} catch {}
	return {
		id: String(r.credential_id),
		publicKey: new Uint8Array(r.public_key as Uint8Array),
		login: String(r.login),
		rpId: String(r.rp_id),
		counter: Number(r.sign_count),
		transports,
		label: String(r.label ?? "browser"),
		createdAt: Number(r.created_at),
		lastUsedAt: r.last_used_at === null ? null : Number(r.last_used_at),
	};
}

/** Passkeys in the daemon's database (the `passkeys` table, migration 2). */
export class SqlitePasskeyStore implements PasskeyStore {
	private readonly store: Store;
	constructor(store: Store) {
		this.store = store;
	}

	list(login: string, rpId: string): StoredPasskey[] {
		return (
			this.store.db
				.prepare(
					"SELECT * FROM passkeys WHERE lower(login) = lower(?) AND rp_id = ? ORDER BY created_at",
				)
				.all(login, rpId) as Row[]
		).map(toPasskey);
	}

	all(): StoredPasskey[] {
		return (
			this.store.db
				.prepare("SELECT * FROM passkeys ORDER BY created_at")
				.all() as Row[]
		).map(toPasskey);
	}

	add(p: StoredPasskey) {
		this.store.db
			.prepare(
				`INSERT INTO passkeys (credential_id, public_key, login, rp_id, sign_count, transports, label, created_at, last_used_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				p.id,
				p.publicKey,
				p.login,
				p.rpId,
				p.counter,
				JSON.stringify(p.transports),
				p.label,
				p.createdAt,
				p.lastUsedAt,
			);
	}

	touch(id: string, counter: number, at: number) {
		this.store.db
			.prepare(
				"UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?",
			)
			.run(counter, at, id);
	}

	remove(id: string): boolean {
		const r = this.store.db
			.prepare("DELETE FROM passkeys WHERE credential_id = ?")
			.run(id);
		return Number(r.changes) > 0;
	}

	userHandle(login: string): string {
		const key = `webauthn_user:${login.toLowerCase()}`;
		this.store.db
			.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
			.run(key, randomBytes(16).toString("base64url"));
		const row = this.store.db
			.prepare("SELECT value FROM meta WHERE key = ?")
			.get(key) as Row;
		return String(row.value);
	}
}
