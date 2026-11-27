import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { processSnapshot } from "../processes.ts";
import { jsonLines } from "../transcripts/summary.ts";
import type { Agent } from "../types.ts";
import { headAsync, tailAsync } from "../util.ts";
import { codexControlReady, codexRpc } from "./codex-rpc.ts";
import { opencodeGet, opencodeServiceRunning } from "./opencode-api.ts";
import { hostSessionId, locatePiStyle } from "./pi-sessions.ts";
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
	sessionId: string | null;
	exited: boolean;
}
const ompCache = new Map<string, OmpCached>();

/** Bytes read from omp subagent files (tests check unchanged files are not re-read). */
export const ompSubagentReads = { bytes: 0 };

/**
 * Each agent's session file, so the sweep does not look it up every time;
 * looked up again after `OMP_FILE_MS` (the session may have moved: new,
 * resumed, forked).
 */
const ompFiles = new WeakMap<
	Agent,
	{ file: string; at: number; id: string | null; pid: number | null }
>();
const OMP_FILE_MS = 5000;

/**
 * The folder of this exact session. Another parent can share the same cwd.
 */
async function ompFolder(agent: Agent): Promise<string | null> {
	const id = hostSessionId(agent);
	const hit = ompFiles.get(agent);
	let file =
		hit &&
		hit.id === id &&
		hit.pid === agent.pid &&
		Date.now() - hit.at < OMP_FILE_MS &&
		(await isFile(hit.file))
			? hit.file
			: null;
	if (!file) {
		// HOME at call time: tests (and services) may point it elsewhere after start.
		const source = await locatePiStyle(
			"omp",
			agent,
			undefined,
			undefined,
			true,
		);
		file = source?.kind === "file" ? source.path : null;
		if (!file) {
			ompFiles.delete(agent);
			return null;
		}
		ompFiles.set(agent, { file, at: Date.now(), id, pid: agent.pid });
	}
	return file.slice(0, -".jsonl".length);
}

async function isFile(path: string): Promise<boolean> {
	return (await stat(path).catch(() => null))?.isFile() ?? false;
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
	const parentId = basename(dir).split("_").at(-1);
	const parentPath = `${dir}.jsonl`;
	let realParent: Promise<string | null> | undefined;
	const out: FoundSubagent[] = [];
	for (const f of names) {
		if (!f.endsWith(".jsonl")) continue;
		const key = f.slice(0, -".jsonl".length);
		if (!KEY.test(key)) continue;
		const file = join(dir, f);
		const st = await lstat(file).catch(() => null);
		if (!st?.isFile()) continue;
		let hit = ompCache.get(file);
		if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) {
			let startedAt = hit?.startedAt;
			let sessionId = hit?.sessionId ?? null;
			if (!sessionId) {
				const head = await headAsync(file, 8192);
				ompSubagentReads.bytes += head.length;
				const header = jsonLines(head).find((row) => row.type === "session");
				const owner = header?.parentSession;
				let belongs = owner === parentId || owner === parentPath;
				if (
					!belongs &&
					typeof owner === "string" &&
					owner.length <= 4096 &&
					isAbsolute(owner)
				) {
					realParent ??= realpath(parentPath).catch(() => null);
					const canonical = await realParent;
					belongs =
						canonical !== null &&
						canonical === (await realpath(owner).catch(() => null));
				}
				if (
					header &&
					typeof header.id === "string" &&
					KEY.test(header.id) &&
					belongs
				)
					sessionId = header.id;
				const t =
					typeof header?.timestamp === "string"
						? Date.parse(header.timestamp)
						: Number.NaN;
				startedAt = Number.isFinite(t) ? t : st.birthtimeMs || st.mtimeMs;
			}
			const tail = sessionId ? await tailAsync(file, 4096) : "";
			ompSubagentReads.bytes += tail.length;
			hit = {
				size: st.size,
				mtimeMs: st.mtimeMs,
				startedAt: startedAt ?? st.birthtimeMs,
				sessionId,
				exited: /"customType"\s*:\s*"session_exit"/.test(tail),
			};
			if (ompCache.size > 4000) ompCache.clear();
			ompCache.set(file, hit);
		}
		if (!hit.sessionId) continue;
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
			sessionId: hit.sessionId,
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
 * the app-server's `thread/list`, scoped to the root thread across workspaces. Without a running app-server none are listed.
 */
interface CodexThread {
	id?: string;
	cwd?: string;
	parentThreadId?: string | null;
	agentNickname?: string | null;
	agentRole?: string | null;
	name?: string | null;
	preview?: string | null;
	createdAt?: number;
	updatedAt?: number;
	status?: { type?: string } | null;
	canAcceptDirectInput?: boolean | null;
	path?: string | null;
}

export async function listCodexSubagents(
	agent: Agent,
	now = Date.now(),
): Promise<FoundSubagent[]> {
	if (!agent.sessionId || !(await codexControlReady())) return [];
	const threads: CodexThread[] = [];
	const seen = new Set<string>();
	let cursor: string | null = null;
	try {
		do {
			const [page] = (await codexRpc(
				[
					[
						"thread/list",
						{
							sourceKinds: ["subAgentThreadSpawn"],
							ancestorThreadId: agent.sessionId,
							limit: 100,
							...(cursor && { cursor }),
						},
					],
				],
				{ timeoutMs: 4000, experimental: true },
			)) as [{ data?: CodexThread[]; nextCursor?: string | null }];
			if (!Array.isArray(page?.data)) break;
			threads.push(...page.data);
			cursor = page.nextCursor ?? null;
			if (!cursor || seen.has(cursor)) break;
			seen.add(cursor);
		} while (cursor);
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
			...(typeof t.cwd === "string" && isAbsolute(t.cwd) && { cwd: t.cwd }),
			...(state !== "done" &&
				t.canAcceptDirectInput === true && { direct: true }),
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
 * then done. Follow verified parent IDs to place nested sessions under their root.
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
	const childrenOf = (id: string) =>
		opencodeGet<OpencodeSession[]>(
			table,
			`/api/session?parentID=${encodeURIComponent(id)}`,
		);
	const [first, active] = await Promise.all([
		childrenOf(agent.sessionId),
		opencodeGet<Record<string, { type?: string }>>(
			table,
			"/api/session/active",
		),
	]);
	const running = active ?? {};
	const sessions: (OpencodeSession & { id: string; parentID: string })[] = [];
	const seen = new Set([agent.sessionId]);
	function append(parent: string, rows: OpencodeSession[] | null) {
		if (!Array.isArray(rows)) return;
		for (const row of rows) {
			if (
				!row?.id ||
				row.parentID !== parent ||
				!KEY.test(row.id) ||
				seen.has(row.id)
			)
				continue;
			seen.add(row.id);
			sessions.push({ ...row, id: row.id, parentID: parent });
		}
	}
	append(agent.sessionId, first);
	// List recent descendants in one request instead of probing every leaf.
	// Include each direct child even when it predates the bounded recent page.
	if (sessions.length) {
		const recent = await opencodeGet<OpencodeSession[]>(
			table,
			"/api/session?limit=500&order=desc",
		);
		const byParent = new Map<string, OpencodeSession[]>();
		for (const row of Array.isArray(recent) ? recent : []) {
			if (!row?.parentID) continue;
			const children = byParent.get(row.parentID);
			if (children) children.push(row);
			else byParent.set(row.parentID, [row]);
		}
		for (const session of sessions)
			append(session.id, byParent.get(session.id) ?? null);
	}
	const out: FoundSubagent[] = [];
	for (const s of sessions) {
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
			parentKey: s.parentID === agent.sessionId ? null : s.parentID,
			sessionId: s.id,
			file: null,
		});
	}
	return out;
}
