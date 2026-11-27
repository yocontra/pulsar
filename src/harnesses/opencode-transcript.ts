import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parsePush } from "../push-frame.ts";
import {
	callEvent,
	contentText,
	obj,
	pushEvent,
	resultEvents,
	str,
} from "../transcripts/summary.ts";
import {
	newParseState,
	type ParseState,
	type TranscriptEvent,
	type TranscriptPage,
	type TranscriptSupport,
} from "../transcripts/types.ts";
import type { SessionRef } from "./types.ts";

export function opencodeDbPath(): string {
	const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(data, "opencode", "opencode.db");
}

function open(path: string) {
	const sqlite = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	return new sqlite.DatabaseSync(path, { readOnly: true });
}

export function nativeOpencodeId(id: string) {
	return /^ses_[A-Za-z0-9]{1,100}$/.test(id);
}

export async function readOpencodeSession(id: string) {
	if (!nativeOpencodeId(id)) return null;
	try {
		const db = open(opencodeDbPath());
		try {
			const row = db
				.prepare(
					"SELECT directory, time_updated FROM session_v2 WHERE id = ? AND parent_id IS NULL",
				)
				.get(id);
			return typeof row?.directory === "string" &&
				isAbsolute(row.directory) &&
				typeof row.time_updated === "number"
				? { cwd: row.directory, lastSeen: row.time_updated }
				: null;
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

interface Row {
	id: string;
	seq: number;
	type: string;
	time_created: number;
	data: string;
}

function events(row: Row, state: ParseState): TranscriptEvent[] {
	let data: Record<string, unknown> | null;
	try {
		data = obj(JSON.parse(row.data));
	} catch {
		return [];
	}
	if (!data) return [];
	const base = { id: row.id, ts: row.time_created };
	if (row.type === "user" && typeof data.text === "string") {
		const push = parsePush(data.text);
		return [
			push
				? pushEvent(base, push)
				: { ...base, role: "user", kind: "text", text: data.text },
		];
	}
	if (row.type === "compaction" && data.status === "completed")
		return [
			{
				...base,
				role: "system",
				kind: "system",
				subtype: "compacted",
				text: "Conversation compacted",
			},
		];
	if (row.type !== "assistant") return [];
	const out: TranscriptEvent[] = [];
	const model = str(obj(data.model)?.id);
	const parts = Array.isArray(data.content) ? data.content : [];
	for (const [index, part] of parts.entries()) {
		const block = obj(part);
		if (!block) continue;
		const item = { ...base, id: `${row.id}#${index}`, model };
		if (block.type === "text" && typeof block.text === "string" && block.text)
			out.push({ ...item, role: "assistant", kind: "text", text: block.text });
		if (block.type === "tool" && typeof block.name === "string") {
			const callId = str(block.id) ?? item.id;
			const status = obj(block.state);
			const call = callEvent(state, item, block.name, callId, status?.input);
			if (
				status?.status === "completed" ||
				status?.status === "error" ||
				status?.status === "failed"
			) {
				const output = contentText(status.content) || str(status.error) || "";
				out.push(
					...resultEvents(
						state,
						{ ...item, id: `${item.id}:result` },
						callId,
						output,
						status.status !== "completed",
					),
				);
			} else out.push(call);
		}
	}
	const error = str(obj(data.error)?.message);
	if (error)
		out.push({
			...base,
			id: `${row.id}#error`,
			role: "system",
			kind: "system",
			text: error,
		});
	return out;
}

const PAGE = 40;
const windowQuery =
	"FROM session_message WHERE session_id = ? AND seq < ? AND type IN ('assistant','user','compaction') ORDER BY seq DESC LIMIT ?";

export const opencodeTranscript: TranscriptSupport<SessionRef> = {
	needsSession: true,
	locate({ sessionId, cwd }) {
		if (!sessionId) return null;
		const path = opencodeDbPath();
		try {
			const db = open(path);
			try {
				if (!db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(sessionId))
					return null;
			} finally {
				db.close();
			}
		} catch {
			return null;
		}
		let lastStamp: string | undefined;
		function read(cursor: string | null, changesOnly: false): TranscriptPage;
		function read(
			cursor: string | null,
			changesOnly: true,
		): TranscriptPage | null;
		function read(
			cursor: string | null,
			changesOnly: boolean,
		): TranscriptPage | null {
			const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
			if (!Number.isSafeInteger(before)) return { events: [], cursor: null };
			const db = open(path);
			try {
				let stamp: string | undefined;
				if (changesOnly) {
					db.exec("BEGIN");
					stamp = JSON.stringify(
						db
							.prepare(`SELECT seq, time_updated ${windowQuery}`)
							.all(sessionId!, before, PAGE),
					);
					if (stamp === lastStamp) return null;
				}
				const rows = db
					.prepare(`SELECT id, seq, type, time_created, data ${windowQuery}`)
					.all(sessionId!, before, PAGE + 1) as unknown as Row[];
				const page = rows.slice(0, PAGE).reverse();
				const state = newParseState({ cwd });
				const result = {
					events: page.flatMap((row) => events(row, state)),
					cursor: rows.length > PAGE ? String(page[0]!.seq) : null,
				};
				if (changesOnly) lastStamp = stamp;
				return result;
			} finally {
				db.close();
			}
		}
		return {
			kind: "poll",
			intervalMs: 2500,
			fetch: async (cursor) => read(cursor, false),
			poll: async () => read(null, true),
		};
	},
	parse: () => [],
};
