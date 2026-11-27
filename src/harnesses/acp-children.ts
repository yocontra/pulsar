import { createHash, randomUUID } from "node:crypto";
import {
	appendFile,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { SessionUpdate, SubagentUpdate } from "@agentclientprotocol/sdk";
import type { TranscriptEvent } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import { compactionEvent, conversationTitle } from "./acp-session-info.ts";
import { AcpToolResults } from "./acp-tool-results.ts";
import { acpTranscript, acpTranscriptPath } from "./acp-transcript.ts";
import type { FoundSubagent, HarnessDriver } from "./types.ts";

const MAX_CHILDREN = 200;
const MAX_TEXT = 16 * 1024;
const MAX_MESSAGES = 12;
const MAX_PENDING_TOOLS = 8;
const MAX_QUEUED_TRANSCRIPT_BYTES = 2 * 1024 * 1024;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
const validId = (id: string) =>
	id.length > 0 && id.length <= 512 && !/\p{Cc}/u.test(id);
const indexFile = (harness: string, rootId: string) =>
	`${acpTranscriptPath(harness, rootId)}.children.json`;
const logFile = (harness: string, rootId: string, key: string) =>
	`${acpTranscriptPath(harness, rootId)}.${key}.jsonl`;
type Metadata = Omit<FoundSubagent, "file" | "direct"> & {
	cwd: string | null;
};
type Message = { text: string; from?: string };
type Child = {
	parent: string;
	row: Metadata;
	canCancel: boolean;
	tools: AcpToolResults;
	messages: Map<string, Message>;
	lastChunk?: { key: string; id: string; text: string };
};

export class AcpChildren {
	private readonly rootMessages = new Map<string, Message>();
	private readonly history = new Map<string, Metadata>();
	private readonly children = new Map<string, Child>();
	private readonly root: string;
	private readonly harness: string;
	private readonly onChange: () => void;
	private writes = Promise.resolve();
	private queuedBytes = 0;
	private indexQueued = false;
	private overflowReported = false;

	constructor(
		harness: string,
		root: string,
		onChange: () => void,
		previous: Metadata[] = [],
	) {
		this.root = root;
		this.harness = harness;
		this.onChange = onChange;
		for (const row of previous)
			this.history.set(row.key, { ...row, state: "unknown", acpCancel: false });
	}

	get observed() {
		return this.children.size > 0 || this.history.size > 0;
	}

	announced(id: string) {
		return this.children.has(id);
	}

	ownedBy(id: string, parent: string): boolean {
		return this.children.get(id)?.parent === parent;
	}

	canCancel(id: string) {
		const child = this.children.get(id);
		return !!child && child.canCancel && child.row.state === "running";
	}

	update(
		session: string,
		update: SessionUpdate,
		recordRoot: (event: Omit<TranscriptEvent, "ts">) => void,
	): boolean {
		const child = this.children.get(session);
		if (session !== this.root && !child) return false;
		if (update.sessionUpdate === "subagent_update") {
			this.announce(session, update);
			return true;
		}
		if (
			update.sessionUpdate === "session_message" ||
			update.sessionUpdate === "session_message_chunk"
		) {
			this.sessionMessage(
				child?.messages ?? this.rootMessages,
				update,
				child ? (event) => this.recordChild(child, event) : recordRoot,
			);
			return true;
		}
		if (!child) return false;
		const record = (event: Omit<TranscriptEvent, "ts">) =>
			this.recordChild(child, event);
		const type = update.sessionUpdate;
		switch (type) {
			case "session_info_update":
				if (update.title !== undefined) {
					child.row.conversationTitle =
						conversationTitle(update.title) || undefined;
					this.persist();
				}
				break;
			case "compaction_update": {
				const event = compactionEvent(update);
				if (event) record(event);
				break;
			}
			case "agent_message_chunk":
			case "agent_thought_chunk":
			case "user_message_chunk": {
				if (update.content.type !== "text" || !update.content.text) return true;
				const kind = type === "agent_thought_chunk" ? "thinking" : "text";
				const role = type === "user_message_chunk" ? "user" : "assistant";
				const key = hash(
					JSON.stringify([role, kind, update.messageId ?? null]),
				);
				const piece = child.lastChunk;
				let id = piece?.key === key ? piece.id : randomUUID();
				let text = (piece?.key === key ? piece.text : "") + update.content.text;

				while (text.length > MAX_TEXT) {
					const end = /[\uD800-\uDBFF]/.test(text[MAX_TEXT - 1] ?? "")
						? MAX_TEXT - 1
						: MAX_TEXT;
					record({
						id: `acp:child:${id}`,
						role,
						kind,
						text: text.slice(0, end),
					});
					text = text.slice(end);
					id = randomUUID();
				}
				child.lastChunk = { key, id, text };
				record({ id: `acp:child:${id}`, role, kind, text });
				break;
			}
			case "tool_call":
			case "tool_call_update":
				if (update.sessionUpdate === "tool_call") child.lastChunk = undefined;
				for (const event of child.tools.apply(update, this.harness, true))
					record(event);
				break;
		}
		return true;
	}

	private recordChild(child: Child, event: Omit<TranscriptEvent, "ts">) {
		const path = logFile(this.harness, this.root, child.row.key);
		const line = `${JSON.stringify({ ...event, ts: Date.now() })}\n`;
		const bytes = Buffer.byteLength(line);
		if (this.queuedBytes + bytes > MAX_QUEUED_TRANSCRIPT_BYTES) {
			if (!this.overflowReported)
				console.error("ACP child transcript writes fell behind");
			this.overflowReported = true;
			return;
		}
		this.queuedBytes += bytes;
		this.write(async () => {
			try {
				await appendFile(path, line, { mode: 0o600 });
			} finally {
				this.queuedBytes -= bytes;
				if (this.queuedBytes === 0) this.overflowReported = false;
			}
		});
	}

	private write(action: () => Promise<void>) {
		this.writes = this.writes.then(action).catch((error) => {
			console.error("ACP child records could not be written", error);
		});
	}

	async flush() {
		await this.writes;
	}

	private sessionMessage(
		messages: Map<string, Message>,
		update: Extract<
			SessionUpdate,
			{ sessionUpdate: "session_message" | "session_message_chunk" }
		>,
		record: (event: Omit<TranscriptEvent, "ts">) => void,
	) {
		const id = `acp:child-message:${hash(update.messageId)}`;
		const known = messages.get(id);
		const state = known ?? { text: "" };
		if (update.sessionUpdate === "session_message") {
			for (const peer of [update.senderSessionId, update.recipientSessionId])
				if (peer && peer !== this.root && !this.children.has(peer)) return;
			if (update.senderSessionId !== undefined) {
				const sender = update.senderSessionId;
				state.from =
					sender === this.root
						? "Parent session"
						: sender
							? this.children.get(sender)?.row.name
							: undefined;
			}
			if (update.content !== undefined) {
				state.text = "";
				for (const block of update.content ?? []) {
					if (block.type !== "text") continue;
					state.text +=
						(state.text ? "\n" : "") +
						block.text.slice(0, MAX_TEXT - state.text.length);
					if (state.text.length >= MAX_TEXT) break;
				}
			}
		} else if (update.content.type === "text") {
			state.text = (state.text + update.content.text).slice(0, MAX_TEXT);
		}
		messages.set(id, state);
		if (messages.size > MAX_MESSAGES)
			messages.delete(messages.keys().next().value!);
		if (known || state.text)
			record({
				id,
				role: "peer",
				kind: "peer",
				text: state.text.slice(0, MAX_TEXT),
				from: state.from,
			});
	}

	private announce(parent: string, update: SubagentUpdate) {
		const id = update.sessionId;
		if (!validId(id) || id === this.root || id === parent) return;
		let child = this.children.get(id);
		if (child && child.parent !== parent) return;
		const now = Date.now();
		const key = hash(id);
		const parentKey = this.children.get(parent)?.row.key ?? null;
		const previous = this.history.get(key);
		if (previous && previous.parentKey !== parentKey) return;
		if (!child) {
			if (!previous && this.children.size + this.history.size >= MAX_CHILDREN)
				return;
			child = {
				parent,
				row: previous ?? {
					key,
					name: "ACP child session",
					kind: "session",
					agentType: null,
					description: null,
					state: "unknown",
					startedAt: now,
					updatedAt: now,
					finishedAt: null,
					callId: null,
					parentKey,
					sessionId: id,
					cwd: null,
				},
				canCancel: false,
				tools: new AcpToolResults(MAX_TEXT, MAX_PENDING_TOOLS),
				messages: new Map(),
			};
			this.children.set(id, child);
			this.history.delete(key);
			const log = logFile(this.harness, this.root, child.row.key);
			this.write(() => appendFile(log, "", { mode: 0o600 }));
		}
		const row = child.row;
		if (update.title !== undefined)
			row.name = conversationTitle(update.title) || "ACP child session";
		if (update.description !== undefined)
			row.description = update.description?.trim().slice(0, 800) || null;
		if (update.cwd !== undefined)
			row.cwd =
				update.cwd &&
				update.cwd.length <= 4096 &&
				isAbsolute(update.cwd) &&
				!/\p{Cc}/u.test(update.cwd)
					? update.cwd
					: null;
		if (update.capabilities !== undefined)
			child.canCancel = update.capabilities?.cancel != null;
		if (update.state !== undefined) {
			const state = update.state?.state;
			row.state =
				state === "running" || state === "requires_action"
					? "running"
					: state === "idle"
						? "idle"
						: "unknown";
			if (row.state !== "running") child.lastChunk = undefined;
		}
		row.updatedAt = now;
		this.persist();
	}

	persist() {
		if (!this.observed || this.indexQueued) return;
		this.indexQueued = true;
		const file = indexFile(this.harness, this.root);
		this.write(async () => {
			this.indexQueued = false;
			const staged = `${file}.${process.pid}.tmp`;
			await writeFile(
				staged,
				JSON.stringify([
					...this.history.values(),
					...[...this.children.values()].map(({ row, canCancel }) => ({
						...row,
						acpCancel: canCancel,
					})),
				]),
				{ mode: 0o600 },
			);
			await rename(staged, file);
			this.onChange();
		});
	}
}

export async function readAcpChildren(
	harness: string,
	session: string,
): Promise<Metadata[]> {
	const file = indexFile(harness, session);
	const size = await stat(file)
		.then(({ size }) => size)
		.catch(() => 0);
	if (!size || size > 2 * 1024 * 1024) return [];
	try {
		const rows: unknown = JSON.parse(await readFile(file, "utf8"));
		if (!Array.isArray(rows)) return [];
		return rows
			.slice(0, MAX_CHILDREN)
			.filter(
				(row): row is Metadata =>
					row &&
					typeof row.sessionId === "string" &&
					validId(row.sessionId) &&
					row.sessionId !== session &&
					hash(row.sessionId) === row.key,
			);
	} catch {
		return [];
	}
}

export const managedAcpSubagentDriver: Pick<
	HarnessDriver,
	"label" | "subagents" | "transcript"
> = {
	label: "ACP",
	subagents: {
		async stamp(agent: Agent) {
			if (!agent.sessionId) return null;
			const info = await stat(indexFile(agent.harness, agent.sessionId)).catch(
				() => null,
			);
			return info?.isFile() ? String(info.mtimeMs) : null;
		},
		async list(agent: Agent): Promise<FoundSubagent[]> {
			if (!agent.sessionId) return [];
			const rows = await readAcpChildren(agent.harness, agent.sessionId);
			const byKey = new Map(rows.map((row) => [row.key, row]));
			return rows.map((row) => {
				let cwd = row.cwd;
				let parentKey = row.parentKey;
				for (
					let depth = 0;
					!cwd && parentKey && depth < MAX_CHILDREN;
					depth++
				) {
					const parent = byKey.get(parentKey);
					cwd = parent?.cwd ?? null;
					parentKey = parent?.parentKey ?? null;
				}
				return {
					...row,
					cwd,
					file: logFile(agent.harness, agent.sessionId!, row.key),
				};
			});
		},
		async transcript(_agent, sub) {
			if (!sub.file) return null;
			return {
				source: { kind: "file", path: sub.file },
				parse: acpTranscript.parse,
			};
		},
	},
};
