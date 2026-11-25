import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { freshProcessSnapshot, processStart } from "../processes.ts";
import type { TranscriptEvent, TranscriptPage } from "../transcripts/types.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityConversations,
	antigravityIdent,
	antigravityProcess,
	nativeAntigravityProcess,
} from "./antigravity-ident.ts";
import type { HarnessDriver } from "./types.ts";

const PAGE_SIZE = 100;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const decode = new TextDecoder("utf-8", { fatal: true });

/** Minimal protobuf reader for the public text steps of an agy trajectory. */
function fields(bytes: Uint8Array) {
	let offset = 0;
	const result = new Map<number, number | Uint8Array>();
	function varint() {
		let value = 0;
		for (let shift = 0; shift < 70 && offset < bytes.length; shift += 7) {
			const byte = bytes[offset++]!;
			value += (byte & 127) * 2 ** shift;
			if (byte < 128) return value;
		}
		throw new Error("Invalid protobuf varint");
	}
	while (offset < bytes.length) {
		const tag = varint();
		const field = Math.floor(tag / 8);
		const wire = tag % 8;
		if (!field || !Number.isSafeInteger(tag))
			throw new Error("Invalid protobuf field");
		if (wire === 0) result.set(field, varint());
		else if (wire === 2) {
			const length = varint();
			if (length > bytes.length - offset)
				throw new Error("Truncated protobuf bytes");
			result.set(field, bytes.subarray(offset, offset + length));
			offset += length;
		} else if (wire === 1 || wire === 5) {
			offset += wire === 1 ? 8 : 4;
			if (offset > bytes.length) throw new Error("Truncated protobuf field");
		} else throw new Error("Unsupported protobuf field");
	}
	return result;
}

function message(raw: number | Uint8Array | undefined) {
	return raw instanceof Uint8Array
		? fields(raw)
		: new Map<number, number | Uint8Array>();
}

interface Step {
	idx: number;
	step_type: number;
	step_payload: Uint8Array;
}

export function antigravityEvent(
	sessionId: string,
	row: Step,
): TranscriptEvent | null {
	try {
		const user = row.step_type === 14;
		if (!user && row.step_type !== 15) return null;
		const root = fields(row.step_payload);
		// User input is 19.2, visible agent output is 20.1. Ignore internal reasoning and tooling.
		const text = message(root.get(user ? 19 : 20)).get(user ? 2 : 1);
		if (!(text instanceof Uint8Array) || !text.length) return null;
		const clock = message(message(root.get(5)).get(1));
		const seconds = clock.get(1);
		if (
			typeof seconds !== "number" ||
			!Number.isSafeInteger(seconds) ||
			seconds <= 0
		)
			return null;
		const nanos = clock.get(2);
		return {
			id: `${sessionId}#${row.idx}`,
			role: user ? "user" : "assistant",
			kind: "text",
			ts:
				seconds * 1000 +
				(typeof nanos === "number" && nanos < 1e9
					? Math.floor(nanos / 1e6)
					: 0),
			text: decode.decode(text),
		};
	} catch {
		return null;
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
			WHERE idx < ? AND step_format = 0 AND step_type IN (14, 15)
			AND length(step_payload) <= ? ORDER BY idx DESC LIMIT ?`)
			.all(before, MAX_PAYLOAD_BYTES, PAGE_SIZE + 1) as unknown as Step[];
		const events = rows
			.slice(0, PAGE_SIZE)
			.reverse()
			.flatMap((row) => {
				const event = antigravityEvent(sessionId, row);
				return event ? [event] : [];
			});
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
			return Promise.all(
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
						status: "unknown",
						meta,
					};
				}),
			);
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
