import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { freshProcessSnapshot, processStart } from "../processes.ts";
import type { TranscriptEvent, TranscriptPage } from "../transcripts/types.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityConversations,
	antigravityIdent,
	antigravityProcess,
	nativeAntigravityProcess,
} from "./antigravity-ident.ts";
import { fields, message, utf8 } from "./antigravity-proto.ts";
import { antigravityStatuses } from "./antigravity-status.ts";
import { antigravityStepEvents } from "./antigravity-steps.ts";
import type { HarnessDriver } from "./types.ts";

const PAGE_SIZE = 100;
const MAX_PAYLOAD_BYTES = 256 * 1024;
interface Step {
	idx: number;
	step_type: number;
	step_payload: Uint8Array;
}

function antigravityEvents(sessionId: string, row: Step): TranscriptEvent[] {
	try {
		const root = fields(row.step_payload);
		const clock = message(message(root.get(5)).get(1));
		const seconds = clock.get(1);
		if (
			typeof seconds !== "number" ||
			!Number.isSafeInteger(seconds) ||
			seconds <= 0
		)
			return [];
		const nanos = clock.get(2);
		const base = {
			id: `${sessionId}#${row.idx}`,
			ts:
				seconds * 1000 +
				(typeof nanos === "number" && nanos < 1e9
					? Math.floor(nanos / 1e6)
					: 0),
		};
		const events: TranscriptEvent[] = [];
		if (row.step_type === 14 || row.step_type === 15) {
			const user = row.step_type === 14;
			const text = utf8(message(root.get(user ? 19 : 20)).get(user ? 2 : 1));
			if (text)
				events.push({
					...base,
					role: user ? "user" : "assistant",
					kind: "text",
					text,
				});
		}
		return [...events, ...antigravityStepEvents(row.step_type, root, base)];
	} catch {
		return [];
	}
}

export function antigravityPage(
	path: string,
	sessionId: string,
	cursor: string | null,
): TranscriptPage {
	const before = cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor);
	if (!Number.isSafeInteger(before) || before < 0)
		return { events: [], cursor: null };
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		const rows = db
			.prepare(`SELECT idx, step_type, step_payload FROM steps
			WHERE idx < ? AND step_format = 0
			AND length(step_payload) <= ? ORDER BY idx DESC LIMIT ?`)
			.all(before, MAX_PAYLOAD_BYTES, PAGE_SIZE + 1) as unknown as Step[];
		const events = rows
			.slice(0, PAGE_SIZE)
			.reverse()
			.flatMap((row) => antigravityEvents(sessionId, row));
		return {
			events,
			cursor: rows.length > PAGE_SIZE ? String(rows[PAGE_SIZE - 1]!.idx) : null,
		};
	} finally {
		db.close();
	}
}

async function fileSignature(path: string) {
	try {
		const info = await stat(path, { bigint: true });
		return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export function antigravitySource(path: string, sessionId: string) {
	let lastSignature: string | undefined;
	return {
		kind: "poll" as const,
		fetch: async (cursor: string | null) =>
			antigravityPage(path, sessionId, cursor),
		async poll() {
			const [db, wal] = await Promise.all([
				fileSignature(path),
				fileSignature(`${path}-wal`),
			]);
			if (!db) {
				lastSignature = undefined;
				return null;
			}
			const signature = `${db}|${wal ?? ""}`;
			if (signature === lastSignature) return null;
			const page = antigravityPage(path, sessionId, null);
			// Use the stamps taken before the read so a concurrent commit is
			// still detected on the next poll.
			lastSignature = signature;
			return page;
		},
	};
}

export const antigravity: HarnessDriver = {
	...antigravityIdent,
	scan: {
		intervalMs: 20_000,
		tracksPid: true,
		async sessions() {
			const table = await freshProcessSnapshot();
			if (!table) throw new Error("Antigravity process table unavailable");
			const matches = [...table.values()].filter((p) =>
				nativeAntigravityProcess(p.args),
			);
			const sessions = await Promise.all(
				matches.map(async ({ pid }) => {
					const [{ cwd, sessionId }, birth] = await Promise.all([
						antigravityProcess(pid),
						processStart(pid, "background"),
					]);
					const meta: Record<string, string> = {};
					if (birth) meta.processStart = birth;
					return {
						harness: "antigravity",
						sessionId: sessionId ?? `pid:${pid}`,
						pid,
						cwd,
						meta,
					};
				}),
			);
			const statuses = antigravityStatuses(
				join(dirname(antigravityConversations()), "conversation_summaries.db"),
				sessions
					.map((s) => s.sessionId)
					.filter((id) => ANTIGRAVITY_SESSION_ID.test(id)),
			);
			return sessions.map((s) => ({
				...s,
				status: statuses.get(s.sessionId) ?? "unknown",
			}));
		},
	},
	transcript: {
		async locate(agent) {
			const explicit =
				agent.sessionId && ANTIGRAVITY_SESSION_ID.test(agent.sessionId)
					? agent.sessionId
					: null;
			const id =
				explicit ?? (await antigravityProcess(agent.pid ?? null)).sessionId;
			if (!id) return null;
			const path = join(antigravityConversations(), `${id}.db`);
			if (!(await stat(path).catch(() => null))?.isFile()) return null;
			return antigravitySource(path, id);
		},
		parse: () => [],
	},
};
