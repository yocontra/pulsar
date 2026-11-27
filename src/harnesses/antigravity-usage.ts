import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FileState, UsageRecord } from "../usage/parse.ts";
import {
	ANTIGRAVITY_SESSION_ID,
	antigravityConversations,
} from "./antigravity-ident.ts";
import { message, utf8 } from "./antigravity-proto.ts";

function open(path: string) {
	const sqlite = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	return new sqlite.DatabaseSync(path, { readOnly: true });
}

function varint(bytes: Uint8Array, offset: number) {
	let value = 0;
	for (let shift = 0; offset < bytes.length && shift < 56; shift += 7) {
		const b = bytes[offset++]!;
		value += (b & 127) * 2 ** shift;
		if (b < 128 && Number.isSafeInteger(value)) return { value, offset };
	}
	throw new Error("Invalid generation index");
}

type Slice = { at: number; length: number };

/** Seek over prompt and history fields. Only token and model metadata leave the source DB. */
function generation(db: DatabaseSync, idx: number, size: number) {
	const query = db.prepare(
		"SELECT substr(data,?,?) AS part FROM gen_metadata WHERE idx=?",
	);
	let cache = new Uint8Array(0),
		start = -1;
	function read(at: number, length: number) {
		if (at < start || at + length > start + cache.length) {
			cache = query.get(at + 1, Math.max(2048, length), idx)!
				.part as typeof cache;
			start = at;
		}
		return cache.subarray(at - start, at - start + length);
	}
	function selected(range: Slice, keys: number[]) {
		const end = range.at + range.length;
		const found = new Map<number, Slice>();
		for (let at = range.at; at < end; ) {
			const header = read(at, Math.min(20, end - at));
			const tag = varint(header, 0);
			const wire = tag.value % 8;
			const field = Math.floor(tag.value / 8);
			if (wire === 2) {
				const len = varint(header, tag.offset);
				at += len.offset;
				if (len.value > end - at) throw new Error("Invalid generation field");
				if (keys.includes(field)) found.set(field, { at, length: len.value });
				at += len.value;
			} else if (wire === 0) {
				// Only the byte length matters when skipping uint64s.
				let i = tag.offset;
				while (i < header.length && header[i]! >= 128) i++;
				if (i === header.length) throw new Error("Invalid generation scalar");
				at += i + 1;
			} else if (wire === 1 || wire === 5)
				at += tag.offset + (wire === 1 ? 8 : 4);
			else throw new Error("Unsupported generation field");
		}
		return found;
	}
	function bytes(s: Slice | undefined, max = 65536) {
		return s && s.length <= max ? read(s.at, s.length) : undefined;
	}
	const root = selected({ at: 0, length: size }, [1, 2]);
	const stats = root.get(1);
	if (!stats) return null;
	const meta = selected(stats, [4, 9, 18, 19, 21]);
	const raw = utf8(bytes(meta.get(19), 256)) || utf8(bytes(meta.get(18), 256));
	const display = utf8(bytes(meta.get(21), 256));
	const namedModel = (
		raw ||
		display
			.toLowerCase()
			.replace(/\s*\((?:low|medium|high|xhigh)\)$/i, "")
			.replace(/\s+/g, "-")
	).replace(/-tiered-(?:low|medium|high|xhigh)$/, "");
	const packed = root.get(2);
	const step = packed?.length
		? varint(read(packed.at, Math.min(10, packed.length)), 0).value
		: null;
	const usage = message(bytes(meta.get(4)));
	const context = message(message(bytes(meta.get(9))).get(10));
	const modelId = count(usage.get(1));
	return {
		model: namedModel || (modelId ? `antigravity-model-${modelId}` : ""),
		step,
		usage,
		context,
	};
}

function count(raw: number | Uint8Array | undefined) {
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0
		? raw
		: 0;
}

export function antigravityModel(
	sessionId: string | null | undefined,
	directory = antigravityConversations(),
) {
	if (!sessionId || !ANTIGRAVITY_SESSION_ID.test(sessionId)) return null;
	let db: DatabaseSync | undefined;
	try {
		db = open(join(directory, `${sessionId}.db`));
		if (
			!db
				.prepare("SELECT 1 FROM trajectory_meta WHERE cascade_id=? LIMIT 1")
				.get(sessionId)
		)
			return null;
		for (const r of db
			.prepare(
				"SELECT idx,length(data) AS size FROM gen_metadata ORDER BY idx DESC LIMIT 8",
			)
			.all()) {
			const gen = generation(db, Number(r.idx), Number(r.size));
			if (gen?.model) return gen.model;
		}
	} catch {
		/* A session may have no completed calls. */
	} finally {
		db?.close();
	}
	return null;
}

/** Read one provider response per generation. A single response can produce many steps. */
export async function antigravityUsage(path: string, session: string) {
	const db = open(path);
	try {
		db.exec("BEGIN");
		if (
			!db
				.prepare("SELECT 1 FROM trajectory_meta WHERE cascade_id=? LIMIT 1")
				.get(session)
		)
			return null;

		const rows = db
			.prepare("SELECT idx,length(data) AS size FROM gen_metadata ORDER BY idx")
			.all();
		const clock = db.prepare(
			"SELECT metadata FROM steps WHERE idx=? AND length(metadata)<=65536",
		);
		const records: UsageRecord[] = [];
		const state: FileState = {};
		let yieldAt = performance.now() + 8;
		for (const row of rows) {
			if (performance.now() >= yieldAt) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				yieldAt = performance.now() + 8;
			}
			try {
				const g = generation(db, Number(row.idx), Number(row.size));
				if (!g?.model || g.step === null) continue;
				state.model = g.model;
				const used = g.context.get(1),
					window = g.context.get(4);
				state.context =
					typeof used === "number"
						? { used, window: count(window) || null }
						: undefined;
				const time = message(
					message(clock.get(g.step)?.metadata as Uint8Array | undefined).get(1),
				);
				const t =
					count(time.get(1)) * 1000 + Math.floor(count(time.get(2)) / 1000000);
				if (!t || !g.usage.size) continue;
				const u = g.usage;
				const id = utf8(u.get(7)) || utf8(u.get(11));
				const rec = {
					t,
					model: g.model,
					input: count(u.get(2)),
					output: count(u.get(3)),
					cacheRead: count(u.get(5)),
					cacheWrite5m: count(u.get(4)),
					cacheWrite1h: 0,
					dedupeId: id || `${session}/${row.idx}`,
				};
				if (rec.input || rec.output || rec.cacheRead || rec.cacheWrite5m)
					records.push(rec);
			} catch {
				/* Ignore a malformed generation without dropping its neighbors. */
			}
		}
		return { records, state };
	} finally {
		db.close();
	}
}
