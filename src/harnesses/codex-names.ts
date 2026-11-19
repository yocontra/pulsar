import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../types.ts";
import type { HarnessName } from "./types.ts";

/**
 * Codex thread names: `/rename` and the Codex app append
 * `{"id", "thread_name", "updated_at"}` to `$CODEX_HOME/session_index.jsonl`
 * (the last line for a thread wins). Codex keeps no flag for typed versus
 * generated names, so each counts as the user's. Read incrementally: only
 * the bytes appended since the last read, async, so the daemon never blocks.
 */

/** Most names kept; past it the oldest go (the index has one line per rename). */
const MAX_NAMES = 5000;
/** Most bytes read in one go (a first read of a large index takes a few). */
const CHUNK = 256 * 1024;

export class CodexNameIndex {
	private names = new Map<string, string>();
	private offset = 0;
	private rest = "";
	private ino = -1;
	private readonly file: () => string;

	constructor(file: () => string) {
		this.file = file;
	}

	/** Reads what was appended; a replaced or shrunk file is read again from the start. */
	async refresh(): Promise<void> {
		const path = this.file();
		let st: Awaited<ReturnType<typeof stat>>;
		try {
			st = await stat(path);
		} catch {
			return;
		}
		if (st.ino !== this.ino || st.size < this.offset) {
			this.names.clear();
			this.offset = 0;
			this.rest = "";
			this.ino = st.ino;
		}
		if (st.size === this.offset) return;
		const fh = await open(path, "r");
		try {
			while (this.offset < st.size) {
				const buf = Buffer.alloc(Math.min(CHUNK, st.size - this.offset));
				const { bytesRead } = await fh.read(buf, 0, buf.length, this.offset);
				if (bytesRead === 0) break;
				this.offset += bytesRead;
				this.take(buf.subarray(0, bytesRead).toString("utf8"));
			}
		} finally {
			await fh.close();
		}
	}

	private take(text: string) {
		const lines = (this.rest + text).split("\n");
		this.rest = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const row = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
				if (typeof row.id !== "string" || typeof row.thread_name !== "string")
					continue;
				this.names.delete(row.id);
				this.names.set(row.id, row.thread_name);
				if (this.names.size > MAX_NAMES)
					this.names.delete(this.names.keys().next().value as string);
			} catch {
				// A torn or foreign line; the next rename writes a whole one.
			}
		}
	}

	get(threadId: string): string | undefined {
		return this.names.get(threadId);
	}
}

const index = new CodexNameIndex(() =>
	join(
		process.env.CODEX_HOME ?? join(homedir(), ".codex"),
		"session_index.jsonl",
	),
);

/** The names Codex gives these agents' threads (agents with no name are left out). */
export async function codexNames(
	agents: Agent[],
	from: CodexNameIndex = index,
): Promise<HarnessName[]> {
	await from.refresh();
	const out: HarnessName[] = [];
	for (const agent of agents) {
		const name = agent.sessionId ? from.get(agent.sessionId) : undefined;
		if (name?.trim()) out.push({ agent, name, source: "user" });
	}
	return out;
}
