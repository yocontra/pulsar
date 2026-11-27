import { parsePush } from "../push-frame.ts";
import { backgroundJob } from "../transcripts/background-job.ts";
import {
	attachImages,
	callEvent,
	contentImages,
	contentText,
	jsonLines,
	obj,
	pushEvent,
	resultEvents,
	str,
	stripTags,
	toMs,
} from "../transcripts/summary.ts";
import type {
	ParseState,
	ToolDetail,
	TranscriptEvent,
} from "../transcripts/types.ts";
import { xdCall, xdResult } from "./omp-xd.ts";

/** Counts omp puts in a result's `details`, over guesses from its text. */
function ompDetail(
	tool: string | undefined,
	details: unknown,
): ToolDetail | undefined {
	const d = obj(details);
	if (!d) return undefined;
	const num = (v: unknown) =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;
	if (tool === "grep" && num(d.matchCount) !== undefined)
		return { count: num(d.matchCount) };
	if (tool === "glob" && num(d.fileCount) !== undefined)
		return { count: num(d.fileCount) };
	if (tool === "bash" && num(d.exitCode) !== undefined)
		return { exitCode: num(d.exitCode) };
	if (d.interrupted === true) return { interrupted: true };
	return undefined;
}

/** OMP embeds its shell preview in the first line, before the actual output. */
function backgroundResult(
	rec: Record<string, unknown>,
	id: string,
): TranscriptEvent {
	const raw = contentText(rec.content)
		.trim()
		.replace(/^<system-notice>\s*|\s*<\/system-notice>$/g, "");
	const firstLine = raw.split("\n", 1)[0] ?? "";
	const header =
		/^Background job ([\w.-]+)(?: \([^\n]*\))? (?:has )?(completed|failed|cancelled)\.[ \t]*$/im.exec(
			firstLine,
		);
	const batch = /^\d+ background jobs have completed\.[^\n]*/i.test(raw);
	const jobs = obj(rec.details)?.jobs;
	const job = Array.isArray(jobs) && jobs.length === 1 ? obj(jobs[0]) : null;
	const jobId = str(job?.jobId) ?? header?.[1];
	const status = str(job?.status) ?? header?.[2];
	const outcome =
		status === "failed"
			? "failed"
			: status === "cancelled" || status === "canceled"
				? "cancelled"
				: status === "completed"
					? "completed"
					: "finished";
	const count = Array.isArray(jobs) && jobs.length > 1 ? jobs.length : null;
	const summary = count
		? `${count} background jobs finished`
		: batch
			? "Background jobs finished"
			: `Background job${jobId && /^[\w.-]{1,80}$/.test(jobId) ? ` ${jobId}` : ""} ${outcome}`;
	const body = (header || batch ? raw.slice(firstLine.length).trimStart() : raw)
		.replace(/^Resume your work using the result below\.\s*/, "")
		.trim();
	return backgroundJob({ id, ts: toMs(rec.timestamp) }, summary, outcome, body);
}

/**
 * pi / omp session lines. Events come from `message` records (user,
 * assistant, toolResult, system) and pulsar's own `custom_message`s; omp's
 * line-1 `title` record and every other type are skipped.
 */
export function parsePi(chunk: string, state: ParseState): TranscriptEvent[] {
	const out: TranscriptEvent[] = [];
	for (const rec of jsonLines(chunk)) {
		const id = str(rec.id);
		if (!id) continue;
		if (rec.type === "compaction") {
			out.push({
				id,
				ts: toMs(rec.timestamp),
				role: "system",
				kind: "system",
				subtype: "compacted",
				text: str(rec.shortSummary)?.trim() || "Conversation compacted",
			});
			continue;
		}
		if (rec.type === "custom_message" && rec.customType === "irc:incoming") {
			// omp: a message from another agent.
			const details = obj(rec.details);
			const from = str(details?.from);
			const text = str(details?.message) ?? stripTags(contentText(rec.content));
			if (text.trim())
				out.push({
					id,
					ts: toMs(rec.timestamp),
					role: "peer",
					kind: "peer",
					text,
					...(from ? { from } : {}),
				});
			continue;
		}
		if (rec.type === "custom_message" && rec.customType === "async-result") {
			out.push(backgroundResult(rec, id));
			continue;
		}
		if (rec.type === "custom_message") {
			if (rec.customType !== "pulsar") continue;
			const raw = contentText(rec.content);
			const push = parsePush(raw);
			const from = str(obj(rec.details)?.from);
			out.push(
				push
					? pushEvent({ id, ts: toMs(rec.timestamp) }, push)
					: {
							id,
							ts: toMs(rec.timestamp),
							role: "peer",
							kind: "peer",
							text: raw,
							...(from ? { from } : {}),
						},
			);
			continue;
		}
		if (rec.type !== "message") continue;
		const message = obj(rec.message);
		if (!message) continue;
		const ts = toMs(rec.timestamp, toMs(message.timestamp));
		switch (message.role) {
			case "user": {
				const text = contentText(message.content);
				if (!text.trim()) break;
				const event: TranscriptEvent = {
					id,
					ts,
					role: "user",
					kind: "text",
					text,
				};
				attachImages(
					state,
					event,
					contentImages(message.content, ["message", "content"]),
				);
				out.push(event);
				break;
			}
			case "system": {
				// The system prompt (with `sections`) is not conversation.
				const text = contentText(message.content);
				if (!message.sections && text.trim())
					out.push({ id, ts, role: "system", kind: "system", text });
				break;
			}
			case "toolResult": {
				const callId = str(message.toolCallId);
				if (!callId) break;
				xdResult(state, callId, message.details);
				const isError =
					typeof message.isError === "boolean" ? message.isError : undefined;
				const events = resultEvents(
					state,
					{ id, ts },
					callId,
					contentText(message.content),
					isError,
					str(message.toolName),
					ompDetail(str(message.toolName), message.details),
				);
				attachImages(
					state,
					events.at(-1),
					contentImages(message.content, ["message", "content"]),
				);
				out.push(...events);
				break;
			}
			case "assistant": {
				if (!Array.isArray(message.content)) break;
				const model = str(message.model);
				const withModel = model ? { model } : {};
				message.content.forEach((part, i) => {
					const p = obj(part);
					if (!p) return;
					const base = { id: `${id}#${i}`, ts, ...withModel };
					if (p.type === "text" && str(p.text)?.trim())
						out.push({
							...base,
							role: "assistant",
							kind: "text",
							text: p.text as string,
						});
					else if (p.type === "thinking" && str(p.thinking)?.trim())
						out.push({
							...base,
							role: "assistant",
							kind: "thinking",
							text: p.thinking as string,
						});
					else if (p.type === "thinking")
						out.push({
							...base,
							role: "assistant",
							kind: "thinking",
							subtype: "hidden",
							text: "",
						});
					else if (p.type === "toolCall" && str(p.id) && str(p.name)) {
						// omp: `write xd://<device>` is a tool call, not a file write.
						const call = xdCall(state, p.name as string, p.arguments) ?? {
							name: p.name as string,
							input: p.arguments,
						};
						out.push(
							callEvent(state, base, call.name, p.id as string, call.input),
						);
					}
				});
				break;
			}
		}
	}
	return out;
}
