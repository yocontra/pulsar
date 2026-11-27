import { lstat, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freshProcessSnapshot, processStart } from "../processes.ts";
import { toolAction } from "../transcripts/activity.ts";
import type { TranscriptEvent, TranscriptPage } from "../transcripts/types.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityConversations,
	antigravityIdent,
	antigravityProcess,
	nativeAntigravityProcess,
} from "./antigravity-ident.ts";
import { fields, message, utf8 } from "./antigravity-proto.ts";
import { antigravitySummaries } from "./antigravity-status.ts";
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
	pageSize = PAGE_SIZE,
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
			.all(before, MAX_PAYLOAD_BYTES, pageSize + 1) as unknown as Step[];
		const events = rows
			.slice(0, pageSize)
			.reverse()
			.flatMap((row) => antigravityEvents(sessionId, row));
		return {
			events,
			cursor: rows.length > pageSize ? String(rows[pageSize - 1]!.idx) : null,
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

export async function readAntigravitySession(
	sessionId: string,
	directory = antigravityConversations(),
) {
	if (!ANTIGRAVITY_SESSION_ID.test(sessionId)) return null;
	const path = join(directory, `${sessionId}.db`);
	const info = await lstat(path).catch(() => null);
	if (!info?.isFile()) return null;
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	let db: InstanceType<typeof DatabaseSync> | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		if (
			!db
				.prepare("SELECT 1 FROM trajectory_meta WHERE cascade_id = ? LIMIT 1")
				.get(sessionId)
		)
			return null;
	} catch {
		return null;
	} finally {
		db?.close();
	}
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
				lastSeen: Number.isFinite(time) ? time : info.mtimeMs,
			};
		}
	} catch {
		// The conversation database can outlive its summary.
	} finally {
		summaries?.close();
	}
	return { cwd: null, lastSeen: info.mtimeMs };
}

export const antigravity: HarnessDriver = {
	...antigravityIdent,
	readSession: readAntigravitySession,
	async activity({ sessionId }) {
		if (!sessionId || !ANTIGRAVITY_SESSION_ID.test(sessionId)) return null;
		const path = join(antigravityConversations(), `${sessionId}.db`);
		const { events } = antigravityPage(path, sessionId, null, 8);
		for (const e of events.reverse()) {
			if (e.tool?.isError) return "Tool returned an error";
			if (e.tool) return toolAction(e.tool.name, e.kind === "tool_result");
			if (e.notice?.summary) return e.notice.summary;
			if (e.role === "assistant") return "Sent a reply";
			if (e.role === "user") return "Received a prompt";
		}
		return null;
	},
	resumeArgs: (id) =>
		ANTIGRAVITY_SESSION_ID.test(id) ? ["agy", "--conversation", id] : null,
	async verifyWakeHost(pid, sessionId) {
		if (!ANTIGRAVITY_SESSION_ID.test(sessionId)) return null;
		const table = await freshProcessSnapshot(0, "user");
		const host = table?.get(pid);
		if (!host || !nativeAntigravityProcess(host.args)) return null;
		const actual = await antigravityProcess(pid);
		return actual.sessionId === sessionId ? { cwd: actual.cwd } : null;
	},
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
			const summaries = antigravitySummaries(
				join(dirname(antigravityConversations()), "conversation_summaries.db"),
				sessions
					.map((s) => s.sessionId)
					.filter((id) => ANTIGRAVITY_SESSION_ID.test(id)),
			);
			return sessions.map((s) => {
				const info = summaries.get(s.sessionId);
				if (info?.title) {
					s.meta.harnessName = info.title;
					s.meta.harnessNameSource = "auto";
				}
				return { ...s, status: info?.status ?? "unknown" };
			});
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
