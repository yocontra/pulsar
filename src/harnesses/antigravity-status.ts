import { createRequire } from "node:module";
import type { AgentStatus } from "../types.ts";

/** Read only the native conversations found by this process scan. */
export function antigravitySummaries(path: string, ids: string[]) {
	const summaries = new Map<string, { status: AgentStatus; title?: string }>();
	if (!ids.length) return summaries;
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	let db: InstanceType<typeof DatabaseSync> | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const columns = new Set(
			db
				.prepare("PRAGMA table_info(conversation_summaries)")
				.all()
				.map((row) => row.name),
		);
		const title = columns.has("title") ? "title" : "NULL AS title";
		const active = columns.has("not_fully_idle")
			? "not_fully_idle"
			: "0 AS not_fully_idle";
		const query = db.prepare(
			`SELECT status, ${title}, ${active} FROM conversation_summaries WHERE conversation_id = ?`,
		);
		for (const id of ids) {
			const row = query.get(id);
			if (!row) continue;
			let status: AgentStatus = "unknown";
			switch (row.status) {
				case "CASCADE_RUN_STATUS_IDLE":
					status = row.not_fully_idle === 1 ? "busy" : "idle";
					break;
				case "CASCADE_RUN_STATUS_BUSY":
				case "CASCADE_RUN_STATUS_RUNNING":
				case "CASCADE_RUN_STATUS_CANCELING":
					status = "busy";
					break;
			}
			const name = typeof row.title === "string" ? row.title.trim() : "";
			summaries.set(id, { status, ...(name ? { title: name } : {}) });
		}
	} catch {
		// A missing, locked, or older summary database cannot establish a status.
	} finally {
		db?.close();
	}
	return summaries;
}
