import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { processSnapshot } from "../processes.ts";
import type { Agent } from "../types.ts";
import { headAsync, tailAsync } from "../util.ts";
import { codexControlReady, codexRpc } from "./codex-rpc.ts";
import { opencodeGet, opencodeServiceRunning } from "./opencode-api.ts";
import { piSessionFile } from "./pi-sessions.ts";
import { parsePi } from "./pi-transcript.ts";
import type { FoundSubagent, SubagentTranscript } from "./types.ts";

/**
 * Subagents of omp, Codex and OpenCode. Claude Code's
 * are in claude-subagents.ts.
 */

function text(v: unknown, max: number): string | null {
	if (typeof v !== "string") return null;
	const t = v.replace(/\s+/g, " ").trim();
	return t ? t.slice(0, max) : null;
}

/** Seconds or milliseconds since the epoch, as milliseconds; 0 when unknown. */
function ms(v: unknown): number {
	const n = Number(v);
	if (!Number.isFinite(n) || n <= 0) return 0;
	return n < 1e12 ? n * 1000 : n;
}

/**
 * Codex and OpenCode keep a finished child thread or session around (loaded,
 * "idle") long after its work. Idle counts as alive (waiting, reachable)
 * only this long after its last update; then it is done.
 */
export const IDLE_MAX_MS = 30 * 60_000;
/** An omp task with no exit record and no write for this long has died. */
export const OMP_QUIET_MS = 10 * 60_000;

/** Ids that may sit in a subagent id and a file name. */
const KEY = /^[A-Za-z0-9._-]{1,100}$/;

// --- omp ---------------------------------------------------------------

/**
 * omp (18.22): a `task` subagent writes `<session>/<Name>.jsonl` in the
 * folder named for the parent's session file (line 2: `{"type":"session",
 * "parentSession":…}`), ends it with a `session_exit` record and leaves its
 * result in `<Name>.md`.
 */
interface OmpCached {
	size: number;
	mtimeMs: number;
	startedAt: number;
	exited: boolean;
}
const ompCache = new Map<string, OmpCached>();

/** Bytes read from omp subagent files (tests check unchanged files are not re-read). */
export const ompSubagentReads = { bytes: 0 };

/** Each agent's session file, so the sweep does not walk its folder every time. */
const ompFiles = new Map<string, string>();

async function ompFolder(agent: Agent): Promise<string | null> {
	let file = ompFiles.get(agent.id) ?? null;
	if (file && !(await stat(file).catch(() => null))) file = null;
	// HOME first: tests (and services) may point it elsewhere after start.
	file ??= await piSessionFile(
		".omp",
		agent.cwd,
		agent.sessionId,
		process.env.HOME || homedir(),
	);
	if (!file) return null;
	if (ompFiles.size > 1000) ompFiles.clear();
	ompFiles.set(agent.id, file);
	return file.slice(0, -".jsonl".length);
}

export async function ompSubagentStamp(agent: Agent): Promise<string | null> {
	const dir = await ompFolder(agent);
	if (!dir) return null;
	try {
		return String((await stat(dir)).mtimeMs);
	} catch {
		return null;
	}
}

export async function listOmpSubagents(
	agent: Agent,
	now = Date.now(),
): Promise<FoundSubagent[]> {
	const dir = await ompFolder(agent);
	if (!dir) return [];
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		return [];
	}
	const results = new Set(names.filter((n) => n.endsWith(".md")));
	const out: FoundSubagent[] = [];
	for (const f of names) {
		if (!f.endsWith(".jsonl")) continue;
		const key = f.slice(0, -".jsonl".length);
		if (!KEY.test(key)) continue;
		const file = join(dir, f);
		const st = await stat(file).catch(() => null);
		if (!st) continue;
		let hit = ompCache.get(file);
		if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
			let startedAt = hit?.startedAt;
			if (startedAt === undefined) {
				const head = await headAsync(file, 8192);
				ompSubagentReads.bytes += head.length;
				const m =
					/"type"\s*:\s*"session"[^\n]*?"timestamp"\s*:\s*"([^"]+)"/.exec(head);
				const t = m ? Date.parse(m[1]!) : Number.NaN;
				startedAt = Number.isFinite(t) ? t : st.birthtimeMs || st.mtimeMs;
			}
			const tail = await tailAsync(file, 4096);
			ompSubagentReads.bytes += tail.length;
			hit = {
				size: st.size,
				mtimeMs: st.mtimeMs,
				startedAt,
				exited: /"customType"\s*:\s*"session_exit"/.test(tail),
			};
			if (ompCache.size > 4000) ompCache.clear();
			ompCache.set(file, hit);
		}
		const done =
			hit.exited ||
			results.has(`${key}.md`) ||
			agent.status === "gone" ||
			now - st.mtimeMs >= OMP_QUIET_MS;
		out.push({
			key,
			name: key,
			kind: "task",
			agentType: null,
			description: null,
			state: done ? "done" : "running",
			startedAt: hit.startedAt,
			updatedAt: st.mtimeMs,
			finishedAt: done ? st.mtimeMs : null,
			callId: null,
			parentKey: null,
			sessionId: null,
			file,
		});
	}
	return out;
}

export async function ompSubagentTranscript(
	_agent: Agent,
	sub: FoundSubagent,
): Promise<SubagentTranscript | null> {
	if (!sub.file) return null;
	// omp pads line 1 (the title) and rewrites it in place: never read it.
	return {
		source: { kind: "file", path: sub.file, headerLine: true },
		parse: parsePi,
	};
}

// --- Codex -------------------------------------------------------------

/**
 * Codex (0.169): a spawned agent is its own thread with
 * `source.subAgent.thread_spawn.parent_thread_id`. Most threads keep their
 * history in Codex's database, not a rollout, so the children come from
 * the app-server's `thread/list` (filtered to spawned threads in the
 * parent's folder). Without a running app-server none are listed.
 */
interface CodexThread {
	id?: string;
	parentThreadId?: string | null;
	agentNickname?: string | null;
	agentRole?: string | null;
	name?: string | null;
	preview?: string | null;
	createdAt?: number;
	updatedAt?: number;
	status?: { type?: string } | null;
	path?: string | null;
}

export async function listCodexSubagents(
	agent: Agent,
	now = Date.now(),
): Promise<FoundSubagent[]> {
	if (!agent.sessionId || !agent.cwd || !(await codexControlReady())) return [];
	let threads: CodexThread[] = [];
	try {
		const [r] = (await codexRpc(
			[
				[
					"thread/list",
					{
						sourceKinds: ["subAgentThreadSpawn"],
						cwd: agent.cwd,
						limit: 100,
					},
				],
			],
			{ timeoutMs: 4000 },
		)) as [{ data?: CodexThread[] }];
		threads = Array.isArray(r?.data) ? r.data : [];
	} catch {
		return [];
	}
	const ids = new Set(threads.map((t) => t.id));
	const out: FoundSubagent[] = [];
	// Grandchildren name a child as their parent: keep the whole subtree.
	const mine = new Set([agent.sessionId]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const t of threads)
			if (
				t.id &&
				!mine.has(t.id) &&
				t.parentThreadId &&
				mine.has(t.parentThreadId)
			) {
				mine.add(t.id);
				grew = true;
			}
	}
	for (const t of threads) {
		if (!t.id || t.id === agent.sessionId || !mine.has(t.id) || !KEY.test(t.id))
			continue;
		const status = t.status?.type;
		const updatedAt = ms(t.updatedAt) || ms(t.createdAt);
		const state =
			agent.status === "gone"
				? "done"
				: status === "active"
					? "running"
					: status === "idle" && now - updatedAt < IDLE_MAX_MS
						? "idle"
						: "done";
		const parent = t.parentThreadId ?? null;
		out.push({
			key: t.id,
			name:
				text(t.agentNickname, 80) ??
				text(t.name, 80) ??
				text(t.preview, 80) ??
				"Subagent",
			kind: "thread",
			agentType: text(t.agentRole, 80),
			description: text(t.preview, 300),
			state,
			startedAt: ms(t.createdAt),
			updatedAt,
			finishedAt: state === "done" ? updatedAt : null,
			callId: null,
			parentKey:
				parent && parent !== agent.sessionId && ids.has(parent) ? parent : null,
			sessionId: t.id,
			file: typeof t.path === "string" && t.path ? t.path : null,
		});
	}
	return out;
}

// --- OpenCode ----------------------------------------------------------

/**
 * OpenCode (2.2.5): a subagent is a child session (`parentID`), listed by
 * `GET /api/session?parentID=…` on the shared service. Running ones are in
 * `session.active`; the others are idle while recently updated (IDLE_MAX_MS),
 * then done. Only direct children are listed.
 */
interface OpencodeSession {
	id?: string;
	parentID?: string | null;
	title?: string | null;
	agent?: string | null;
	time?: { created?: number; updated?: number };
}

export async function listOpencodeSubagents(
	agent: Agent,
	now = Date.now(),
): Promise<FoundSubagent[]> {
	if (!agent.sessionId || !KEY.test(agent.sessionId)) return [];
	// `opencode api` starts a service when none runs: only ask one that does.
	const table = await processSnapshot();
	if (!opencodeServiceRunning(table)) return [];
	const [list, active] = await Promise.all([
		opencodeGet<OpencodeSession[]>(
			table,
			`/api/session?parentID=${encodeURIComponent(agent.sessionId)}`,
		),
		opencodeGet<Record<string, { type?: string }>>(
			table,
			"/api/session/active",
		),
	]);
	const sessions = list ?? [];
	const running = active ?? {};
	const out: FoundSubagent[] = [];
	for (const s of Array.isArray(sessions) ? sessions : []) {
		if (!s?.id || !KEY.test(s.id) || s.parentID !== agent.sessionId) continue;
		const updatedAt = ms(s.time?.updated) || ms(s.time?.created);
		const state =
			agent.status === "gone"
				? "done"
				: running[s.id]?.type === "running"
					? "running"
					: now - updatedAt < IDLE_MAX_MS
						? "idle"
						: "done";
		out.push({
			key: s.id,
			name: text(s.title, 80) ?? "Subagent",
			kind: "session",
			agentType: text(s.agent, 80),
			description: null,
			state,
			startedAt: ms(s.time?.created),
			updatedAt,
			finishedAt: state === "done" ? updatedAt : null,
			callId: null,
			parentKey: null,
			sessionId: s.id,
			file: null,
		});
	}
	return out;
}
