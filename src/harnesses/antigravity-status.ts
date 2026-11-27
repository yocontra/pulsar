import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function savedWorkspace(uris: unknown): string | null {
	if (typeof uris !== "string") return null;
	try {
		const values: unknown = JSON.parse(uris);
		if (Array.isArray(values)) {
			for (const value of values) {
				if (typeof value !== "string") continue;
				try {
					const url = new URL(value);
					if (url.protocol === "file:" && !url.hostname)
						return fileURLToPath(url);
				} catch {
					// Another workspace in the list can still identify the local project.
				}
			}
		}
	} catch {
		// Some older summaries do not have a workspace list.
	}
	return null;
}

export function savedAntigravitySummary(directory: string, sessionId: string) {
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	let summaries: InstanceType<typeof DatabaseSync> | undefined;
	try {
		summaries = new DatabaseSync(
			join(dirname(directory), "conversation_summaries.db"),
			{ readOnly: true },
		);
		const summary = summaries
			.prepare(
				"SELECT workspace_uris, title, last_modified_time FROM conversation_summaries WHERE conversation_id = ?",
			)
			.get(sessionId);
		if (summary) {
			const name =
				typeof summary.title === "string" ? summary.title.trim() : "";
			const time =
				typeof summary.last_modified_time === "string"
					? Date.parse(summary.last_modified_time)
					: NaN;
			return {
				cwd: savedWorkspace(summary.workspace_uris),
				...(name ? { name } : {}),
				...(Number.isFinite(time) ? { lastSeen: time } : {}),
			};
		}
	} catch {
		// The conversation database can outlive its summary.
	} finally {
		summaries?.close();
	}
	return { cwd: null };
}
