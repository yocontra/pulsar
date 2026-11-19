import { basename } from "node:path";
import { parsePush } from "../push-frame.ts";
import {
	attachDocuments,
	attachImages,
	callEvent,
	contentDocuments,
	contentImages,
	contentText,
	type FoundImage,
	jsonLines,
	links,
	obj,
	partDocument,
	partImage,
	pushEvent,
	resultEvents,
	str,
	stripTags,
	toMs,
} from "../transcripts/summary.ts";
import { taskNotice, teammateMessages } from "../transcripts/team.ts";
import type {
	ParseState,
	ToolDetail,
	TranscriptEvent,
} from "../transcripts/types.ts";

/**
 * Claude Code transcript lines (`~/.claude/projects/<slug>/<session>.jsonl`).
 * Only `user`, `assistant` and the compaction marker carry events; every other
 * record type (api-request-blob, attachment, mode, ai-title, last-prompt,
 * queue-operation, …) is skipped.
 */
export function parseClaude(
	chunk: string,
	state: ParseState,
): TranscriptEvent[] {
	const out: TranscriptEvent[] = [];
	for (const rec of jsonLines(chunk)) {
		const uuid = str(rec.uuid);
		if (!uuid) continue;
		const ts = toMs(rec.timestamp);
		const sidechain =
			rec.isSidechain === true ? (str(rec.agentId) ?? "subagent") : undefined;
		const base = (id: string) => ({
			id,
			ts,
			...(sidechain ? { sidechain } : {}),
		});
		if (rec.type === "user") out.push(...userEvents(rec, uuid, base, state));
		else if (rec.type === "assistant")
			out.push(...assistantEvents(rec, uuid, base, state));
		else if (rec.type === "system" && rec.subtype === "compact_boundary")
			out.push({
				...base(uuid),
				role: "system",
				kind: "system",
				subtype: "compacted",
				text: str(rec.content) ?? "Conversation compacted",
			});
		else if (rec.type === "system" && rec.subtype === "local_command") {
			// Newer slash-command output: the same tags as a user string.
			const special = taggedUser(str(rec.content) ?? "", base(uuid));
			if (special) out.push(...special);
		} else if (rec.type === "system" && rec.subtype === "informational") {
			const text = stripTags(str(rec.content) ?? "").trim();
			if (text)
				out.push({ ...base(uuid), role: "system", kind: "system", text });
		} else if (rec.type === "attachment")
			out.push(...attachmentEvents(rec, uuid, base, state));
	}
	return out;
}

type Base = (id: string) => { id: string; ts: number; sidechain?: string };

function userEvents(
	rec: Record<string, unknown>,
	uuid: string,
	base: Base,
	state: ParseState,
): TranscriptEvent[] {
	const message = obj(rec.message);
	const origin = obj(rec.origin);
	const content = message?.content;
	// Origin first: peer messages are also marked isMeta.
	if (origin?.kind === "peer") {
		const team = teamEvents(contentText(content), uuid, base);
		if (team) return team;
		const from = str(origin.name) ?? str(origin.from);
		const text = str(origin.body) ?? contentText(content);
		const push = pulsarPush(text, from);
		if (push) return [pushEvent(base(uuid), push)];
		return [
			{
				...base(uuid),
				role: "peer",
				kind: "peer",
				text,
				...(from ? { from } : {}),
			},
		];
	}
	if (origin?.kind === "task-notification")
		return [taskEvent(base(uuid), contentText(content))];
	if (rec.isMeta === true || rec.turnCompanion || rec.isCompactSummary)
		return [];
	if (typeof content === "string") {
		// Agent-team messages: one event per teammate message.
		const team = teamEvents(content, uuid, base);
		if (team) return team;
		// Sessions from before `origin` wrap peer messages in the text.
		const peer = wrappedPeer(content);
		if (peer) {
			const push = pulsarPush(peer.text, peer.from);
			if (push) return [pushEvent(base(uuid), push)];
			return [{ ...base(uuid), role: "peer", kind: "peer", ...peer }];
		}
		const special = taggedUser(content, base(uuid));
		if (special !== undefined) return special;
		const text = userText(content);
		if (INTERRUPTED.test(text)) return [interrupted(base(uuid))];
		return text.trim()
			? [{ ...base(uuid), role: "user", kind: "text", text }]
			: [];
	}
	if (!Array.isArray(content)) return [];
	const out: TranscriptEvent[] = [];
	// Pasted images go on the message's first text event, or on their own.
	const pasted: FoundImage[] = [];
	let firstImage = -1;
	let firstText: TranscriptEvent | undefined;
	content.forEach((part, i) => {
		const block = obj(part);
		if (!block) return;
		const id = `${uuid}#${i}`;
		const image = partImage(block, ["message", "content", i]);
		const doc = partDocument(block, ["message", "content", i]);
		if (doc) {
			// A PDF the operator pasted: on its own event.
			const event: TranscriptEvent = {
				...base(id),
				role: "user",
				kind: "text",
				text: "[document]",
			};
			attachDocuments(state, event, [doc]);
			out.push(event);
		} else if (image) {
			pasted.push(image);
			if (firstImage < 0) firstImage = i;
		} else if (block.type === "text" && str(block.text)?.trim()) {
			const text = userText(block.text as string);
			if (!text.trim()) return;
			if (INTERRUPTED.test(text)) {
				out.push(interrupted(base(id)));
				return;
			}
			const event: TranscriptEvent = {
				...base(id),
				role: "user",
				kind: "text",
				text,
			};
			firstText ??= event;
			out.push(event);
		} else if (block.type === "tool_result") {
			const callId = str(block.tool_use_id);
			if (!callId) return;
			const isError =
				typeof block.is_error === "boolean" ? block.is_error : undefined;
			// A Read of a PDF: name the document after the file it read.
			const readPath = obj(state.calls.get(callId)?.input)?.file_path;
			const events = resultEvents(
				state,
				base(id),
				callId,
				contentText(block.content),
				isError,
				undefined,
				resultExtra(rec.toolUseResult),
			);
			attachImages(
				state,
				events.at(-1),
				contentImages(block.content, ["message", "content", i, "content"]),
			);
			attachDocuments(
				state,
				events.at(-1),
				contentDocuments(block.content, ["message", "content", i, "content"]),
				typeof readPath === "string" ? basename(readPath) : undefined,
			);
			out.push(...events);
		}
	});
	if (pasted.length > 0) {
		if (!firstText) {
			firstText = {
				...base(`${uuid}#${firstImage}`),
				role: "user",
				kind: "text",
				text: "[image]",
			};
			out.push(firstText);
		}
		attachImages(state, firstText, pasted);
	}
	return out;
}

/**
 * Attachments that reach the person: messages delivered while the agent was
 * busy (`queued_command`: yours, other agents', task notifications) and hook
 * messages. The rest (environment, listings, reminders) is context.
 */
function attachmentEvents(
	rec: Record<string, unknown>,
	uuid: string,
	base: Base,
	state: ParseState,
): TranscriptEvent[] {
	const a = obj(rec.attachment);
	if (!a) return [];
	if (a.type === "hook_system_message") {
		const text = str(a.content)?.trim();
		return text
			? [{ ...base(uuid), role: "system", kind: "system", text }]
			: [];
	}
	if (a.type !== "queued_command") return [];
	const origin = obj(a.origin);
	const prompt = a.prompt;
	const raw = contentText(prompt);
	if (origin?.kind === "task-notification") return [taskEvent(base(uuid), raw)];
	const team = teamEvents(raw, uuid, base);
	if (team) return team;
	if (origin?.kind === "peer") {
		const peer = wrappedPeer(raw);
		const from = peer?.from ?? str(origin.name) ?? str(origin.from);
		const text = peer?.text ?? str(origin.body) ?? raw;
		const push = pulsarPush(text, from);
		if (push) return [pushEvent(base(uuid), push)];
		return [
			{
				...base(uuid),
				role: "peer",
				kind: "peer",
				text,
				...(from ? { from } : {}),
			},
		];
	}
	const special = taggedUser(raw, base(uuid));
	if (special) return special;
	const text = userText(raw);
	if (INTERRUPTED.test(text)) return [interrupted(base(uuid))];
	const event: TranscriptEvent = {
		...base(uuid),
		role: "user",
		kind: "text",
		text: text.trim() ? text : "[image]",
	};
	const images = contentImages(prompt, ["attachment", "prompt"]);
	if (!text.trim() && !images.length) return [];
	attachImages(state, event, images);
	return [event];
}

/** What the person wrote: reminders dropped, pasted blocks unwrapped. */
function userText(text: string): string {
	return stripReminders(text).replace(
		/<pasted_content\b[^>]*>\n?([\s\S]*?)\n?<\/pasted_content\b[^>]*>/g,
		"$1",
	);
}

/** `[Request interrupted by user]` / `… for tool use]`: the person stopped the turn. */
const INTERRUPTED = /^\s*\[Request interrupted by user/;

function interrupted(base: ReturnType<Base>): TranscriptEvent {
	return {
		...base,
		role: "system",
		kind: "system",
		subtype: "interrupted",
		text: "Interrupted",
	};
}

/**
 * A background task or subagent finished: its `<result>` as a notice when it
 * has one, else its `<summary>`, else the text.
 */
function taskEvent(base: ReturnType<Base>, text: string): TranscriptEvent {
	const notice = taskNotice(text);
	if (notice)
		return {
			...base,
			role: "system",
			kind: "system",
			subtype: "task",
			...notice,
		};
	const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
	return {
		...base,
		role: "system",
		kind: "system",
		subtype: "task",
		text: summary || stripTags(text).trim(),
	};
}

/** Harness reminders injected into a user message are not what the person wrote. */
function stripReminders(text: string): string {
	return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, "");
}

const tag = (name: string, text: string) =>
	new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1];

/**
 * User strings Claude Code writes in its own markup: slash commands and their
 * output, `!` shell commands and their output, task notifications. Undefined
 * for ordinary text.
 */
function taggedUser(
	content: string,
	base: ReturnType<Base>,
): TranscriptEvent[] | undefined {
	const head = content.trimStart();
	if (!head.startsWith("<")) return undefined;
	const system = (text: string, subtype: "command" | "shell") =>
		text.trim()
			? [
					{
						...base,
						role: "system" as const,
						kind: "system" as const,
						subtype,
						text,
					},
				]
			: [];
	const stdout = tag("local-command-stdout", head);
	if (stdout !== undefined && head.startsWith("<local-command-stdout>"))
		return system(stdout, "command");
	const stderr = tag("local-command-stderr", head);
	if (stderr !== undefined && head.startsWith("<local-command-stderr>"))
		return system(stderr, "command");
	const command = tag("command-name", head);
	if (
		command !== undefined &&
		(head.startsWith("<command-name>") || head.startsWith("<command-message>"))
	) {
		const args = tag("command-args", head)?.trim();
		const name = command.trim();
		const text = args ? `${name} ${args}` : name;
		return text
			? [{ ...base, role: "user", kind: "text", subtype: "command", text }]
			: [];
	}
	const input = tag("bash-input", head);
	if (input !== undefined && head.startsWith("<bash-input>"))
		return input.trim()
			? [{ ...base, role: "user", kind: "text", subtype: "shell", text: input }]
			: [];
	if (head.startsWith("<bash-stdout>") || head.startsWith("<bash-stderr>")) {
		const out = [tag("bash-stdout", head), tag("bash-stderr", head)]
			.filter((x) => x?.trim())
			.join("\n");
		return system(out, "shell");
	}
	if (head.startsWith("<task-notification>")) return [taskEvent(base, head)];
	// Harness bookkeeping, not something anyone wrote.
	if (head.startsWith("<side-sessions-event")) return [];
	return undefined;
}

/** Facts Claude Code records beside a tool result (`toolUseResult`). */
function resultExtra(value: unknown): ToolDetail | undefined {
	const r = obj(value);
	if (!r) return undefined;
	const d: ToolDetail = {};
	if (r.interrupted === true) d.interrupted = true;
	const bg = str(r.backgroundTaskId);
	if (bg) d.background = bg.slice(0, 80);
	if (typeof r.timedOutAfterMs === "number" && r.timedOutAfterMs > 0)
		d.timedOutMs = r.timedOutAfterMs;
	const answers = obj(r.answers);
	if (answers) {
		d.answers = Object.entries(answers)
			.slice(0, 5)
			.map(([q, a]) => ({
				question: q.slice(0, 200),
				answer: answerText(a).slice(0, 200),
			}));
	}
	if (Array.isArray(r.results)) {
		const found: unknown[] = [];
		for (const item of r.results) {
			const content = obj(item)?.content;
			if (Array.isArray(content)) found.push(...content);
		}
		const l = links(found);
		if (l?.length) d.links = l;
	}
	return Object.keys(d).length ? d : undefined;
}

/** An AskUserQuestion answer: one choice, or several joined. */
function answerText(answer: unknown): string {
	if (typeof answer === "string") return answer;
	if (Array.isArray(answer)) return answer.join(", ");
	return "";
}

/** A record that is agent-team messages, bare or wrapped as a cross-session message. */
const TEAM_HEAD =
	/^(?:Another Claude session sent a message:\s*)?<teammate-message[\s>]/;

/**
 * Agent-team messages as peer events, one per `<teammate-message>`: the first
 * keeps the record's id, the rest add `#t<n>`. Null when the record is not one.
 */
function teamEvents(
	text: string,
	uuid: string,
	base: Base,
): TranscriptEvent[] | null {
	if (!TEAM_HEAD.test(text.trimStart())) return null;
	const messages = teammateMessages(text);
	if (!messages) return null;
	return messages.map((m, i) => ({
		...base(i ? `${uuid}#t${i}` : uuid),
		role: "peer",
		kind: "peer",
		text: m.text,
		...(m.from ? { from: m.from } : {}),
		notice: m.notice,
	}));
}

const WRAPPED_PEER =
	/^Another Claude session sent a message:\s*<([a-z-]+)((?:\s+[\w-]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/\1>/;

/**
 * A Claude peer message that Pulsar pushed: `claudeEnvelope` names the
 * sender "<name> via Pulsar". Any other cross-session sender (a plain Claude
 * session) can write text that looks like a frame, so it stays a peer.
 */
function pulsarPush(text: string, from: string | undefined) {
	if (!from || !/ via pulsar$/i.test(from)) return null;
	return parsePush(text);
}

/** `Another Claude session sent a message:` + `<tag from-name="…">body</tag>`. */
function wrappedPeer(text: string): { text: string; from?: string } | null {
	const m = WRAPPED_PEER.exec(text);
	if (!m) return null;
	const attrs: Record<string, string> = {};
	for (const a of (m[2] ?? "").matchAll(/([\w-]+)="([^"]*)"/g))
		attrs[a[1]!] = a[2]!;
	const from = attrs["from-name"] ?? attrs.teammate_id ?? attrs.from;
	return { text: m[3] ?? "", ...(from ? { from } : {}) };
}

function assistantEvents(
	rec: Record<string, unknown>,
	uuid: string,
	base: Base,
	state: ParseState,
): TranscriptEvent[] {
	const message = obj(rec.message);
	if (!message || !Array.isArray(message.content)) return [];
	const messageId = str(message.id);
	const model = str(message.model);
	const withModel = model && !model.startsWith("<") ? { model } : {};
	const blockIndex =
		typeof rec.apiBlockIndex === "number" ? rec.apiBlockIndex : null;
	const out: TranscriptEvent[] = [];
	message.content.forEach((part, i) => {
		const block = obj(part);
		if (!block) return;
		// One block per line sharing message.id: the API block index keys the
		// block, so a re-written line replaces the earlier one in place.
		let id = `${uuid}#${i}`;
		if (messageId && blockIndex !== null) id = `${messageId}#${blockIndex + i}`;
		else if (messageId && block.type === "tool_use" && str(block.id))
			id = `${messageId}#${block.id}`;
		if (block.type === "text" && str(block.text)?.trim())
			out.push({
				...base(id),
				...withModel,
				role: "assistant",
				kind: "text",
				text: block.text as string,
			});
		else if (block.type === "thinking" && str(block.thinking)?.trim())
			out.push({
				...base(id),
				...withModel,
				role: "assistant",
				kind: "thinking",
				text: block.thinking as string,
			});
		else if (block.type === "thinking" || block.type === "redacted_thinking")
			// Reasoning the model keeps private: only that it thought.
			out.push({
				...base(id),
				...withModel,
				role: "assistant",
				kind: "thinking",
				subtype: "hidden",
				text: "",
			});
		else if (
			typeof block.type === "string" &&
			block.type.endsWith("_tool_result") &&
			str(block.tool_use_id)
		) {
			// Server tools (web search, advisor) answer inside the assistant turn.
			const content = Array.isArray(block.content) ? block.content : [];
			const found = links(content);
			const text =
				contentText(content) ||
				(found ?? []).map((l) => `${l.title}\n${l.url}`).join("\n\n");
			out.push(
				...resultEvents(
					state,
					base(id),
					block.tool_use_id as string,
					text,
					obj(block.content)?.type === "web_search_tool_result_error"
						? true
						: undefined,
					undefined,
					found?.length ? { links: found } : undefined,
				),
			);
		} else if (block.type === "tool_use" || block.type === "server_tool_use") {
			const callId = str(block.id);
			const name = str(block.name);
			if (callId && name) {
				const call = callEvent(
					state,
					{ ...base(id), ...withModel },
					name,
					callId,
					block.input,
				);
				// Where the session was when it made the call (after a `cd`).
				const cwd = str(rec.cwd);
				if (call.tool && cwd && cwd !== state.cwd && cwd.length <= 1024)
					call.tool.cwd = cwd;
				out.push(call);
			}
		}
	});
	return out;
}
