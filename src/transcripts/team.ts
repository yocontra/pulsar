import {
	NOTICE_COLORS,
	NOTICE_TEXT_CAP,
	type NoticeColor,
	type TranscriptNotice,
} from "./types.ts";

/**
 * Claude Code agent-team messages: `<teammate-message teammate_id="…"
 * color="…" summary="…">body</teammate-message>`, one or more per record,
 * either bare (in a teammate's own log) or after `Another Claude session sent
 * a message:`. The body is plain text or a protocol object such as
 * `{"type":"idle_notification","from":…,"result":…}`. Everything here is data:
 * parsed with JSON.parse, bounded, and shown through the chat's sanitized
 * Markdown, never executed.
 */
export interface TeamMessage {
	from?: string;
	/** The readable body: Markdown, at most `NOTICE_TEXT_CAP` characters. */
	text: string;
	notice: TranscriptNotice;
}

const TEAMMATE =
	/<teammate-message((?:\s+[\w-]+="[^"]*")*)\s*>\n?([\s\S]*?)\n?<\/teammate-message>/g;

/** Every teammate message in `text`, in order; null when there is none. */
export function teammateMessages(text: string): TeamMessage[] | null {
	if (!text.includes("<teammate-message")) return null;
	const out: TeamMessage[] = [];
	for (const m of text.matchAll(TEAMMATE)) {
		const attrs: Record<string, string> = {};
		for (const a of (m[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g))
			attrs[a[1]!] = a[2]!;
		out.push(teammateMessage(attrs, m[2] ?? ""));
	}
	return out.length ? out : null;
}

/** One message from its tag attributes and body. */
function teammateMessage(
	attrs: Record<string, string>,
	body: string,
): TeamMessage {
	const color = noticeColor(attrs.color);
	const tagFrom = name(attrs.teammate_id ?? attrs["from-name"] ?? attrs.from);
	const tagSummary = line(attrs.summary);
	const json = protocolObject(body);
	if (!json) {
		const notice: TranscriptNotice = { type: "message" };
		if (color) notice.color = color;
		if (tagSummary) notice.summary = tagSummary;
		return { ...(tagFrom ? { from: tagFrom } : {}), text: cap(body), notice };
	}
	const type = token(json.type) as string;
	const notice: TranscriptNotice = { type };
	if (color) notice.color = color;
	const summary = tagSummary ?? line(json.summary) ?? line(json.subject);
	if (summary) notice.summary = summary;
	const status = statusOf(type, json);
	if (status) notice.status = status;
	const from = name(json.from) ?? tagFrom;
	return { ...(from ? { from } : {}), text: bodyOf(json), notice };
}

/** A JSON object with a well-formed string `type`, else null (plain text). */
function protocolObject(body: string): Record<string, unknown> | null {
	const t = body.trim();
	if (!t.startsWith("{") || !t.endsWith("}")) return null;
	let value: unknown;
	try {
		value = JSON.parse(t);
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const json = value as Record<string, unknown>;
	return token(json.type) ? json : null;
}

/** Fields that hold a protocol message's readable text, in order. */
const BODY_FIELDS = [
	"result",
	"content",
	"message",
	"body",
	"text",
	"plan",
	"feedback",
	"reason",
	"failureReason",
	"description",
] as const;

function bodyOf(json: Record<string, unknown>): string {
	// A teammate that failed after reporting: its result, then why.
	const result = str(json.result);
	const failure = str(json.failureReason);
	if (result && failure && result.trim() !== failure.trim())
		return cap(`${result.trim()}\n\n**Failed:** ${failure.trim()}`);
	for (const k of BODY_FIELDS) {
		const v = json[k];
		if (typeof v === "string" && v.trim()) return cap(v);
	}
	// An idle notice with nothing to say is a quiet row; any other object
	// with no text field shows its fields as JSON.
	if (json.type === "idle_notification") return "";
	const rest = Object.fromEntries(
		Object.entries(json).filter(([k]) => k !== "type"),
	);
	if (!Object.keys(rest).length) return "";
	return `\`\`\`\`json\n${cap(JSON.stringify(rest, null, 2))}\n\`\`\`\``;
}

function statusOf(
	type: string,
	json: Record<string, unknown>,
): string | undefined {
	if (type === "idle_notification" && str(json.failureReason)) return "failed";
	const approve = json.approve ?? json.approved;
	if (typeof approve === "boolean") return approve ? "approved" : "rejected";
	return token(json.idleReason) ?? token(json.status);
}

/** A task notification (`<task-notification>`) that carries a `<result>`. */
export function taskNotice(
	markup: string,
): { text: string; notice: TranscriptNotice } | null {
	const result = tagText(markup, "result");
	if (!result?.trim()) return null;
	const notice: TranscriptNotice = { type: "task_notification" };
	const summary = line(tagText(markup, "summary"));
	if (summary) notice.summary = summary;
	const status = token(tagText(markup, "status")?.trim());
	if (status) notice.status = status;
	return { text: cap(result.trim()), notice };
}

const tagText = (text: string, tag: string) =>
	new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)?.[1];

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

/** `[a-z][a-z0-9_]*`, at most 40 characters, else undefined. */
function token(v: unknown): string | undefined {
	if (typeof v !== "string") return undefined;
	const t = v.trim().toLowerCase();
	return /^[a-z][a-z0-9_]{0,39}$/.test(t) ? t : undefined;
}

function noticeColor(v: string | undefined): NoticeColor | undefined {
	return NOTICE_COLORS.find((c) => c === v);
}

/** One line, at most `max` characters. */
function line(v: unknown, max = 200): string | undefined {
	const s = str(v)?.replace(/\s+/g, " ").trim();
	if (!s) return undefined;
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const name = (v: unknown) => line(v, 80);

function cap(text: string): string {
	return text.length > NOTICE_TEXT_CAP
		? `${text.slice(0, NOTICE_TEXT_CAP)}\n\n…`
		: text;
}
