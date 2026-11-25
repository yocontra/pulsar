import { isAbsolute } from "node:path";
import { headAsync } from "../util.ts";
import { codexRolloutAsync } from "./codex.ts";
import { CODEX_THREAD_ID } from "./codex-ident.ts";
import { codexControlReady, codexRpc } from "./codex-rpc.ts";

export interface CodexThreadIdentity {
	id: string;
	cwd: string | null;
	parentId: string | null;
	title: string | null;
}

function identity(
	id: string,
	parent: unknown,
	cwd: unknown,
	title?: unknown,
): CodexThreadIdentity | null {
	if (
		parent != null &&
		(typeof parent !== "string" ||
			!CODEX_THREAD_ID.test(parent) ||
			parent === id)
	)
		return null;
	return {
		id,
		parentId: parent ?? null,
		cwd: typeof cwd === "string" && isAbsolute(cwd) ? cwd : null,
		title: typeof title === "string" ? title.trim().slice(0, 80) || null : null,
	};
}

export function codexRolloutIdentity(
	id: string,
	firstLine: string,
): CodexThreadIdentity | null {
	try {
		const entry = JSON.parse(firstLine);
		const p = entry?.payload;
		if (entry?.type !== "session_meta" || p?.id !== id) return null;
		const sub = p.source?.subagent ?? p.source?.subAgent;
		const spawn = sub?.thread_spawn ?? sub?.threadSpawn;
		const parent = spawn?.parent_thread_id ?? spawn?.parentThreadId;
		if (sub && !parent) return null;
		return identity(
			id,
			parent,
			p.cwd,
			spawn?.agent_nickname ?? spawn?.agentNickname,
		);
	} catch {
		return null;
	}
}

/** The calling thread's own durable metadata. Never guess a lineage by cwd or PID. */
export async function codexThreadIdentity(
	threadId: string,
): Promise<CodexThreadIdentity | null> {
	if (!CODEX_THREAD_ID.test(threadId)) return null;
	const file = await codexRolloutAsync(threadId);
	if (file) {
		const raw = await headAsync(file, 128 * 1024);
		const end = raw.indexOf("\n");
		if (end >= 0) {
			const thread = codexRolloutIdentity(threadId, raw.slice(0, end));
			if (thread) return thread;
		}
	}
	if (!(await codexControlReady())) return null;
	try {
		const [result] = await codexRpc(
			[["thread/read", { threadId, includeTurns: false }]],
			{ timeoutMs: 4000, experimental: true },
		);
		const data = (
			result as {
				thread?: {
					id?: unknown;
					parentThreadId?: unknown;
					cwd?: unknown;
					agentNickname?: unknown;
					name?: unknown;
				};
			}
		)?.thread;
		if (data?.id !== threadId || !Object.hasOwn(data, "parentThreadId"))
			return null;
		return identity(
			threadId,
			data.parentThreadId,
			data.cwd,
			data.agentNickname ?? data.name,
		);
	} catch {
		return null;
	}
}
