import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ANTIGRAVITY_SESSION_ID } from "./antigravity-ident.ts";
import type {
	FoundSubagent,
	HarnessDriver,
	SubagentTranscript,
} from "./types.ts";

const MAX_CHILDREN = 200;
const MAX_DEPTH = 12;

function string(value: unknown, max: number): string | null {
	return typeof value === "string" ? value.trim().slice(0, max) || null : null;
}

function state(row: Record<string, unknown>): FoundSubagent["state"] {
	if (row.killed === 1) return "done";
	switch (row.status) {
		case "CASCADE_RUN_STATUS_BUSY":
		case "CASCADE_RUN_STATUS_RUNNING":
		case "CASCADE_RUN_STATUS_CANCELING":
			return "running";
		case "CASCADE_RUN_STATUS_IDLE":
			return row.not_fully_idle === 1 ? "running" : "idle";
		default:
			return "unknown";
	}
}

function rows(directory: string, root: string): Record<string, unknown>[] {
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	let db: InstanceType<typeof DatabaseSync> | undefined;
	try {
		db = new DatabaseSync(
			join(dirname(directory), "conversation_summaries.db"),
			{
				readOnly: true,
			},
		);
		const columns = new Set(
			db
				.prepare("PRAGMA table_info(conversation_summaries)")
				.all()
				.map((row) => row.name),
		);
		if (!columns.has("parent_conversation_id")) return [];
		const agentName = columns.has("agent_name")
			? "s.agent_name"
			: "NULL AS agent_name";
		const active = columns.has("not_fully_idle")
			? "s.not_fully_idle"
			: "0 AS not_fully_idle";
		const killed = columns.has("killed") ? "s.killed" : "0 AS killed";
		// Workspace tasks can appear in other Antigravity stores. Use only
		// the native conversation index's explicit parent association.
		return db
			.prepare(`
			WITH RECURSIVE children(id, depth) AS (
				SELECT conversation_id, 1
				FROM conversation_summaries
				WHERE parent_conversation_id = ?1 AND conversation_id <> ?1
				UNION ALL
				SELECT summaries.conversation_id, children.depth + 1
				FROM conversation_summaries AS summaries
				JOIN children ON summaries.parent_conversation_id = children.id
				WHERE children.depth < ${MAX_DEPTH} AND summaries.conversation_id <> ?1
				LIMIT ${MAX_CHILDREN}
			)
			SELECT
				s.conversation_id, s.parent_conversation_id, s.title,
				${agentName}, s.last_modified_time, s.status,
				${active}, ${killed}
			FROM children
			JOIN conversation_summaries AS s ON s.conversation_id = children.id
			ORDER BY children.depth
		`)
			.all(root);
	} catch {
		return [];
	} finally {
		db?.close();
	}
}

/** Only a live descendant explicitly named in the native index is addressable. */
export function antigravityChildOf(
	directory: string,
	root: string,
	child: string,
) {
	if (
		root === child ||
		!ANTIGRAVITY_SESSION_ID.test(root) ||
		!ANTIGRAVITY_SESSION_ID.test(child)
	)
		return false;
	const active = new Set([root]);
	for (const row of rows(directory, root)) {
		const id = row.conversation_id;
		if (
			typeof id !== "string" ||
			!ANTIGRAVITY_SESSION_ID.test(id) ||
			typeof row.parent_conversation_id !== "string" ||
			!active.has(row.parent_conversation_id) ||
			state(row) === "done"
		)
			continue;
		if (id === child) return true;
		active.add(id);
	}
	return false;
}

export function antigravityChildSupport(
	conversations: () => string,
	transcript: (
		sessionId: string,
		path: string,
	) => Promise<SubagentTranscript | null>,
): NonNullable<HarnessDriver["subagents"]> {
	return {
		invocationHook: true,
		async stamp(agent) {
			if (!agent.sessionId || !ANTIGRAVITY_SESSION_ID.test(agent.sessionId))
				return null;
			const summary = join(
				dirname(conversations()),
				"conversation_summaries.db",
			);
			const times = await Promise.all(
				[summary, `${summary}-wal`].map((file) =>
					stat(file).then(
						({ mtimeMs }) => mtimeMs,
						() => null,
					),
				),
			);
			return times[0] == null ? null : times.join(":");
		},
		async list(agent) {
			const root = agent.sessionId;
			if (!root || !ANTIGRAVITY_SESSION_ID.test(root)) return [];
			const directory = conversations();
			const found = rows(directory, root);
			const eligible = new Set([root]);
			const result: FoundSubagent[] = [];
			for (const row of found) {
				const key = row.conversation_id;
				const parent = row.parent_conversation_id;
				if (
					typeof key !== "string" ||
					!ANTIGRAVITY_SESSION_ID.test(key) ||
					typeof parent !== "string" ||
					!eligible.has(parent) ||
					eligible.has(key)
				)
					continue;
				eligible.add(key);
				const path = join(directory, `${key}.db`);
				const file = await lstat(path).catch(() => null);
				const modified =
					typeof row.last_modified_time === "string"
						? Date.parse(row.last_modified_time)
						: NaN;
				const updatedAt = Number.isFinite(modified)
					? modified
					: (file?.mtimeMs ?? 0);
				const born = file?.birthtimeMs;
				const status = state(row);
				const name = string(row.agent_name, 120);
				result.push({
					key,
					sessionId: key,
					file: file?.isFile() ? path : null,
					fileAvailable: file?.isFile() === true,
					name: string(row.title, 120) ?? name ?? "Antigravity child",
					kind: "session",
					agentType: name,
					description: null,
					state: status,
					startedAt: born && born <= updatedAt ? born : updatedAt,
					updatedAt,
					finishedAt: status === "done" ? updatedAt : null,
					callId: null,
					parentKey: parent === root ? null : parent,
				});
			}
			return result;
		},
		async transcript(_agent, child) {
			return child.sessionId && child.file
				? await transcript(child.sessionId, child.file)
				: null;
		},
	};
}
