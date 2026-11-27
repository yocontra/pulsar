import type { Store } from "../store.ts";
import type { FileState, UsageRecord } from "./parse.ts";

/** Native history is mutable. Replace its contribution atomically, including shared responses in copied conversations. */
export function replaceAntigravityUsage(
	store: Store,
	file: { session: string; path: string; size: number; mtime: number },
	records: UsageRecord[],
	state: FileState,
) {
	const db = store.db;
	const responseIds = JSON.stringify(records.map((r) => r.dedupeId));
	db.exec("BEGIN IMMEDIATE");
	try {
		const sessions = db
			.prepare(`SELECT DISTINCT session FROM usage_native_responses WHERE response IN (
			SELECT response FROM usage_native_responses WHERE session=? UNION SELECT value FROM json_each(?))`)
			.all(file.session, responseIds);
		db.prepare("DELETE FROM usage_native_responses WHERE session=?").run(
			file.session,
		);
		const put = db.prepare(
			"INSERT OR IGNORE INTO usage_native_responses (session,response,at,model,input,cache_read,cache_write,output) VALUES (?,?,?,?,?,?,?,?)",
		);
		let latest: number | null = null;
		for (const r of records) {
			put.run(
				file.session,
				r.dedupeId!,
				r.t,
				r.model,
				r.input,
				r.cacheRead,
				r.cacheWrite5m,
				r.output,
			);
			latest = Math.max(latest ?? 0, r.t);
		}
		// A negative offset distinguishes a complete native snapshot from older append cursors.
		db.prepare(`INSERT OR REPLACE INTO usage_files
			(path, harness,session,offset,size,mtime,state,model,context_used,context_window,last_at) VALUES (?,'antigravity',?,-1,?,?,?,?,?,?,?)`).run(
			file.path,
			file.session,
			file.size,
			file.mtime,
			JSON.stringify(state),
			state.model ?? null,
			state.context?.used ?? null,
			state.context?.window ?? null,
			latest,
		);
		const clear = db.prepare(
			"DELETE FROM usage_hourly WHERE harness='antigravity' AND session=?",
		);
		const rebuild =
			db.prepare(`INSERT INTO usage_hourly (hour,harness,model,project,session,input,cache_read,cache_write_5m,output,records)
			SELECT (n.at/3600000)*3600000, 'antigravity', n.model, coalesce((SELECT json_extract(f.state, '$.cwd') FROM usage_files f WHERE f.harness='antigravity' AND f.session=n.session LIMIT 1), ''), n.session, sum(n.input), sum(n.cache_read), sum(n.cache_write), sum(n.output), count(*)
			FROM usage_native_responses n WHERE n.session=? AND NOT EXISTS (
				SELECT 1 FROM usage_native_responses owner WHERE owner.response=n.response AND (owner.at,owner.session)<(n.at,n.session))
			GROUP BY (n.at/3600000),n.model`);
		for (const session of new Set([
			file.session,
			...sessions.map((r) => String(r.session)),
		])) {
			clear.run(session);
			rebuild.run(session);
		}

		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
