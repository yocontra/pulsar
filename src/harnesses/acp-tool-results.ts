import { createHash, randomUUID } from "node:crypto";
import type { SessionUpdate, ToolCallContent } from "@agentclientprotocol/sdk";
import { toolPath } from "../transcripts/describe.ts";
import { MAX_PENDING_CALLS } from "../transcripts/summary.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import { antigravityToolInput } from "./antigravity-steps.ts";

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

interface ToolState {
	callEventId: string;
	name: string;
	title: string;
	rawInput?: unknown;
	path?: string;
	inputTruncated: boolean;
	content: string;
	raw: string;
	kind?: Update["kind"];
	exitCode?: number;
	permissionScope?: symbol;
}

type ToolEvent = Omit<TranscriptEvent, "ts">;

/** ACP updates replace individual fields. A completion can carry only its status. */
export class AcpToolResults {
	private readonly pending = new Map<string, ToolState>();

	private readonly limit: number;
	private readonly pendingLimit: number;

	constructor(limit: number, pendingLimit = MAX_PENDING_CALLS) {
		this.limit = limit;
		this.pendingLimit = pendingLimit;
	}

	has(id: string): boolean {
		return this.pending.has(id.slice(0, 500));
	}

	permissionInput(id: string, scope: symbol | undefined) {
		if (!scope || id.length > 500) return undefined;
		const state = this.pending.get(id);
		if (state?.permissionScope !== scope || state.rawInput == null)
			return undefined;
		return { input: state.rawInput, title: state.title || state.name };
	}

	apply(
		update: Update,
		harness: string,
		child = false,
		permissionScope?: symbol,
	): ToolEvent[] {
		const id = update.toolCallId.slice(0, 500);
		const prior = this.pending.get(id);
		const fresh =
			update.sessionUpdate === "tool_call" &&
			permissionScope !== prior?.permissionScope;
		const state: ToolState = (!fresh ? prior : undefined) ?? {
			callEventId: child
				? `acp:child-tool:${createHash("sha256").update(update.toolCallId).digest("hex")}`
				: randomUUID(),
			name: "",
			title: "",
			inputTruncated: false,
			content: "",
			raw: "",
			permissionScope:
				update.sessionUpdate === "tool_call" && id === update.toolCallId
					? permissionScope
					: undefined,
		};
		if (update.name) state.name = update.name.slice(0, 200);
		if (update.title) state.title = update.title.slice(0, 500);
		if (update.kind) state.kind = update.kind;
		const name = state.name || state.title.slice(0, 200) || "ACP tool";
		if (update.rawInput !== undefined) {
			state.inputTruncated =
				Buffer.byteLength(JSON.stringify(update.rawInput)) > this.limit;
			state.rawInput = state.inputTruncated ? undefined : update.rawInput;
		}
		if (update.locations) state.path = update.locations[0]?.path.slice(0, 4096);
		if (update.content)
			state.content = readableContent(update.content, this.limit);
		if (update.rawOutput !== undefined) {
			const raw = update.rawOutput;
			const shell = state.kind === "execute" || name === "run_command";
			const structured =
				shell && raw && typeof raw === "object" && !Array.isArray(raw)
					? (raw as Record<string, unknown>)
					: null;
			const output = structured?.output ?? structured?.text;
			const code = structured?.exitCode ?? structured?.exit_code;
			state.exitCode =
				typeof code === "number" && Number.isSafeInteger(code)
					? code
					: undefined;
			state.raw = (
				typeof raw === "string"
					? raw
					: typeof output === "string"
						? output
						: JSON.stringify(raw)
			).slice(0, this.limit + 1);
		}
		const done = update.status === "completed" || update.status === "failed";
		const events: ToolEvent[] = [];
		if (
			update.sessionUpdate === "tool_call" ||
			update.name ||
			update.title ||
			update.rawInput !== undefined ||
			update.locations
		) {
			let input =
				harness === "antigravity"
					? antigravityToolInput(name, state.rawInput)
					: state.rawInput;
			if (
				state.path &&
				!toolPath(input) &&
				(input == null || (typeof input === "object" && !Array.isArray(input)))
			)
				input = { ...(input as object), path: state.path };
			events.push({
				id: state.callEventId,
				role: "tool",
				kind: "tool_call",
				text: state.title || name,
				tool: {
					name,
					callId: id,
					input,
					done,
					...(state.inputTruncated ? { truncated: true } : {}),
				},
			});
		}
		if (!done) {
			this.pending.set(id, state);
			if (this.pending.size > this.pendingLimit)
				this.pending.delete(this.pending.keys().next().value!);
			return events;
		}
		this.pending.delete(id);
		const text = state.content || state.raw;
		events.push({
			id: `acp:tool:${id}:result`,
			role: "tool",
			kind: "tool_result",
			text: text.slice(0, this.limit),
			tool: {
				name,
				callId: id,
				isError: update.status === "failed",
				truncated: text.length > this.limit,
				...(state.exitCode === undefined
					? {}
					: { detail: { exitCode: state.exitCode } }),
			},
		});
		return events;
	}
}
