import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
	NOTICE_COLORS,
	type NoticeColor,
	type TranscriptEvent,
} from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import { headAsync, tailAsync } from "../util.ts";
import { configDir } from "./claude-ident.ts";
import { parseClaude } from "./claude-transcript.ts";
import type { FoundSubagent, SubagentTranscript } from "./types.ts";

/**
 * Claude Code subagents (Claude Code 2.1.327, read from real sessions):
 * each one writes `<project>/<session>/subagents/agent-<id>.jsonl` (every
 * record `isSidechain: true`, `agentId: <id>`) next to `agent-<id>.meta.json`:
 * `agentType`, `description`, `toolUseId` (the parent's Task/Agent call),
 * `finished: true` once it returned, `parentAgentId` when another subagent
 * started it, and for agent-team members `taskKind: "in_process_teammate"`
 * with `name`, `teamName` and `color` (the teammate color its messages
 * carry, one of `NOTICE_COLORS`). Workflow runs (`subagents/workflows/`) are
 * not listed.
 *
 * A teammate never gets `finished`: when the lead shuts it down (or the
 * team is deleted) Claude drops it from the team's
 * `teams/<teamName>/config.json` (`leadSessionId`, `members[]` with
 * `name` and `joinedAt`). A teammate is alive only while it is a member of
 * a team led by this session; a name can be spawned again, so only the
 * log that started at or after the member's `joinedAt` (the newest one) is
 * that member. Every other teammate log is done.
 *
 * On resume Claude appends records with no timestamp (`data-flow-records`)
 * to every subagent log, so a log's mtime is not when it last worked: the
 * last record's own timestamp is.
 */

/** Session folder of a Claude session: `<projects>/<slug>/<session>/`. */
export function claudeSessionDir(
	cwd: string | null,
	sessionId: string | null,
): string | null {
	if (!cwd || !sessionId || !/^[A-Za-z0-9-]{1,128}$/.test(sessionId))
		return null;
	return join(
		configDir(),
		"projects",
		cwd.replace(/[^a-zA-Z0-9]/g, "-"),
		sessionId,
	);
}

function subagentsDir(agent: Pick<Agent, "cwd" | "sessionId">) {
	const dir = claudeSessionDir(agent.cwd, agent.sessionId);
	return dir ? join(dir, "subagents") : null;
}

/** Agent ids Claude writes: `a` + hex. Anything else never reaches a path. */
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** A task with no write for this long and no `finished` mark is taken as done. */
export const TASK_QUIET_MS = 10 * 60_000;
/** A live teammate with no write for this long is idle (waiting for work). */
export const TEAMMATE_QUIET_MS = 60_000;
/** A teammate log that started this long before its member joined is an older one. */
const JOIN_SLACK_MS = 60_000;
/** How much of a log's end is read for its last timestamp (resume records can be ~50 KB). */
const TAIL_STEPS = [16 * 1024, 128 * 1024];

interface Meta {
	agentType: string | null;
	description: string | null;
	name: string | null;
	toolUseId: string | null;
	parentAgentId: string | null;
	finished: boolean;
	teammate: boolean;
	teamName: string | null;
	color: NoticeColor | null;
}

interface Cached {
	metaMtime: number;
	meta: Meta;
	startedAt: number;
	/** The log's size and mtime when `lastAt` was read. */
	logSize: number;
	logMtime: number;
	/** The last record's timestamp (ms): when it last worked. */
	lastAt: number;
	endedTurn: boolean;
}

/** Each subagent's meta and start time, kept while its meta file is unchanged. */
const cache = new Map<string, Cached>();
const CACHE_MAX = 4000;

/** Bytes read from meta and log files (tests check unchanged files are not re-read). */
export const claudeSubagentReads = { bytes: 0 };

function text(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	const t = v.replace(/\s+/g, " ").trim();
	return t ? t.slice(0, max) : null;
}

function readMeta(raw: string): Meta {
	let m: Record<string, unknown> = {};
	try {
		const v = JSON.parse(raw) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v))
			m = v as Record<string, unknown>;
	} catch {}
	const parent = text(m.parentAgentId, 64);
	return {
		agentType: text(m.agentType, 80),
		description: text(m.description, 300),
		name: text(m.name, 80),
		toolUseId: text(m.toolUseId, 100),
		parentAgentId: parent && KEY.test(parent) ? parent : null,
		finished: m.finished === true,
		teammate: m.taskKind === "in_process_teammate",
		teamName: (() => {
			const t = text(m.teamName, 128);
			return t && KEY_TEAM.test(t) ? t : null;
		})(),
		color: NOTICE_COLORS.find((c) => c === m.color) ?? null,
	};
}

/** Team names that may reach a path. */
const KEY_TEAM = /^[A-Za-z0-9._-]{1,128}$/;

/** The last top-level `timestamp` among the complete lines of a log's tail. */
export function lastTimestamp(tail: string, whole: boolean): number | null {
	const lines = tail.split("\n");
	// The first line is cut unless the tail is the whole file.
	const from = whole ? 0 : 1;
	for (let i = lines.length - 1; i >= from; i--) {
		const line = lines[i]!;
		if (!line.includes('"timestamp"')) continue;
		try {
			const v = JSON.parse(line) as { timestamp?: unknown };
			const t =
				typeof v?.timestamp === "string" ? Date.parse(v.timestamp) : Number.NaN;
			if (Number.isFinite(t)) return t;
		} catch {}
	}
	return null;
}

/** Only an assistant end_turn at the tip of this child's own transcript proves idle.
 * A later user/tool record, an incomplete line, or a different branch invalidates it. */
function endedTurn(tail: string, whole: boolean, key: string): boolean {
	if (!tail.endsWith("\n")) return false;
	const end = tail.trimEnd();
	const start = end.lastIndexOf("\n");
	if (!whole && start < 0) return false;
	try {
		const row = JSON.parse(end.slice(start + 1));
		return (
			row.type === "assistant" &&
			row.agentId === key &&
			row.message?.role === "assistant" &&
			row.message.stop_reason === "end_turn"
		);
	} catch {
		return false;
	}
}

async function readLastActivity(file: string, size: number, key: string) {
	for (const n of TAIL_STEPS) {
		const tail = await tailAsync(file, n);
		claudeSubagentReads.bytes += tail.length;
		const whole = size <= n;
		const time = lastTimestamp(tail, whole);
		if (time !== null || whole || n === TAIL_STEPS.at(-1))
			return { time, endedTurn: endedTurn(tail, whole, key) };
	}
	return { time: null, endedTurn: false };
}

interface Team {
	mtime: number;
	lead: string | null;
	/** Member name → joinedAt (0 when unknown). */
	members: Map<string, number>;
}

/** Team configs, kept while their mtime is unchanged. */
const teams = new Map<string, Team>();

/** A team's config, or null when it is gone (or unreadable). */
async function readTeam(name: string): Promise<Team | null> {
	const file = join(configDir(), "teams", name, "config.json");
	const st = await stat(file).catch(() => null);
	if (!st) {
		teams.delete(file);
		return null;
	}
	const hit = teams.get(file);
	if (hit && hit.mtime === st.mtimeMs) return hit;
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch {
		return null;
	}
	claudeSubagentReads.bytes += raw.length;
	let c: Record<string, unknown> = {};
	try {
		const v = JSON.parse(raw) as unknown;
		if (v && typeof v === "object" && !Array.isArray(v))
			c = v as Record<string, unknown>;
	} catch {
		// Mid-write: keep the last good copy if there is one.
		return hit ?? null;
	}
	const members = new Map<string, number>();
	for (const m of Array.isArray(c.members) ? c.members : []) {
		if (!m || typeof m !== "object") continue;
		const r = m as Record<string, unknown>;
		const n = text(r.name, 80);
		if (n) members.set(n, Number.isFinite(r.joinedAt) ? Number(r.joinedAt) : 0);
	}
	const team = {
		mtime: st.mtimeMs,
		lead: text(c.leadSessionId, 128),
		members,
	};
	if (teams.size > 500) teams.clear();
	teams.set(file, team);
	return team;
}

/** The first record's timestamp (ms), or null. */
function firstTimestamp(head: string): number | null {
	const nl = head.indexOf("\n");
	const line = nl < 0 ? head : head.slice(0, nl);
	const m = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
	const t = m ? Date.parse(m[1]!) : Number.NaN;
	return Number.isFinite(t) ? t : null;
}

/** The subagents folder's mtime: changes when a subagent starts. */
export async function claudeSubagentStamp(
	agent: Agent,
): Promise<string | null> {
	const dir = subagentsDir(agent);
	if (!dir) return null;
	try {
		return String((await stat(dir)).mtimeMs);
	} catch {
		return null;
	}
}

export async function listClaudeSubagents(
	agent: Agent,
	now = Date.now(),
): Promise<FoundSubagent[]> {
	const dir = subagentsDir(agent);
	if (!dir) return [];
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const parentGone = agent.status === "gone";
	const rows: Array<{ key: string; file: string; hit: Cached }> = [];
	for (const f of names) {
		const m = /^agent-(.+)\.jsonl$/.exec(f);
		const key = m?.[1];
		if (!key || !KEY.test(key)) continue;
		const file = join(dir, f);
		const metaFile = join(dir, `agent-${key}.meta.json`);
		const [log, metaStat] = await Promise.all([
			stat(file).catch(() => null),
			stat(metaFile).catch(() => null),
		]);
		if (!log) continue;
		let hit = cache.get(file);
		if (!hit || hit.metaMtime !== (metaStat?.mtimeMs ?? 0)) {
			let raw = "{}";
			if (metaStat)
				try {
					raw = await readFile(metaFile, "utf8");
					claudeSubagentReads.bytes += raw.length;
				} catch {}
			let startedAt = hit?.startedAt;
			if (startedAt === undefined) {
				const head = await headAsync(file, 4096);
				claudeSubagentReads.bytes += head.length;
				startedAt =
					firstTimestamp(head) ??
					(log.birthtimeMs > 0 ? log.birthtimeMs : log.mtimeMs);
			}
			hit = {
				metaMtime: metaStat?.mtimeMs ?? 0,
				meta: readMeta(raw),
				startedAt,
				logSize: hit?.logSize ?? -1,
				logMtime: hit?.logMtime ?? -1,
				lastAt: hit?.lastAt ?? log.mtimeMs,
				endedTurn: hit?.endedTurn ?? false,
			};
			if (cache.size >= CACHE_MAX) cache.clear();
			cache.set(file, hit);
		}
		if (hit.logSize !== log.size || hit.logMtime !== log.mtimeMs) {
			// No timestamp in reach (one huge last record): the write time.
			const activity = await readLastActivity(file, log.size, key);
			hit.lastAt = activity.time ?? log.mtimeMs;
			hit.endedTurn = activity.endedTurn;
			hit.logSize = log.size;
			hit.logMtime = log.mtimeMs;
		}
		rows.push({ key, file, hit });
	}

	// Live teammates: the newest log of each member of a team this session leads.
	const live = new Set<string>();
	if (!parentGone) {
		const newest = new Map<string, { file: string; startedAt: number }>();
		for (const { file, hit } of rows) {
			const { meta } = hit;
			if (!meta.teammate || meta.finished || !meta.teamName || !meta.name)
				continue;
			const id = `${meta.teamName}\n${meta.name}`;
			const cur = newest.get(id);
			if (!cur || hit.startedAt > cur.startedAt)
				newest.set(id, { file, startedAt: hit.startedAt });
		}
		const byTeam = new Map<string, Team | null>();
		for (const [id, { file, startedAt }] of newest) {
			const [teamName, name] = id.split("\n") as [string, string];
			if (!byTeam.has(teamName)) byTeam.set(teamName, await readTeam(teamName));
			const team = byTeam.get(teamName);
			if (!team || (team.lead && team.lead !== agent.sessionId)) continue;
			const joinedAt = team.members.get(name);
			if (joinedAt === undefined) continue;
			if (joinedAt > 0 && startedAt < joinedAt - JOIN_SLACK_MS) continue;
			live.add(file);
		}
	}

	const out: FoundSubagent[] = [];
	for (const { key, file, hit } of rows) {
		const { meta } = hit;
		const quiet = now - hit.lastAt;
		const state =
			meta.finished || parentGone
				? "done"
				: meta.teammate
					? !live.has(file)
						? "done"
						: quiet < TEAMMATE_QUIET_MS
							? "running"
							: "idle"
					: quiet < TASK_QUIET_MS
						? "running"
						: "done";
		out.push({
			key,
			name:
				meta.name ??
				meta.description ??
				meta.agentType ??
				(meta.teammate ? "Teammate" : "Subagent"),
			kind: meta.teammate ? "teammate" : "task",
			color: meta.color,
			agentType: meta.agentType,
			description: meta.name ? meta.description : null,
			state,
			waitStatus:
				meta.finished || parentGone
					? "gone"
					: hit.endedTurn && (!meta.teammate || live.has(file))
						? "idle"
						: state === "running"
							? "busy"
							: "unknown",
			startedAt: hit.startedAt,
			updatedAt: hit.lastAt,
			finishedAt: state === "done" ? hit.lastAt : null,
			callId: meta.toolUseId,
			parentKey: meta.parentAgentId,
			sessionId: null,
			file,
		});
	}
	return out;
}

/**
 * A subagent's own log, read with the session parser. Every record there is
 * the subagent's own, so the sidechain mark (which folds events under the
 * parent's Task call) is dropped.
 */
export async function claudeSubagentTranscript(
	_agent: Agent,
	sub: FoundSubagent,
): Promise<SubagentTranscript | null> {
	if (!sub.file) return null;
	return {
		source: { kind: "file", path: sub.file },
		parse: (chunk, state) =>
			parseClaude(chunk, state).map((e): TranscriptEvent => {
				if (!e.sidechain) return e;
				const { sidechain: _, ...rest } = e;
				return rest;
			}),
	};
}
