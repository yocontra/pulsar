/**
 * The normalized live-transcript model every harness driver parses into.
 * One `TranscriptEvent` per block a person would see: a user prompt, a piece
 * of assistant text or thinking, a tool call, a tool result, a peer message.
 */

export type TranscriptRole = "user" | "assistant" | "tool" | "system" | "peer";

export type TranscriptKind =
	| "text"
	| "thinking"
	| "tool_call"
	| "tool_result"
	| "peer"
	| "system";

export interface TranscriptTool {
	/** The harness's tool name, e.g. `Bash`, `exec_command`, `edit`. */
	name: string;
	/** Pairs a call with its result. */
	callId: string;
	/** The call's arguments (tool_call events only). */
	input?: unknown;
	isError?: boolean;
	/** One line for people: "Edited src/x.ts +12 −3", "Ran `bun test` · exit 0". */
	summary?: string;
	/** The event's `text` was cut at `TOOL_OUTPUT_CAP`. */
	truncated?: boolean;
	/** On a call re-sent with its result folded in: the call has finished. */
	done?: boolean;
	/**
	 * The folder the harness recorded for this call (Claude's per-line
	 * `cwd`), when it differs from the agent's own folder (calls only).
	 */
	cwd?: string;
	/**
	 * Facts about the result, read from the whole output before the cap (or
	 * from the harness's structured result): results only, always bounded.
	 */
	detail?: ToolDetail;
}

/** Most links a `ToolDetail` keeps. */
export const DETAIL_LINKS = 10;

/** Bounded facts about a tool result (see `TranscriptTool.detail`). */
export interface ToolDetail {
	/** A shell command's exit code. */
	exitCode?: number;
	/** The person or the harness stopped the tool before it finished. */
	interrupted?: boolean;
	/** The person or a permission rule refused the call. */
	denied?: boolean;
	/** The command went on in the background under this id. */
	background?: string;
	/** The command was killed after this many milliseconds. */
	timedOutMs?: number;
	/** Lines in the whole output (reads, shell output). */
	lines?: number;
	/** Matches or files a search found. */
	count?: number;
	/** Web search results, at most `DETAIL_LINKS`, titles and URLs cut short. */
	links?: Array<{ title: string; url: string }>;
	/** Answers to the questions an agent asked, by question (cut short). */
	answers?: Array<{ question: string; answer: string }>;
}

/**
 * What a non-plain event is, when the UI draws it differently:
 * - `interrupted`: the person stopped the turn (system).
 * - `compacted`: the harness summarized earlier context (system).
 * - `task`: a background task or subagent finished (system).
 * - `command`: a slash command the person ran (user; text is `/name args`).
 * - `shell`: a shell command the person ran in the harness (user; text is
 *   the command) or its output (system).
 * - `hidden`: reasoning the model keeps private (thinking; text is empty).
 */
export type TranscriptSubtype =
	| "interrupted"
	| "compacted"
	| "task"
	| "command"
	| "shell"
	| "hidden";

/** Image types a transcript image may have; anything else (SVG above all) is dropped. */
export const IMAGE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
] as const;

export type ImageType = (typeof IMAGE_TYPES)[number];

/** Largest image the daemon serves, decoded. */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Document types a transcript may carry (served, never executed). */
export type DocumentType = "application/pdf";

/** Largest document the daemon serves, decoded. */
export const DOCUMENT_MAX_BYTES = 32 * 1024 * 1024;

/** What a transcript media source can be: an image or a document. */
export type MediaType = ImageType | DocumentType;

/**
 * A document in an event (a PDF an agent read, one pasted in). Like an
 * image, the event holds no bytes: `url` fetches them (same endpoint and
 * auth as images; served as `application/pdf`, inline, nosniff).
 */
export interface TranscriptDocument {
	/** `<eventId>#doc<n>`, stable from the source. */
	id: string;
	mediaType: DocumentType;
	/** API path of the bytes, already URI-encoded; use it as is. */
	url: string;
	/** File name, when the source says (a Read's path). */
	name?: string;
	/** Decoded size. */
	bytes?: number;
	/** Pages, when the PDF states them plainly. */
	pages?: number;
}

/**
 * An image in an event. The event never holds image data: `url` fetches it
 * from the daemon (same auth as the transcript; send `X-Pulsar: 1`). Images
 * that are only a remote URL in the source are dropped, never fetched.
 */
export interface TranscriptImage {
	/** `<eventId>#img<n>`, stable from the source. */
	id: string;
	mediaType: ImageType;
	/** API path of the bytes, already URI-encoded; use it as is. */
	url: string;
	/** Decoded size, when the source says (not for omp blob references). */
	bytes?: number;
}

/**
 * Where a parsed image's data sits inside its source record: a JSON path from
 * the record's root (`"<json>"` steps into a JSON-encoded string) and how the
 * value at that path is encoded. Parser-internal, never sent to clients.
 */
export interface ImageSource {
	mediaType: MediaType;
	at: Array<string | number>;
	encoding: "base64" | "data-url" | "blob";
}

export interface TranscriptEvent {
	/**
	 * Stable id from the source (`<recordId>#<blockIndex>` when one record has
	 * several blocks). A live event with an id already shown replaces it in
	 * place: a streamed block that grew, or a tool call whose summary gained its
	 * result. History pages are older than what a client holds: merge a page by
	 * adding ids the client lacks, never by overwriting one it already has (an
	 * earlier page can hold the bare call whose result a newer page folded in).
	 */
	id: string;
	/** Milliseconds since the epoch. */
	ts: number;
	role: TranscriptRole;
	kind: TranscriptKind;
	text: string;
	tool?: TranscriptTool;
	model?: string;
	/**
	 * Who sent a peer message (its name as the sender gave it), or the
	 * operator's name on a message they sent through Pulsar.
	 */
	from?: string;
	/**
	 * Set on a message Pulsar pushed, read from its frame. `operator`: the
	 * human operator proven with a passkey (role `user`, `text` is the body
	 * only); `app`: an unverified send from the Pulsar app; `agent`: another
	 * agent or the terminal (both role `peer`).
	 */
	pulsar?: TranscriptPush;
	/** Set on events from a subagent: the subagent's id. */
	sidechain?: string;
	/** Images in this block (a pasted image, a screenshot a tool returned). */
	images?: TranscriptImage[];
	/** Documents in this block (a PDF a tool read or the operator pasted). */
	documents?: TranscriptDocument[];
	/** What this event is when it is not plain text (see `TranscriptSubtype`). */
	subtype?: TranscriptSubtype;
	/**
	 * A Claude Code agent-team message or background-task notice, parsed from
	 * its markup (see `TranscriptNotice`). `text` then holds only the readable
	 * Markdown body (a teammate's result, a task's result, a plain message).
	 */
	notice?: TranscriptNotice;
}

/** Where a pushed message came from, as its Pulsar frame says. */
export interface TranscriptPush {
	sender: "operator" | "app" | "agent";
	/** The Pulsar message id (for `respond`, copy, receipts). */
	messageId?: string;
	/** The machine an operator or app send came from. */
	machine?: string;
	/** Set on a redelivery: which attempt this was. */
	attempt?: number;
}

/** Teammate colors Claude Code assigns; anything else is dropped. */
export const NOTICE_COLORS = [
	"red",
	"blue",
	"green",
	"yellow",
	"purple",
	"orange",
	"pink",
	"cyan",
] as const;

export type NoticeColor = (typeof NOTICE_COLORS)[number];

/**
 * What a team or task notice is. Every field is bounded and taken as data:
 * - `type`: the protocol type (`idle_notification`, `shutdown_request`, …),
 *   `message` for a teammate's plain text, `task_notification` for a
 *   background task that finished with a result. Lowercase `[a-z_]`, ≤ 40.
 * - `color`: the sender's teammate color, one of `NOTICE_COLORS`.
 * - `summary`: a one-line title, ≤ 200 characters.
 * - `status`: what happened, when the notice says: an idle reason
 *   (`available`, `failed`), a task status (`completed`, `failed`), or
 *   `approved` / `rejected` on a response. Lowercase `[a-z_]`, ≤ 40.
 */
export interface TranscriptNotice {
	type: string;
	color?: NoticeColor;
	summary?: string;
	status?: string;
}

/** Longest notice body kept in an event's text; longer bodies are cut. */
export const NOTICE_TEXT_CAP = 16_384;

/** Tool output kept in an event's text; longer output is cut and marked `truncated`. */
export const TOOL_OUTPUT_CAP = 4096;

/** A tool call seen in this source and not yet answered. */
export interface PendingCall {
	name: string;
	input: unknown;
	/** The call event, re-emitted with the result folded into its summary. */
	event: TranscriptEvent;
}

/**
 * Per-source parser state. The tailer creates it with `newParseState` and
 * knows nothing about its contents beyond `atStart`.
 *
 * Parsers must give the same events for a line wherever a chunk starts:
 * history pages parse mid-file chunks with fresh state, and the live tail
 * starts at the end of the file. State may only add detail (a result's tool
 * name and summary), never decide whether an event exists, except for
 * `atStart` rules that hold only from the first line of the source.
 */
export interface ParseState {
	/**
	 * True when this state has parsed the source from its first line, so "the
	 * first X" rules (Codex's "skip the first user message") can be trusted.
	 * False for a state that started mid-file (history pages, the live tail).
	 */
	atStart: boolean;
	/** The agent's folder, so summaries can show paths relative to it. */
	cwd: string | null;
	/** Unanswered tool calls by call id. */
	calls: Map<string, PendingCall>;
	/** Driver scratch space, e.g. Codex's "first user message seen". */
	flags: Record<string, unknown>;
	/**
	 * Images found since the tailer last drained this map, by image id. The
	 * tailer indexes them by line so the daemon can serve the bytes later.
	 */
	images: Map<string, ImageSource>;
}

export function newParseState(
	opts: { atStart?: boolean; cwd?: string | null } = {},
): ParseState {
	return {
		atStart: opts.atStart ?? false,
		cwd: opts.cwd ?? null,
		calls: new Map(),
		flags: {},
		images: new Map(),
	};
}

/** One page of transcript events, oldest first. */
export interface TranscriptPage {
	events: TranscriptEvent[];
	/**
	 * Opaque cursor for the page before this one ("load earlier"); null when
	 * this page reaches the start of the transcript.
	 */
	cursor: string | null;
}

/**
 * Where a session's transcript lives.
 *
 * - `file`: an append-only JSONL log, tailed by byte offset. `headerLine`
 *   marks a first line the harness rewrites in place (omp's padded title);
 *   the tailer never reads it. `guess` marks a file picked without a
 *   session id.
 * - `poll`: a harness API. `fetch(null)` returns the newest page; a page's
 *   `cursor` fetches the one before it. The live tail polls `fetch(null)` and
 *   emits events that are new or changed (parts that change in place).
 */
export type TranscriptSource =
	| {
			kind: "file";
			path: string;
			headerLine?: boolean;
			/**
			 * A guess (the newest file in a folder, no session id): a live
			 * watcher never moves to a guessed file while its own file exists.
			 */
			guess?: boolean;
	  }
	| {
			kind: "poll";
			intervalMs?: number;
			fetch(cursor: string | null): Promise<TranscriptPage>;
	  };

/** What a harness driver adds to support live transcripts. */
export interface TranscriptSupport<A> {
	/** The session's transcript, or null when it has none (yet). */
	locate(agent: A): TranscriptSource | null | Promise<TranscriptSource | null>;
	/**
	 * `locate` needs the harness's session id: an agent with none (a Codex
	 * app-server before it learns its thread) has no transcript to find yet.
	 */
	needsSession?: boolean;
	/**
	 * Events in `chunk`: one or more complete JSONL lines from a file source.
	 * Unknown or malformed lines are skipped.
	 */
	parse(chunk: string, state: ParseState): TranscriptEvent[];
	/**
	 * Whether the last turn ended with a harness error (API error, refused
	 * model), from the log's last bytes (src/transcripts/turn-outcome.ts).
	 */
	turnFailed?(tail: string): boolean;
}
