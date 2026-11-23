/**
 * Plan limit readings that are not in session files (src/usage/limits.ts
 * reads those). Both are local reads; Pulsar makes no network call for them.
 *
 * - Claude Code keeps its last `/usage` answer in `.claude.json`
 *   (`cachedUsageUtilization`: `fetchedAtMs`, and per window a
 *   `utilization` percent and `resets_at`). Claude Code refreshes it only
 *   when the operator opens `/usage`, so a reading can be days old: it keeps
 *   `fetchedAtMs` as its time. Only the plan's name (`planDisplayName`) is
 *   kept from the account; never its id, email or organization.
 * - OpenCode 2 writes an OpenCode Go hard stop as an assistant message in
 *   its database (`session_message`): `error.type` "provider.go-limit",
 *   `retryAfterMs` until the reset, and the window ("rolling", "weekly",
 *   "monthly") in the message. The message text is never kept. A later
 *   assistant answer from the same provider without an error ends it.
 */

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { LimitState } from "../http/wire.ts";
import { answeredKey, claudeWindow } from "./limits.ts";

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const fin = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

function time(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

/** Claude Code's global state file (`$CLAUDE_CONFIG_DIR/.claude.json` when set). */
export function claudeStatePath(): string {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	return dir ? join(dir, ".claude.json") : join(homedir(), ".claude.json");
}

/** OpenCode's database, in its XDG data folder. */
export function opencodeDbPath(): string {
	const data = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
	return join(data, "opencode", "opencode.db");
}

/**
 * The windows Claude Code's `/usage` names (the other keys in its answer
 * are internal names, not limits to show).
 */
const CLAUDE_WINDOWS = [
	"five_hour",
	"seven_day",
	"seven_day_opus",
	"seven_day_sonnet",
] as const;

/**
 * The readings in Claude Code's state file (parsed). Same `account` and
 * `window` as a hard stop in a session file, so the newer of the two shows.
 */
export function claudeCachedLimits(state: unknown): LimitState[] {
	const s = obj(state);
	const cache = obj(s?.cachedUsageUtilization);
	const u = obj(cache?.utilization);
	const at = fin(cache?.fetchedAtMs);
	if (!u || at === null) return [];
	const planName = str(obj(s?.oauthAccount)?.planDisplayName);
	const plan = planName ? planName.slice(0, 40) : null;
	const out: LimitState[] = [];
	for (const key of CLAUDE_WINDOWS) {
		const w = obj(u[key]);
		const used = fin(w?.utilization);
		if (!w || used === null) continue;
		const pct = Math.max(0, Math.min(100, used));
		out.push({
			harness: "claude",
			account: "",
			window: key,
			label: claudeWindow(key).label,
			usedPercent: pct,
			reached: pct >= 100,
			resetsAt: time(w.resets_at),
			at,
			plan,
		});
	}
	return out;
}

/** Reads Claude Code's state file when it changed since `seen` (mtime). */
export async function readClaudeCached(
	path: string,
	seen: number | null,
): Promise<{ mtime: number; limits: LimitState[] } | null> {
	try {
		const st = await stat(path);
		const mtime = Math.floor(st.mtimeMs);
		if (!st.isFile() || mtime === seen) return null;
		// Large configs are not Claude Code's (it is a few hundred KB).
		if (st.size > 32 << 20) return { mtime, limits: [] };
		const text = await readFile(path, "utf8");
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(text);
		} catch {
			// Mid-write: read again on the next scan.
			return null;
		}
		return { mtime, limits: claudeCachedLimits(parsed) };
	} catch {
		return null;
	}
}

/** One OpenCode assistant message, as the queries below select it. */
export interface OpencodeRow {
	t: number;
	provider: string | null;
	errorType: string | null;
	retryAfterMs: number | null;
	message: string | null;
}

const GO_WINDOWS: Record<string, string> = {
	rolling: "Rolling",
	weekly: "Weekly",
	monthly: "Monthly",
};

/** An OpenCode Go hard stop, or null for any other message. */
export function opencodeLimit(r: OpencodeRow): LimitState | null {
	if (r.errorType !== "provider.go-limit") return null;
	const period = /\b(rolling|weekly|monthly)\b/i
		.exec(r.message ?? "")?.[1]
		?.toLowerCase();
	const retry = r.retryAfterMs !== null && r.retryAfterMs > 0;
	return {
		harness: "opencode",
		account: (r.provider ?? "opencode-go").slice(0, 80),
		window: period ?? "usage",
		label: period ? GO_WINDOWS[period]! : "Usage",
		usedPercent: 100,
		reached: true,
		resetsAt: retry ? r.t + r.retryAfterMs! : null,
		at: r.t,
		plan: null,
	};
}

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");

/**
 * New OpenCode hard stops and answers since `cursor` (a `session_message`
 * rowid; null on the first read: only the last `firstMs`). Opens the
 * database read-only; a missing database or an older OpenCode (no
 * `session_message`) gives nothing.
 */
export function readOpencodeLimits(
	path: string,
	cursor: number | null,
	now: number,
	firstMs: number,
): {
	cursor: number | null;
	limits: LimitState[];
	answered: Map<string, number>;
} {
	const none = { cursor, limits: [], answered: new Map<string, number>() };
	let db: DatabaseSyncType | null = null;
	try {
		db = new DatabaseSync(path, { readOnly: true });
		db.exec("PRAGMA busy_timeout = 500");
		const top = db
			.prepare("SELECT max(rowid) AS id FROM session_message")
			.get() as { id: number | null } | undefined;
		const max = fin(top?.id);
		if (max === null || max === cursor) return { ...none, cursor: max };
		const from = cursor ?? 0;
		const since = cursor === null ? now - firstMs : 0;
		const rows = db
			.prepare(
				`SELECT time_created AS t,
	json_extract(data, '$.model.providerID') AS provider,
	json_extract(data, '$.error.type') AS errorType,
	json_extract(data, '$.error.retryAfterMs') AS retryAfterMs,
	json_extract(data, '$.error.message') AS message
FROM session_message
WHERE rowid > ? AND rowid <= ? AND time_created >= ? AND type = 'assistant'
	AND json_extract(data, '$.error.type') = 'provider.go-limit'`,
			)
			.all(from, max, since) as unknown as OpencodeRow[];
		const answers = db
			.prepare(
				`SELECT json_extract(data, '$.model.providerID') AS provider, max(time_created) AS t
FROM session_message
WHERE rowid > ? AND rowid <= ? AND time_created >= ? AND type = 'assistant'
	AND json_extract(data, '$.error') IS NULL
	AND json_extract(data, '$.finish') IS NOT NULL
GROUP BY provider`,
			)
			.all(from, max, since) as { provider: string | null; t: number }[];
		const limits: LimitState[] = [];
		for (const r of rows) {
			const l = opencodeLimit({
				t: Number(r.t),
				provider: str(r.provider),
				errorType: str(r.errorType),
				retryAfterMs: fin(r.retryAfterMs),
				message: str(r.message),
			});
			if (l) limits.push(l);
		}
		const answered = new Map<string, number>();
		for (const a of answers) {
			const t = fin(a.t);
			if (t !== null && str(a.provider))
				answered.set(answeredKey("opencode", a.provider!.slice(0, 80)), t);
		}
		return { cursor: max, limits, answered };
	} catch {
		return none;
	} finally {
		db?.close();
	}
}
