import { open } from "node:fs/promises";
import type { Agent } from "../types.ts";
import { statAsync } from "../util.ts";
import type { LiveStatus } from "./types.ts";

/**
 * Codex busy/idle, from its rollout. Codex reports no status to Pulsar, and
 * its pid is the shared `codex app-server` (one process, many threads), so
 * the rollout's turn events are the signal (Codex 0.170, read from real
 * rollouts): `event_msg` lines with payload type `task_started` (a turn
 * began) and `task_complete` or `turn_aborted` (it ended). The last one
 * written says whether a turn runs now, and its timestamp since when.
 *
 * Cheap: an unchanged rollout is not read at all; a grown one is searched
 * from its end back to the bytes seen last time, stopping at the first
 * turn event, with a raw byte search (no line splitting or JSON parsing).
 */

const EVENTS = [
	["task_started", true],
	["task_complete", false],
	["turn_aborted", false],
] as const;
const PATTERNS = EVENTS.map(
	([type, busy]) =>
		[
			Buffer.from(`"type":"event_msg","payload":{"type":"${type}"`),
			busy,
		] as const,
);
const OVERLAP = Math.max(...PATTERNS.map(([p]) => p.length));

/** Bytes read per step of the backward search. */
const CHUNK = 1024 * 1024;
/** A rollout searched this far back without a turn event has no known status. */
const MAX_SCAN = 64 * 1024 * 1024;
/** A running turn whose rollout was quiet this long is checked with the app-server. */
export const QUIET_MS = 2 * 60_000;
/** How often that check runs for one thread, at most. */
export const CONFIRM_MS = 60_000;
/** Quiet this long with no app-server answer: the turn died (Codex crashed mid-turn). */
export const STALE_MS = 10 * 60_000;

interface TurnEvent {
	busy: boolean;
	at: number;
}

interface Track {
	size: number;
	mtimeMs: number;
	event: TurnEvent | null;
	confirmed?: { at: number; busy: boolean | null };
}

const tracks = new Map<string, Track>();

/** Bytes read from rollouts for status (tests check unchanged bytes are not re-read). */
export const codexStatusStats = { bytes: 0 };

/** The last turn event in bytes [from, to) of a rollout, or null. */
async function lastTurnEvent(
	file: string,
	from: number,
	to: number,
	mtimeMs: number,
): Promise<TurnEvent | null> {
	const fh = await open(file, "r");
	try {
		let end = to;
		// One buffer for the whole search: a 50 MB search must not churn the GC.
		const whole = Buffer.allocUnsafe(Math.min(to - from, CHUNK) + OVERLAP);
		while (end > from && to - end < MAX_SCAN) {
			const start = Math.max(from, end - CHUNK);
			// Overlaps the chunk after it, so a match split by the boundary is found.
			const len = Math.min(to, end + OVERLAP) - start;
			const { bytesRead } = await fh.read(whole, 0, len, start);
			const buf = whole.subarray(0, bytesRead);
			codexStatusStats.bytes += bytesRead;
			let best = -1;
			let busy = false;
			for (const [p, b] of PATTERNS) {
				if (bytesRead < p.length) continue;
				const i = buf.lastIndexOf(p, bytesRead - p.length);
				if (i > best) {
					best = i;
					busy = b;
				}
			}
			if (best >= 0)
				return { busy, at: await lineTime(fh, start + best, mtimeMs) };
			end = start;
		}
		return null;
	} finally {
		await fh.close();
	}
}

/** The `timestamp` of the line holding byte `pos` (it leads the line); else `fallback`. */
async function lineTime(
	fh: Awaited<ReturnType<typeof open>>,
	pos: number,
	fallback: number,
): Promise<number> {
	const from = Math.max(0, pos - 512);
	const buf = Buffer.alloc(pos - from);
	const { bytesRead } = await fh.read(buf, 0, buf.length, from);
	codexStatusStats.bytes += bytesRead;
	const text = buf.subarray(0, bytesRead).toString("utf8");
	const line = text.slice(text.lastIndexOf("\n") + 1);
	const m = /"timestamp":"([^"]+)"/.exec(line);
	const at = m ? Date.parse(m[1]!) : Number.NaN;
	return Number.isFinite(at) ? at : fallback;
}

export interface CodexStatus {
	status: "busy" | "idle";
	since: number;
}

/**
 * One rollout's status now; null when it has no turn event (or is gone).
 * `confirm` asks the app-server whether the thread's turn still runs (true,
 * false, or null when it could not tell); it is called only for a running
 * turn whose rollout went quiet, at most once per `CONFIRM_MS`.
 */
export async function codexRolloutStatus(
	file: string,
	confirm: (() => Promise<boolean | null>) | null,
	now = Date.now(),
): Promise<CodexStatus | null> {
	const st = await statAsync(file);
	if (!st) {
		tracks.delete(file);
		return null;
	}
	let t = tracks.get(file);
	// New, or rewritten shorter: search it from the end again.
	if (!t || st.size < t.size) {
		t = { size: 0, mtimeMs: 0, event: null };
		tracks.set(file, t);
	}
	if (st.size !== t.size || st.mtimeMs !== t.mtimeMs) {
		const found = await lastTurnEvent(file, t.size, st.size, st.mtimeMs);
		if (found) {
			t.event = found;
			t.confirmed = undefined;
		}
		t.size = st.size;
		t.mtimeMs = st.mtimeMs;
	}
	const e = t.event;
	if (!e) return null;
	if (!e.busy) return { status: "idle", since: e.at };
	const quiet = now - st.mtimeMs;
	if (quiet < QUIET_MS) return { status: "busy", since: e.at };
	// A long tool call writes nothing for a while; a crash never ends the turn.
	if (confirm && (!t.confirmed || now - t.confirmed.at >= CONFIRM_MS))
		t.confirmed = { at: now, busy: await confirm().catch(() => null) };
	if (t.confirmed?.busy === true) return { status: "busy", since: e.at };
	if (t.confirmed?.busy === false)
		return { status: "idle", since: Math.max(e.at, st.mtimeMs) };
	if (quiet < STALE_MS) return { status: "busy", since: e.at };
	return { status: "idle", since: Math.max(e.at, st.mtimeMs) };
}

/** Status of every live Codex thread; rollouts of threads no longer listed are forgotten. */
export async function codexStatuses(
	agents: Agent[],
	rollout: (threadId: string) => Promise<string | null>,
	confirm: ((threadId: string) => Promise<boolean | null>) | null,
): Promise<LiveStatus[]> {
	const out: LiveStatus[] = [];
	const seen = new Set<string>();
	for (const agent of agents) {
		const thread = agent.sessionId;
		if (!thread || agent.status === "gone") continue;
		const file = await rollout(thread);
		if (!file) continue;
		seen.add(file);
		const s = await codexRolloutStatus(
			file,
			confirm ? () => confirm(thread) : null,
		);
		if (s) out.push({ agent, ...s });
	}
	for (const file of tracks.keys()) if (!seen.has(file)) tracks.delete(file);
	return out;
}
