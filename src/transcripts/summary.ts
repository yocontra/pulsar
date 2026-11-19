import type { ParsedPush } from "../push-frame.ts";
import {
	callLine,
	describeCall,
	patchFiles,
	resultFacts,
	shellCommand,
	shortPath,
	toolKind,
} from "./describe.ts";
import {
	DETAIL_LINKS,
	DOCUMENT_MAX_BYTES,
	IMAGE_TYPES,
	type ImageSource,
	type ImageType,
	type ParseState,
	TOOL_OUTPUT_CAP,
	type ToolDetail,
	type TranscriptEvent,
	type TranscriptPush,
} from "./types.ts";

/** Shared helpers for the harness transcript parsers. */

export { shortPath };

/** Each complete JSON line in `chunk`, parsed; malformed lines are skipped. */
export function jsonLines(chunk: string): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const line of chunk.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const value = JSON.parse(trimmed) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value))
				out.push(value as Record<string, unknown>);
		} catch {
			// A torn or foreign line: skip it.
		}
	}
	return out;
}

export function obj(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/** Milliseconds from an ISO string, epoch milliseconds, or epoch seconds; `fallback` otherwise. */
export function toMs(value: unknown, fallback = 0): number {
	if (typeof value === "number" && Number.isFinite(value))
		return value < 1e11 ? Math.round(value * 1000) : value;
	if (typeof value === "string") {
		const t = Date.parse(value);
		if (!Number.isNaN(t)) return t;
	}
	return fallback;
}

/**
 * Plain text of a content value: a string, or an array of parts with `text`
 * (`text`, `input_text`, `output_text`); images become `[image]`, Claude
 * `tool_reference` parts (ToolSearch results) their tool's name.
 */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		const p = obj(part);
		if (!p) continue;
		if (typeof p.text === "string") parts.push(p.text);
		else if (p.type === "image" || p.type === "input_image")
			parts.push("[image]");
		else if (p.type === "tool_reference" && typeof p.tool_name === "string")
			parts.push(p.tool_name);
	}
	return parts.join("\n");
}

/** Cuts tool output to `TOOL_OUTPUT_CAP` characters. */
function capOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= TOOL_OUTPUT_CAP) return { text, truncated: false };
	return { text: text.slice(0, TOOL_OUTPUT_CAP), truncated: true };
}

/** Harness markup (`<task-notification>`, `<summary>`, …) reduced to its text. */
export function stripTags(text: string): string {
	return text.replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, "");
}

/**
 * A message Pulsar pushed (see `parsePush`) as a transcript event: the
 * operator's own turn (body only), or a peer message from an agent or the
 * unverified app. Callers pass only text that arrived as a push.
 */
export function pushEvent(
	base: { id: string; ts: number; sidechain?: string },
	p: ParsedPush,
): TranscriptEvent {
	const pulsar: TranscriptPush = {
		sender: p.sender,
		...(p.messageId ? { messageId: p.messageId } : {}),
		...(p.machine ? { machine: p.machine } : {}),
		...(p.attempt ? { attempt: p.attempt } : {}),
	};
	return p.sender === "operator"
		? {
				...base,
				role: "user",
				kind: "text",
				text: p.body,
				from: p.from,
				pulsar,
			}
		: {
				...base,
				role: "peer",
				kind: "peer",
				text: p.body,
				from: p.from,
				pulsar,
			};
}

function oneLine(text: string, max = 80): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lineCount(text: unknown): number {
	if (typeof text !== "string" || text === "") return 0;
	return text.replace(/\n$/, "").split("\n").length;
}

const SHELL = new Set(["bash", "shell", "exec_command", "local_shell"]);

/** Parses a JSON string argument (Codex `arguments`); anything else as is. */
export function parseArgs(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return value;
	}
}

/** The one-line summary of a tool call, before its result is known. */
export function summarizeCall(
	name: string,
	input: unknown,
	cwd: string | null,
): string {
	const lower = name.toLowerCase();
	const args = obj(input) ?? {};
	const path = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
	const p = path ? shortPath(path, cwd) : "";
	if ((lower === "edit" || lower === "multiedit") && p) {
		const edits = Array.isArray(args.edits) ? args.edits : [args];
		let added = 0;
		let removed = 0;
		for (const e of edits) {
			const edit = obj(e) ?? {};
			added += lineCount(edit.new_string ?? edit.newText);
			removed += lineCount(edit.old_string ?? edit.oldText);
		}
		return `Edited ${p} +${added} −${removed}`;
	}
	if (lower === "write" && p) {
		const n = lineCount(args.content);
		return `Wrote ${p} (${n} ${n === 1 ? "line" : "lines"})`;
	}
	if (SHELL.has(lower)) {
		const text = shellCommand(input);
		if (text) return `Ran \`${oneLine(text)}\``;
	}
	if (lower === "apply_patch") {
		const patch = typeof input === "string" ? input : (str(args.input) ?? "");
		const files = patchFiles(patch);
		const added = files.reduce((n, f) => n + f.added, 0);
		const removed = files.reduce((n, f) => n + f.removed, 0);
		if (files.length > 1)
			return `Patched ${files.length} files +${added} −${removed}`;
		const one = files[0] ? shortPath(files[0].path, cwd) : "files";
		return `Edited ${one} +${added} −${removed}`;
	}
	if (lower === "grep" || lower === "glob") {
		const pattern = str(args.pattern);
		if (pattern) return `Searched ${oneLine(pattern, 60)}`;
	}
	if (lower === "agent" || lower === "task") {
		const what = str(args.description) ?? str(args.name);
		if (what) return `Subagent: ${oneLine(what, 60)}`;
	}
	if (lower === "webfetch" || lower === "web_fetch") {
		const url = str(args.url);
		if (url) return `Fetched ${oneLine(url, 80)}`;
	}
	return callLine(describeCall(name, input, { cwd }));
}

/** The exit code a shell tool printed, if any. */
function exitCode(output: string): number | null {
	const m =
		/(?:exit code|exited with code|Exit code:?)\s*(-?\d+)/i.exec(output) ??
		/"exit_code"\s*:\s*(-?\d+)/.exec(output);
	return m ? Number(m[1]) : null;
}

/** A call's summary with its result folded in ("Ran `x` · exit 0"). */
function summarizeResult(
	name: string,
	callSummary: string,
	output: string,
	isError: boolean | undefined,
	detail?: ToolDetail,
): string {
	if (detail?.denied || detail?.interrupted || detail?.timedOutMs)
		return [callSummary, ...resultFacts(toolKind(name), detail, isError)].join(
			" · ",
		);
	if (SHELL.has(name.toLowerCase())) {
		const code = exitCode(output);
		if (code !== null) return `${callSummary} · exit ${code}`;
		if (isError === true) return `${callSummary} · failed`;
		if (isError === false) return `${callSummary} · exit 0`;
		return callSummary;
	}
	if (isError) return `${callSummary} · error`;
	const facts = resultFacts(toolKind(name), detail, isError);
	return facts.length ? [callSummary, ...facts].join(" · ") : callSummary;
}

const DENIED =
	/^(?:<tool_use_error>)?\s*(?:The user doesn't want to proceed with this tool use|Permission to use \S+ (?:has been|was) denied|The user (?:rejected|denied) |Tool use (?:was )?(?:rejected|denied))/i;
const INTERRUPTED = /^\[Request interrupted by user|^Interrupted by user/i;
const TIMED_OUT = /^Command timed out after (\d+(?:\.\d+)?)\s*(ms|s|m|min)\b/i;
const BACKGROUND = /^(?:Command )?running in background with ID:\s*(\S+)/i;

function cut(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Web search links from Claude's `Links: [{title, url}, …]` result text. */
function webLinks(output: string): ToolDetail["links"] {
	const m = /Links:\s*(\[[\s\S]*?\])\s*(?:\n|$)/.exec(output);
	if (!m) return undefined;
	try {
		const list = JSON.parse(m[1]!) as unknown;
		if (!Array.isArray(list)) return undefined;
		return links(list);
	} catch {
		return undefined;
	}
}

/** Bounded `{title, url}` pairs from any list of link-shaped objects. */
export function links(list: unknown[]): ToolDetail["links"] {
	const out: NonNullable<ToolDetail["links"]> = [];
	for (const item of list) {
		const o = obj(item);
		const url = str(o?.url);
		if (!url || !/^https?:\/\//i.test(url)) continue;
		out.push({
			title: cut((str(o?.title) ?? url).replace(/^#+\s*/, ""), 120),
			url: cut(url, 300),
		});
		if (out.length >= DETAIL_LINKS) break;
	}
	return out;
}

/** `"Which approach?"="The lock"` pairs from an AskUserQuestion result. */
function answerPairs(output: string): ToolDetail["answers"] {
	const out: NonNullable<ToolDetail["answers"]> = [];
	for (const m of output.matchAll(/"([^"]{1,400})"="([^"]{0,400})"/g)) {
		out.push({ question: cut(m[1]!, 200), answer: cut(m[2]!, 200) });
		if (out.length >= 5) break;
	}
	return out.length ? out : undefined;
}

const nonEmpty = (text: string) =>
	text.split("\n").filter((l) => l.trim()).length;

/**
 * Bounded facts about a tool result, from the whole output (before the cap)
 * and whatever the harness recorded (`extra`); undefined when there are none.
 */
export function toolDetail(
	name: string,
	output: string,
	isError: boolean | undefined,
	extra: ToolDetail = {},
): ToolDetail | undefined {
	const kind = toolKind(name);
	const d: ToolDetail = {};
	const head = output.slice(0, 600);
	if (DENIED.test(head)) d.denied = true;
	else if (INTERRUPTED.test(head.trim())) d.interrupted = true;
	// Timeouts and background runs are shell facts, at the start of the output.
	const timeout = kind === "shell" ? TIMED_OUT.exec(head.trimStart()) : null;
	if (timeout) {
		const n = Number(timeout[1]);
		const unit = timeout[2]!.toLowerCase();
		let ms = n * 60_000;
		if (unit === "ms") ms = n;
		else if (unit === "s") ms = n * 1000;
		d.timedOutMs = Math.round(ms);
	}
	const bg = kind === "shell" ? BACKGROUND.exec(head.trimStart()) : null;
	if (bg) d.background = cut(bg[1]!, 80);
	if (kind === "shell") {
		// Harnesses put the exit code on the first or last line; a line in the
		// middle is the command's own output.
		const rows = output.trim().split("\n");
		const edges =
			rows.length > 1 ? `${rows[0]}\n${rows.at(-1)}` : (rows[0] ?? "");
		const code = exitCode(edges);
		if (code !== null) d.exitCode = code;
		d.lines = nonEmpty(output);
	} else if (!isError) {
		if (kind === "read")
			d.lines = output
				.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
				.replace(/\n$/, "")
				.split("\n").length;
		else if (kind === "search" || kind === "list") {
			const found = /^Found (\d+) (?:files?|matches|match)/i.exec(output);
			if (found) d.count = Number(found[1]);
			else if (
				/^No (?:matches|files|results) found/i.test(output.trim()) ||
				!output.trim()
			)
				d.count = 0;
			else d.count = nonEmpty(output);
		} else if (kind === "websearch") {
			const l = webLinks(output);
			if (l) d.links = l;
		} else if (kind === "question") {
			const a = answerPairs(output);
			if (a) d.answers = a;
		} else if (kind === "tools") d.lines = nonEmpty(output);
	}
	for (const [k, v] of Object.entries(extra))
		if (v !== undefined) (d as Record<string, unknown>)[k] = v;
	return Object.keys(d).length ? d : undefined;
}

/** Unanswered tool calls a parse state remembers; the oldest go first. */
export const MAX_PENDING_CALLS = 256;

/** A tool_call event, remembered in `state` until its result arrives. */
export function callEvent(
	state: ParseState,
	base: Omit<TranscriptEvent, "kind" | "role" | "text" | "tool">,
	name: string,
	callId: string,
	input: unknown,
): TranscriptEvent {
	const event: TranscriptEvent = {
		...base,
		role: "assistant",
		kind: "tool_call",
		text: "",
		tool: {
			name,
			callId,
			input,
			summary: summarizeCall(name, input, state.cwd),
		},
	};
	state.calls.set(callId, { name, input, event });
	// Calls that never get a result (an interrupted turn) would otherwise keep
	// their input (a whole file being written) for as long as the tailer lives.
	if (state.calls.size > MAX_PENDING_CALLS) {
		const oldest = state.calls.keys().next().value;
		if (oldest !== undefined) state.calls.delete(oldest);
	}
	return event;
}

/**
 * The events for a tool result: the result itself (output capped) and, when
 * its call is in this state, the call again with the result in its summary
 * (same id, so it replaces the call in place).
 */
export function resultEvents(
	state: ParseState,
	base: Omit<TranscriptEvent, "kind" | "role" | "text" | "tool">,
	callId: string,
	output: string,
	isError: boolean | undefined,
	fallbackName?: string,
	extra?: ToolDetail,
): TranscriptEvent[] {
	const pending = state.calls.get(callId);
	state.calls.delete(callId);
	const name = pending?.name ?? fallbackName ?? "tool";
	const capped = capOutput(output);
	const detail = toolDetail(name, output, isError, extra);
	const summary = pending
		? summarizeResult(
				name,
				pending.event.tool?.summary ?? name,
				output,
				isError,
				detail,
			)
		: undefined;
	const result: TranscriptEvent = {
		...base,
		role: "tool",
		kind: "tool_result",
		text: capped.text,
		tool: {
			name,
			callId,
			...(isError !== undefined ? { isError } : {}),
			...(summary ? { summary } : {}),
			...(capped.truncated ? { truncated: true } : {}),
			...(detail ? { detail } : {}),
		},
	};
	if (!pending?.event.tool) return [result];
	const call: TranscriptEvent = {
		...pending.event,
		tool: {
			...pending.event.tool,
			...(summary ? { summary } : {}),
			...(isError !== undefined ? { isError } : {}),
			...(detail ? { detail } : {}),
			done: true,
		},
	};
	return [call, result];
}

/** An allowed image type for a declared one (`image/jpg` counts as JPEG); null otherwise. */
function imageType(value: unknown): ImageType | null {
	if (typeof value !== "string") return null;
	const t = value.trim().toLowerCase();
	const type = t === "image/jpg" ? "image/jpeg" : t;
	return (IMAGE_TYPES as readonly string[]).includes(type)
		? (type as ImageType)
		: null;
}

/** Decoded size of base64 text starting at `from`, without decoding it. */
export function base64Bytes(text: string, from = 0): number {
	let end = text.length;
	while (end > from && /[=\s]/.test(text[end - 1]!)) end--;
	return Math.floor(((end - from) * 3) / 4);
}

/** `data:image/png;base64,` → its type and where the payload starts; null for anything else. */
export function dataUrl(
	value: string,
): { mediaType: ImageType; start: number } | null {
	if (!value.startsWith("data:")) return null;
	const comma = value.indexOf(",");
	if (comma < 0 || comma > 200) return null;
	const header = value.slice(5, comma).split(";");
	if (!header.slice(1).includes("base64")) return null;
	const mediaType = imageType(header[0]);
	return mediaType ? { mediaType, start: comma + 1 } : null;
}

const BLOB_REF = /^blob:sha256:([0-9a-f]{64})$/;

/** The sha256 of an omp blob reference (`blob:sha256:<hex>`), else null. */
export function blobHash(value: unknown): string | null {
	return typeof value === "string" ? (BLOB_REF.exec(value)?.[1] ?? null) : null;
}

export interface FoundImage {
	source: ImageSource;
	bytes?: number;
}

/**
 * The image in one content part, if it is an inline image of an allowed
 * type: Claude `{type:"image", source:{type:"base64", media_type, data}}`,
 * Codex `{type:"input_image", image_url:"data:…"}`, pi/omp
 * `{type:"image", mimeType, data}` (base64 or an omp `blob:sha256:` ref).
 * Remote URLs are dropped.
 */
export function partImage(
	part: unknown,
	at: Array<string | number>,
): FoundImage | null {
	const p = obj(part);
	if (!p) return null;
	if (p.type === "image") {
		const source = obj(p.source);
		if (source) {
			if (source.type !== "base64" || typeof source.data !== "string")
				return null;
			const mediaType = imageType(source.media_type);
			return mediaType
				? {
						source: {
							mediaType,
							at: [...at, "source", "data"],
							encoding: "base64",
						},
						bytes: base64Bytes(source.data),
					}
				: null;
		}
		const mediaType = imageType(p.mimeType ?? p.mediaType);
		if (!mediaType || typeof p.data !== "string") return null;
		if (blobHash(p.data))
			return { source: { mediaType, at: [...at, "data"], encoding: "blob" } };
		if (p.data.startsWith("blob:")) return null;
		return {
			source: { mediaType, at: [...at, "data"], encoding: "base64" },
			bytes: base64Bytes(p.data),
		};
	}
	if (p.type === "input_image" || p.type === "image_url") {
		const raw = p.image_url;
		const url = typeof raw === "string" ? raw : str(obj(raw)?.url);
		const key = typeof raw === "string" ? ["image_url"] : ["image_url", "url"];
		const parsed = url ? dataUrl(url) : null;
		if (!url || !parsed) return null;
		return {
			source: {
				mediaType: parsed.mediaType,
				at: [...at, ...key],
				encoding: "data-url",
			},
			bytes: base64Bytes(url, parsed.start),
		};
	}
	return null;
}

/** Pages a PDF states with plain `/Type /Page` objects; undefined when hidden (object streams). */
function pdfPages(base64: string): number | undefined {
	if (base64Bytes(base64) > DOCUMENT_MAX_BYTES) return undefined;
	const text = Buffer.from(base64, "base64").toString("latin1");
	if (!text.startsWith("%PDF-")) return undefined;
	const n = text.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0;
	return n > 0 ? n : undefined;
}

export interface FoundDocument extends FoundImage {
	pages?: number;
}

/** A PDF in one content part: Claude `{type:"document", source:{type:"base64", media_type:"application/pdf", data}}`. */
export function partDocument(
	part: unknown,
	at: Array<string | number>,
): FoundDocument | null {
	const p = obj(part);
	const source = obj(p?.source);
	if (p?.type !== "document" || !source) return null;
	if (source.type !== "base64" || typeof source.data !== "string") return null;
	if (str(source.media_type)?.toLowerCase() !== "application/pdf") return null;
	const pages = pdfPages(source.data);
	return {
		source: {
			mediaType: "application/pdf",
			at: [...at, "source", "data"],
			encoding: "base64",
		},
		bytes: base64Bytes(source.data),
		...(pages ? { pages } : {}),
	};
}

/** PDFs in a content array at `at`, in order. */
export function contentDocuments(
	content: unknown,
	at: Array<string | number>,
): FoundDocument[] {
	if (!Array.isArray(content)) return [];
	const out: FoundDocument[] = [];
	content.forEach((part, i) => {
		const found = partDocument(part, [...at, i]);
		if (found) out.push(found);
	});
	return out;
}

/**
 * Gives `event` its documents (`<eventId>#doc<n>`) and records where each
 * one sits in `state.images` (the tailer serves both). `name` labels them.
 */
export function attachDocuments(
	state: ParseState,
	event: TranscriptEvent | undefined,
	found: FoundDocument[],
	name?: string,
): void {
	if (!event || found.length === 0) return;
	event.documents = found.map((f, n) => {
		const id = `${event.id}#doc${n}`;
		state.images.set(id, f.source);
		return {
			id,
			mediaType: "application/pdf",
			url: "",
			...(name ? { name: name.slice(0, 200) } : {}),
			...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
			...(f.pages ? { pages: f.pages } : {}),
		};
	});
}

/** Inline images in a content array at `at`, in order. */
export function contentImages(
	content: unknown,
	at: Array<string | number>,
): FoundImage[] {
	if (!Array.isArray(content)) return [];
	const out: FoundImage[] = [];
	content.forEach((part, i) => {
		const found = partImage(part, [...at, i]);
		if (found) out.push(found);
	});
	return out;
}

/**
 * Gives `event` its images (`<eventId>#img<n>`) and records where each one
 * sits in `state.images`. The tailer fills in each `url`.
 */
export function attachImages(
	state: ParseState,
	event: TranscriptEvent | undefined,
	found: FoundImage[],
): void {
	if (!event || found.length === 0) return;
	event.images = found.map((f, n) => {
		const id = `${event.id}#img${n}`;
		state.images.set(id, f.source);
		return {
			id,
			// partImage only finds image types.
			mediaType: f.source.mediaType as ImageType,
			url: "",
			...(f.bytes !== undefined ? { bytes: f.bytes } : {}),
		};
	});
}
