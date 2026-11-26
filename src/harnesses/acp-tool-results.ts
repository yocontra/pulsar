import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { MAX_PENDING_CALLS } from "../transcripts/summary.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";

type Update = Extract<
	SessionUpdate,
	{ sessionUpdate: "tool_call" | "tool_call_update" }
>;

function readableContent(items: ToolCallContent[], limit: number): string {
	let text = "";
	for (const item of items) {
		let part = "";
		if (item.type === "diff") {
			part = [item.path, "---", item.oldText ?? "", "+++", item.newText].join(
				"\n",
			);
		} else if (item.type === "content") {
			const block = item.content;
			if (block.type === "text") part = block.text;
			else if (block.type === "resource_link") part = block.uri;
			else if (block.type === "image" || block.type === "audio")
				part = `[${block.type}]`;
			else if (block.type === "resource")
				part =
					"text" in block.resource ? block.resource.text : block.resource.uri;
		}
		if (!part) continue;
		text += (text ? "\n" : "") + part.slice(0, limit + 1 - text.length);
		if (text.length > limit) break;
	}
	return text;
}

/** ACP updates replace individual fields. A completion can carry only its status. */
export class AcpToolResults {
	private readonly pending = new Map<
		string,
		{ name: string; content: string; raw: string }
	>();

	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	has(id: string): boolean {
		return this.pending.has(id.slice(0, 500));
	}

	apply(update: Update): Omit<TranscriptEvent, "ts"> | null {
		const id = update.toolCallId.slice(0, 500);
		const state = this.pending.get(id) ?? {
			name: "ACP tool",
			content: "",
			raw: "",
		};
		state.name = (update.name ?? update.title ?? state.name).slice(0, 200);
		if (update.content)
			state.content = readableContent(update.content, this.limit);
		if (update.rawOutput !== undefined) {
			const raw = update.rawOutput;
			state.raw = (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(
				0,
				this.limit + 1,
			);
		}
		if (update.status !== "completed" && update.status !== "failed") {
			this.pending.set(id, state);
			if (this.pending.size > MAX_PENDING_CALLS)
				this.pending.delete(this.pending.keys().next().value!);
			return null;
		}
		this.pending.delete(id);
		const text = state.content || state.raw;
		return {
			id: `acp:tool:${id}:result`,
			role: "tool",
			kind: "tool_result",
			text: text.slice(0, this.limit),
			tool: {
				name: state.name,
				callId: id,
				isError: update.status === "failed",
				truncated: text.length > this.limit,
			},
		};
	}
}
