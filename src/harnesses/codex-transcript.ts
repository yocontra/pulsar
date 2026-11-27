import { parsePush } from "../push-frame.ts";
import {
	attachImages,
	callEvent,
	contentImages,
	contentText,
	jsonLines,
	obj,
	parseArgs,
	pushEvent,
	resultEvents,
	str,
	toMs,
} from "../transcripts/summary.ts";
import type { ParseState, TranscriptEvent } from "../transcripts/types.ts";

/** Instructions and environment Codex injects as user messages. */
const INJECTED =
	/^\s*(?:# AGENTS\.md instructions|<environment_context>|<user_instructions>|<INSTRUCTIONS>|<permissions instructions>)/;

/** A short stable hash, for records that carry no id of their own. */
function hash(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		h ^= text.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36);
}

/**
 * Codex rollout lines (`{timestamp, ordinal, type, payload}`). Events come
 * from `response_item`s; `turn_context` only tells later items their model.
 * Forked rollouts copy their parent's items with the fork's `timestamp`, so
 * the item's own `create_time` wins when present.
 */
export function parseCodex(
	chunk: string,
	state: ParseState,
): TranscriptEvent[] {
	const out: TranscriptEvent[] = [];
	for (const rec of jsonLines(chunk)) {
		const payload = obj(rec.payload);
		if (!payload) continue;
		if (rec.type === "turn_context") {
			if (str(payload.model)) state.flags.model = payload.model;
			continue;
		}
		if (rec.type === "compacted") {
			out.push({
				id: str(payload.id) ?? `compacted:${hash(JSON.stringify(rec))}`,
				ts: toMs(rec.timestamp),
				role: "system",
				kind: "system",
				subtype: "compacted",
				text: "Conversation compacted",
			});
			continue;
		}
		if (rec.type === "event_msg" && payload.type === "turn_aborted") {
			out.push({
				id: `aborted:${hash(JSON.stringify(rec))}`,
				ts: toMs(rec.timestamp),
				role: "system",
				kind: "system",
				subtype: "interrupted",
				text: "Interrupted",
			});
			continue;
		}
		if (rec.type === "event_msg" && payload.type === "item_completed") {
			const item = obj(payload.item);
			if (item?.type === "McpToolCall") out.push(...mcpCall(state, rec, item));
			continue;
		}
		if (rec.type !== "response_item") continue;
		const meta = obj(payload.internal_chat_message_metadata_passthrough);
		const ts = toMs(meta?.create_time, toMs(rec.timestamp));
		const callId = str(payload.call_id);
		const id =
			str(payload.id) ??
			(callId ? `${callId}#${payload.type}` : `h${hash(JSON.stringify(rec))}`);
		const model = str(state.flags.model);
		const withModel = model ? { model } : {};
		switch (payload.type) {
			case "message": {
				if (payload.role === "user") {
					const text = contentText(payload.content);
					// Child rollouts can begin directly with a real task or peer message.
					if (INJECTED.test(text) || !text.trim()) break;
					// Pulsar pushes arrive as queued prompts: read the frame back.
					const push = parsePush(text);
					// A `[pulsar]` frame we can't read is still a peer's, never the operator's.
					const event: TranscriptEvent = push
						? pushEvent({ id, ts }, push)
						: text.startsWith("[pulsar] ")
							? { id, ts, role: "peer", kind: "peer", text }
							: { id, ts, role: "user", kind: "text", text };
					attachImages(
						state,
						event,
						contentImages(payload.content, ["payload", "content"]),
					);
					out.push(event);
				} else if (payload.role === "assistant") {
					const text = contentText(payload.content);
					if (text.trim())
						out.push({
							id,
							ts,
							...withModel,
							role: "assistant",
							kind: "text",
							text,
						});
				}
				// developer and system messages are instructions, not conversation.
				break;
			}
			case "reasoning": {
				const raw = contentText(payload.summary);
				const text = raw.trim() ? raw : "";
				out.push({
					id,
					ts,
					...withModel,
					role: "assistant",
					kind: "thinking",
					text,
					// Encrypted reasoning without a summary: only that it thought.
					...(text ? {} : { subtype: "hidden" as const }),
				});
				break;
			}
			case "local_shell_call": {
				if (!callId) break;
				out.push(
					callEvent(
						state,
						{ id, ts, ...withModel },
						"local_shell",
						callId,
						obj(payload.action) ?? {},
					),
				);
				break;
			}
			case "web_search_call": {
				// Searches run on the server: the call is its own result.
				const action = obj(payload.action) ?? {};
				const searchId = callId ?? id;
				const call = callEvent(
					state,
					{ id, ts, ...withModel },
					"web_search",
					searchId,
					{ action },
				);
				const failed = payload.status === "failed";
				const done = resultEvents(
					state,
					{ id: `${id}#result`, ts },
					searchId,
					"",
					failed ? true : undefined,
				);
				out.push(...(done.length > 1 ? done : [call, ...done]));
				break;
			}
			case "function_call":
			case "custom_tool_call": {
				const name = str(payload.name);
				if (!name || !callId) break;
				// Already shown from its McpToolCall item.
				if (seenCalls(state).has(callId)) break;
				seenCalls(state).add(callId);
				const input =
					payload.type === "function_call"
						? parseArgs(payload.arguments)
						: payload.input;
				const call = callEvent(
					state,
					{ id, ts, ...withModel },
					name,
					callId,
					input,
				);
				// A code-mode wait only polls an existing cell. Show it when it returns useful output.
				if (!cellWait(name, input)) out.push(call);
				break;
			}
			case "function_call_output":
			case "custom_tool_call_output": {
				if (!callId) break;
				if (seenResults(state).has(callId)) break;
				seenResults(state).add(callId);
				const { text, isError } = codexOutput(payload.output);
				const pending = state.calls.get(callId);
				const outputName = str(payload.name);
				const isCellWait = pending
					? cellWait(pending.name, pending.input)
					: outputName === "functions.wait";
				if (isCellWait && !isError && emptyCellOutput(text)) {
					state.calls.delete(callId);
					break;
				}
				const events = resultEvents(
					state,
					{ id, ts },
					callId,
					text,
					isError,
					outputName,
				);
				attachImages(state, events.at(-1), outputImages(payload.output));
				out.push(...events);
				break;
			}
		}
	}
	return out;
}

function cellWait(name: string, input: unknown): boolean {
	return (
		(name === "wait" || name === "functions.wait") &&
		typeof obj(input)?.cell_id === "string"
	);
}

/** Code mode wraps a cell's output, which can itself be an empty terminal poll. */
function emptyCellOutput(text: string): boolean {
	const output = text
		.replace(
			/^(?:Script running with cell ID [^\n]+|Script completed)\r?\nWall time [\d.]+ seconds\r?\nOutput:\s*/,
			"",
		)
		.trim();
	if (!output) return true;
	if (!output.startsWith("{")) return false;
	const poll = obj(parseArgs(output));
	return (
		!!poll &&
		typeof poll.chunk_id === "string" &&
		poll.output === "" &&
		(poll.exit_code === 0 ||
			(poll.exit_code == null && typeof poll.session_id === "number"))
	);
}

/** How many call ids to remember for deduping (a long session holds thousands). */
const SEEN_MAX = 2000;

function idSet(state: ParseState, key: string): Set<string> {
	let s = state.flags[key] as Set<string> | undefined;
	if (!s) {
		s = new Set();
		state.flags[key] = s;
	}
	if (s.size > SEEN_MAX) s.delete(s.values().next().value as string);
	return s;
}

/** Call ids already emitted as a call. */
const seenCalls = (state: ParseState) => idSet(state, "seenCalls");
/** Call ids whose result was already emitted. */
const seenResults = (state: ParseState) => idSet(state, "seenResults");

/**
 * An MCP tool call. Codex records these only as `event_msg` /
 * `item_completed` items (`{type: "McpToolCall", id, server, tool,
 * arguments, status, result}`), not as `response_item`s: shown as a call
 * named `mcp__<server>__<tool>` with its result, like Claude's.
 */
function mcpCall(
	state: ParseState,
	rec: Record<string, unknown>,
	item: Record<string, unknown>,
): TranscriptEvent[] {
	const callId = str(item.id);
	const server = str(item.server);
	const tool = str(item.tool);
	if (!callId || !server || !tool) return [];
	const ts = toMs(rec.timestamp);
	const model = str(state.flags.model);
	const result = obj(item.result);
	const error = str(item.error) ?? str(obj(item.error)?.message);
	const failed =
		item.status === "failed" ||
		result?.isError === true ||
		result?.is_error === true ||
		!!error;
	const text =
		(result ? contentText(result.content) : "") ||
		error ||
		(failed ? "failed" : "");
	let call: TranscriptEvent | null = null;
	if (!seenCalls(state).has(callId)) {
		seenCalls(state).add(callId);
		call = callEvent(
			state,
			{ id: `${callId}#mcp`, ts, ...(model ? { model } : {}) },
			`mcp__${server}__${tool}`,
			callId,
			parseArgs(item.arguments) ?? {},
		);
	}
	if (seenResults(state).has(callId)) return call ? [call] : [];
	seenResults(state).add(callId);
	const done = resultEvents(
		state,
		{ id: `${callId}#mcp-result`, ts },
		callId,
		text,
		failed ? true : undefined,
		`mcp__${server}__${tool}`,
	);
	attachImages(
		state,
		done.at(-1),
		contentImages(result?.content, ["payload", "item", "result", "content"]),
	);
	// The call comes back with its result folded in (same id): keep that one.
	return done.length > 1 || !call ? done : [call, ...done];
}

/** A tool output: plain text, `{output, metadata: {exit_code}}` JSON, or content parts. */
function codexOutput(output: unknown): { text: string; isError?: boolean } {
	const parsed = parseArgs(output);
	if (Array.isArray(parsed)) return { text: contentText(parsed) };
	const o = obj(parsed);
	if (o && typeof o.output === "string") {
		if (o.is_error === true) return { text: o.output, isError: true };
		const code = obj(o.metadata)?.exit_code;
		return typeof code === "number"
			? { text: `${o.output}\nExit code: ${code}`, isError: code !== 0 }
			: { text: o.output };
	}
	return { text: typeof output === "string" ? output : contentText(output) };
}

/** Images in a tool output: content parts, inline or as a JSON-encoded string. */
function outputImages(output: unknown) {
	if (Array.isArray(output))
		return contentImages(output, ["payload", "output"]);
	if (typeof output !== "string" || !output.startsWith("[")) return [];
	const parsed = parseArgs(output);
	return Array.isArray(parsed)
		? contentImages(parsed, ["payload", "output", "<json>"])
		: [];
}
