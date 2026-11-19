import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEvent } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import { headAsync } from "../util.ts";
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
 * with `name`. Workflow runs (`subagents/workflows/`) are not listed.
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
/** A teammate with no write for this long is idle (waiting for work). */
export const TEAMMATE_QUIET_MS = 60_000;

interface Meta {
	agentType: string | null;
	description: string | null;
	name: string | null;
	toolUseId: string | null;
	parentAgentId: string | null;
	finished: boolean;
	teammate: boolean;
}

interface Cached {
	metaMtime: number;
	meta: Meta;
	startedAt: number;
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
	};
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
	const out: FoundSubagent[] = [];
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
			};
			if (cache.size >= CACHE_MAX) cache.clear();
			cache.set(file, hit);
		}
		const { meta } = hit;
		const quiet = now - log.mtimeMs;
		const state = meta.finished
			? "done"
			: parentGone
				? "done"
				: meta.teammate
					? quiet < TEAMMATE_QUIET_MS
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
			agentType: meta.agentType,
			description: meta.name ? meta.description : null,
			state,
			startedAt: hit.startedAt,
			updatedAt: log.mtimeMs,
			finishedAt: state === "done" ? log.mtimeMs : null,
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
