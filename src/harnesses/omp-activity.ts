import { toolKind } from "../transcripts/describe.ts";
import { jsonLines, obj } from "../transcripts/summary.ts";
import { statAsync, tailAsync } from "../util.ts";
import { hostSessionId, locatePiStyle } from "./pi-sessions.ts";
import type { SessionRef } from "./types.ts";

const TAIL_BYTES = 64 * 1024;
const MISS_RETRY_MS = 60_000;

function toolAction(name: unknown, completed: boolean): string {
	const kind = typeof name === "string" ? toolKind(name) : "other";
	switch (kind) {
		case "shell":
			return completed ? "Ran a command" : "Requested a command";
		case "read":
		case "list":
			return completed ? "Read workspace files" : "Requested a file read";
		case "edit":
		case "patch":
		case "write":
		case "notebook":
			return completed ? "Finished a file change" : "Requested a file change";
		case "search":
		case "websearch":
		case "fetch":
			return completed ? "Received search results" : "Requested a search";
		case "task":
			return completed
				? "Received a subagent result"
				: "Requested a subagent task";
		default:
			return completed ? "Received a tool result" : "Called a tool";
	}
}

function lastAction(tail: string): string | null {
	// A partial line at either end is not an activity record.
	for (let end = tail.lastIndexOf("\n"); end > 0; ) {
		const start = tail.lastIndexOf("\n", end - 1);
		const row = jsonLines(tail.slice(start + 1, end))[0];
		end = start;
		if (row?.type !== "message") continue;
		const message = obj(row.message);
		if (message?.role === "toolResult")
			return message.isError === true
				? "Tool returned an error"
				: toolAction(message.toolName, true);
		if (message?.role === "user") return "Received a prompt";
		if (message?.role !== "assistant" || !Array.isArray(message.content))
			continue;
		for (let i = message.content.length - 1; i >= 0; i--) {
			const part = obj(message.content[i]);
			if (part?.type === "toolCall") return toolAction(part.name, false);
			if (
				part?.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim()
			)
				return "Sent a reply";
		}
	}
	return null;
}

interface OmpActivity {
	path: string;
	size: number;
	mtimeMs: number;
	label: string | null;
}

async function readOmpActivity(
	agent: SessionRef,
	previous?: OmpActivity,
): Promise<OmpActivity | undefined> {
	const source = await locatePiStyle("omp", agent, undefined, undefined, true);
	// Several sessions can share a working directory. Never project another
	// session's activity when identity could only be guessed from that folder.
	if (source?.kind !== "file" || source.guess) return;
	const info = await statAsync(source.path);
	if (!info) return;
	if (
		previous?.path === source.path &&
		previous.size === info.size &&
		previous.mtimeMs === info.mtimeMs
	)
		return previous;
	const tail = await tailAsync(source.path, TAIL_BYTES);
	// Keep a known action when a long or incomplete new record fills the
	// tail. Clear it if the file was replaced, truncated or changed session.
	const label =
		lastAction(tail) ??
		(previous?.path === source.path && info.size >= previous.size
			? previous.label
			: null);
	return { path: source.path, ...info, label };
}

const activityByAgent = new WeakMap<SessionRef, OmpActivity>();
const missingByAgent = new WeakMap<
	SessionRef,
	{
		sessionId: string | null;
		pid: number | null | undefined;
		cwd: string | null;
		until: number;
	}
>();

export async function ompActivity(
	agent: SessionRef,
	now = Date.now(),
): Promise<string | null> {
	const sessionId = hostSessionId(agent);
	const { pid, cwd } = agent;
	const missed = missingByAgent.get(agent);
	if (
		missed?.sessionId === sessionId &&
		missed.pid === pid &&
		missed.cwd === cwd &&
		missed.until > now
	)
		return null;
	const next = await readOmpActivity(agent, activityByAgent.get(agent));
	if (
		hostSessionId(agent) !== sessionId ||
		agent.pid !== pid ||
		agent.cwd !== cwd
	)
		return null;
	if (next) {
		missingByAgent.delete(agent);
		activityByAgent.set(agent, next);
	} else {
		missingByAgent.set(agent, {
			sessionId,
			pid,
			cwd,
			until: now + MISS_RETRY_MS,
		});
		activityByAgent.delete(agent);
	}
	return next?.label ?? null;
}
