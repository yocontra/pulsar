import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../canonical.ts";
import type { Agent } from "../types.ts";
import type { LocalAnswerCheck, PromptRef } from "./types.ts";

/**
 * How the daemon learns that a Claude Code permission prompt was answered in
 * the terminal (tested with Claude Code 2.1.326 in tmux):
 *
 * - Escape or "No" kills the hook (SIGTERM within ~300 ms): the approvals
 *   service sees the hook's socket close. Handled there, not here.
 * - "Yes" leaves the hook running. The session record
 *   (`~/.claude/sessions/<pid>.json`) shows `status: "waiting"` with
 *   `waitingFor: "permission prompt"` while the prompt shows and changes to
 *   `busy` within ~400 ms of the answer. This is the fast signal.
 * - The transcript's `tool_result` for the call carries `permissionDecision`
 *   (`source: "user_temporary"`, or `"hook"` when a hook decided), but only
 *   once the tool finishes. This is the confirmation for prompts the session
 *   record can't tell apart (several queued in one session).
 */

interface SessionStatus {
	status: string;
	waitingFor: string | null;
	statusUpdatedAt: number;
}

/** How many reads in a row must show the prompt gone (a queue can flicker between prompts). */
const SETTLE_READS = 2;
/** How far back the transcript is read for the prompt's tool call. */
const LOOKBACK = 1024 * 1024;
const MAX_READ = 4 * 1024 * 1024;

async function readStatus(
	dir: string,
	agent: Pick<Agent, "sessionId" | "pid">,
): Promise<SessionStatus | null> {
	const parse = async (file: string): Promise<SessionStatus | null> => {
		try {
			const r = JSON.parse(await readFile(join(dir, file), "utf8")) as Record<
				string,
				unknown
			>;
			if (agent.sessionId && r.sessionId !== agent.sessionId) return null;
			return typeof r.status === "string"
				? {
						status: r.status,
						waitingFor: typeof r.waitingFor === "string" ? r.waitingFor : null,
						statusUpdatedAt: Number(r.statusUpdatedAt ?? r.updatedAt ?? 0),
					}
				: null;
		} catch {
			return null;
		}
	};
	if (agent.pid) {
		const direct = await parse(`${agent.pid}.json`);
		if (direct) return direct;
	}
	if (!agent.sessionId) return null;
	try {
		for (const f of await readdir(dir))
			if (f.endsWith(".json")) {
				const s = await parse(f);
				if (s) return s;
			}
	} catch {}
	return null;
}

/** Reads a file's new lines from an offset; keeps a partial last line for the next read. */
class LineReader {
	private offset = 0;
	private rest = "";
	private readonly path: string;
	/** The starting offset, from the size when the reader was made. */
	private readonly ready: Promise<void>;
	constructor(path: string, start: "lookback" | "end") {
		this.path = path;
		this.ready = stat(path).then(
			(st) => this.startAt(start === "end" ? st.size : st.size - LOOKBACK),
			() => this.startAt(0),
		);
	}

	private startAt(offset: number) {
		this.offset = Math.max(0, offset);
		if (this.offset > 0) this.rest = "\u0000"; // the first line is partial: skip it
	}

	async lines(): Promise<string[]> {
		await this.ready;
		let fh: Awaited<ReturnType<typeof open>>;
		try {
			fh = await open(this.path, "r");
		} catch {
			return [];
		}
		try {
			const size = (await fh.stat()).size;
			if (size < this.offset) {
				this.offset = 0;
				this.rest = "";
			}
			const length = Math.min(size - this.offset, MAX_READ);
			if (length <= 0) return [];
			const buf = Buffer.alloc(length);
			await fh.read(buf, 0, length, this.offset);
			this.offset += length;
			const text = this.rest + buf.toString("utf8");
			const parts = text.split("\n");
			this.rest = parts.pop() ?? "";
			if (parts[0]?.startsWith("\u0000")) parts.shift();
			return parts;
		} finally {
			await fh.close();
		}
	}
}

type Block = {
	type?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
};

/** Watches one prompt: the session record first, the transcript as confirmation. */
export function claudeLocalAnswer(
	sessionsDir: string,
	agent: Pick<Agent, "sessionId" | "pid" | "cwd">,
	prompt: PromptRef,
): LocalAnswerCheck {
	const want = canonicalJson(prompt.input);
	const calls = new Set<string>();
	const reader = prompt.transcriptPath
		? new LineReader(prompt.transcriptPath, "lookback")
		: null;
	let goneReads = 0;

	const transcriptSays = async (): Promise<boolean> => {
		if (!reader) return false;
		for (const line of await reader.lines()) {
			if (!line.includes('"tool_use') && !line.includes("permissionDecision"))
				continue;
			let r: {
				type?: string;
				timestamp?: string;
				message?: { content?: unknown };
				permissionDecision?: { source?: string };
			};
			try {
				r = JSON.parse(line);
			} catch {
				continue;
			}
			const content = Array.isArray(r.message?.content)
				? (r.message.content as Block[])
				: [];
			for (const b of content) {
				if (
					r.type === "assistant" &&
					b.type === "tool_use" &&
					b.id &&
					b.name === prompt.tool &&
					canonicalJson(b.input) === want
				)
					calls.add(b.id);
				// Only an answer given after this prompt: the same call answered
				// earlier (same tool and input) is still in the lookback.
				if (
					r.type === "user" &&
					b.type === "tool_result" &&
					b.tool_use_id &&
					calls.has(b.tool_use_id) &&
					r.permissionDecision &&
					r.permissionDecision.source !== "hook" &&
					Date.parse(r.timestamp ?? "") >= prompt.createdAt
				)
					return true;
			}
		}
		return false;
	};

	return async () => {
		const s = await readStatus(sessionsDir, agent);
		if (s) {
			const showing = s.status === "waiting";
			goneReads =
				!showing && s.statusUpdatedAt >= prompt.createdAt ? goneReads + 1 : 0;
			if (goneReads >= SETTLE_READS) return true;
		}
		return transcriptSays();
	};
}
