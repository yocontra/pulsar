import { createRequire } from "node:module";
import type { AgentStatus } from "../types.ts";

/** Read only the native conversations found by this process scan. */
export function antigravityStatuses(path: string, ids: string[]) {
	const statuses = new Map<string, AgentStatus>();
	if (!ids.length) return statuses;
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	let db: InstanceType<typeof DatabaseSync> | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		const query = db.prepare(
			"SELECT status FROM conversation_summaries WHERE conversation_id = ?",
		);
		for (const id of ids) {
			switch (query.get(id)?.status) {
				case "CASCADE_RUN_STATUS_IDLE":
					statuses.set(id, "idle");
					break;
				case "CASCADE_RUN_STATUS_BUSY":
				case "CASCADE_RUN_STATUS_RUNNING":
				case "CASCADE_RUN_STATUS_CANCELING":
					statuses.set(id, "busy");
					break;
			}
		}
	} catch {
		// A missing, locked, or older summary database cannot establish a status.
	} finally {
		db?.close();
	}
	return statuses;
}
