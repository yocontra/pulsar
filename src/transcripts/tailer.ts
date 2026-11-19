import { type FSWatcher, type Stats, watch } from "node:fs";
import { open, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { debugLog } from "../log.ts";
import { base64Bytes, blobHash, dataUrl } from "./summary.ts";
import {
	DOCUMENT_MAX_BYTES,
	IMAGE_MAX_BYTES,
	type ImageSource,
	type ImageType,
	type MediaType,
	newParseState,
	type ParseState,
	type TranscriptEvent,
	type TranscriptPage,
	type TranscriptSource,
} from "./types.ts";

/**
 * The shared transcript tailer. Drivers say where a session's log is and how
 * to parse a chunk of it; this module does the rest:
 *
 * - `read(agentId, cursor?)` pages history backwards: newest page first, each
 *   page oldest-first, `cursor` loads the page before it, null at the start.
 * - `subscribe(agentId, fn)` streams live events. All subscribers to one
 *   agent share one watcher (ref-counted): a size poll every `pollMs` with
 *   `fs.watch` as a hint. Only complete lines are parsed; a file that shrinks
 *   or is replaced restarts from its first line.
 *
 * Ordering: subscribe first, then page. Events are keyed by `id`, so the
 * overlap between a page and the live stream only replaces events in place.
 *
 * Backpressure: each subscriber has a bounded queue. A listener that returns
 * a promise gets no more batches until it settles; events queue meanwhile.
 * When the queue passes `queueLimit` it is dropped and replaced by one gap
 * marker (`role: "system", kind: "system", text: "gap"`, unique `gap:` id),
 * and newer events follow it. A restarted (truncated or replaced) file also
 * sends a gap. A client that sees a gap should re-read the newest page.
 *
 * Images: parsers say where each image sits in its record; the tailer gives
 * each image its `url` and remembers the line it came from (a bounded index
 * keyed by agent and image id, filled as pages and live lines are parsed).
 * `image(agentId, imageId)` re-reads that line, re-parses it, and decodes the
 * bytes. An image id the index has not seen (or has evicted) is not found.
 */

export type ParseFn = (chunk: string, state: ParseState) => TranscriptEvent[];

/** A session's transcript as the tailer needs it. */
export interface ResolvedTranscript {
	source: TranscriptSource;
	parse: ParseFn;
	/** The agent's folder (relative paths in summaries). */
	cwd?: string | null;
	/** Whether the last turn failed (the driver's `turnFailed`). */
	turnFailed?: (tail: string) => boolean;
}

/** Finds an agent's transcript now; null when it has none (yet). Called again on every miss. */
export type TranscriptResolver = (
	agentId: string,
) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;

/**
 * Receives live events. Returning a promise holds later batches until it
 * settles; any other return value is ignored.
 */
export type TranscriptListener = (events: TranscriptEvent[]) => unknown;

/** Sees every live batch of every watcher (the search index); must not throw. */
export type TranscriptTap = (
	agentId: string,
	events: TranscriptEvent[],
) => void;

export interface TailerOptions {
	resolve: TranscriptResolver;
	/** Size poll interval for file sources (and the default for poll sources). */
	pollMs?: number;
	/** First read-back window for a history page; it doubles while the page is short. */
	pageBytes?: number;
	/** Largest read-back window for one page. */
	maxPageBytes?: number;
	/** Most events in one page (whole lines, so a page can stop short of it). */
	pageEvents?: number;
	/** Events a subscriber may have queued before they are replaced by a gap. */
	queueLimit?: number;
	/** Where clients fetch an image; already URI-encoded. */
	imageUrl?: (agentId: string, imageId: string) => string;
	/** Most image locations remembered across agents. */
	imageIndexLimit?: number;
}

/** An image read back from its source, or why it could not be. */
export type ImageResult =
	| { ok: true; mediaType: MediaType; data: Buffer }
	| { ok: false; reason: "not_found" | "too_large" | "unsupported" };

const DEFAULTS = {
	pollMs: 1000,
	pageBytes: 256 * 1024,
	maxPageBytes: 8 * 1024 * 1024,
	pageEvents: 200,
	queueLimit: 1000,
	imageUrl: (agentId: string, imageId: string) =>
		`/api/v1/agents/${encodeURIComponent(agentId)}/transcript/images/${encodeURIComponent(imageId)}`,
	imageIndexLimit: 50_000,
};

type Options = typeof DEFAULTS & { resolve: TranscriptResolver };

/** Largest line read back to serve an image (a line can hold several). */
const IMAGE_LINE_MAX = 64 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Most bytes one tick reads from a transcript: a file found late (or a burst
 * of output) is caught up over several ticks instead of in one buffer.
 */
export const MAX_READ = 4 * 1024 * 1024;

/** One line (an inline image) may be read up to this size; longer ones are skipped. */
export const MAX_LIVE_LINE = 64 * 1024 * 1024;

/** Bytes `start` to `end` of a file (fewer when it is shorter), read without blocking. */
async function readRange(
	path: string,
	start: number,
	end: number,
): Promise<Buffer> {
	const len = Math.max(0, end - start);
	const buf = Buffer.alloc(len);
	if (len === 0) return buf;
	const fh = await open(path, "r");
	try {
		let done = 0;
		while (done < len) {
			const { bytesRead } = await fh.read(buf, done, len - done, start + done);
			if (bytesRead <= 0) break;
			done += bytesRead;
		}
		return done === len ? buf : buf.subarray(0, done);
	} finally {
		await fh.close();
	}
}

async function statOrNull(path: string): Promise<Stats | null> {
	try {
		return await stat(path);
	} catch {
		return null;
	}
}

/**
 * Where content starts: 0, or just past line 1 for a source with a header
 * line. null while the header line is still incomplete.
 */
async function contentStart(
	path: string,
	headerLine: boolean | undefined,
): Promise<number | null> {
	if (!headerLine) return 0;
	const st = await statOrNull(path);
	if (!st) return null;
	let pos = 0;
	let window = 4096;
	while (pos < st.size) {
		const buf = await readRange(path, pos, Math.min(st.size, pos + window));
		const nl = buf.indexOf(NEWLINE);
		if (nl >= 0) return pos + nl + 1;
		pos += buf.length;
		window *= 2;
	}
	return null;
}

/** The offset just past the last newline before `end` (only complete lines), at least `floor`. */
async function lastLineEnd(
	path: string,
	floor: number,
	end: number,
): Promise<number> {
	let hi = end;
	let window = 4096;
	while (hi > floor) {
		const lo = Math.max(floor, hi - window);
		const buf = await readRange(path, lo, hi);
		const nl = buf.lastIndexOf(NEWLINE);
		if (nl >= 0) return lo + nl + 1;
		hi = lo;
		window *= 2;
	}
	return floor;
}

interface Line {
	offset: number;
	/** Bytes, without the newline. */
	length: number;
	text: string;
}

/** Splits complete lines with their file offsets. */
function lines(buf: Buffer, base: number): Line[] {
	const out: Line[] = [];
	let from = 0;
	for (;;) {
		const nl = buf.indexOf(NEWLINE, from);
		if (nl < 0) break;
		if (nl > from)
			out.push({
				offset: base + from,
				length: nl - from,
				text: buf.subarray(from, nl).toString("utf8"),
			});
		from = nl + 1;
	}
	return out;
}

/** Keeps the first position of each id with its last value. */
export function dedupe(events: TranscriptEvent[]): TranscriptEvent[] {
	const index = new Map<string, number>();
	const out: TranscriptEvent[] = [];
	for (const e of events) {
		const at = index.get(e.id);
		if (at === undefined) {
			index.set(e.id, out.length);
			out.push(e);
		} else out[at] = e;
	}
	return out;
}

/** Where an image's record sits: one line of one file. */
interface ImageLocation {
	path: string;
	ino: number;
	offset: number;
	length: number;
}

/** Image id → line, per agent, bounded (oldest dropped first). */
class ImageIndex {
	private readonly map = new Map<string, ImageLocation>();
	private readonly opts: Options;

	constructor(opts: Options) {
		this.opts = opts;
	}

	private static key(agentId: string, imageId: string) {
		return `${agentId}\0${imageId}`;
	}

	/**
	 * Gives the images in `events` (parsed from `line`) their URLs and indexes
	 * them, then empties `state.images`.
	 */
	add(
		agentId: string,
		file: { path: string; ino: number },
		line: { offset: number; length: number },
		state: ParseState,
		events: TranscriptEvent[],
	) {
		for (const e of events) {
			for (const image of e.images ?? [])
				image.url = this.opts.imageUrl(agentId, image.id);
			for (const doc of e.documents ?? [])
				doc.url = this.opts.imageUrl(agentId, doc.id);
		}
		if (state.images.size === 0) return;
		for (const id of state.images.keys()) {
			const key = ImageIndex.key(agentId, id);
			this.map.delete(key);
			this.map.set(key, { ...file, offset: line.offset, length: line.length });
		}
		state.images.clear();
		for (const key of this.map.keys()) {
			if (this.map.size <= this.opts.imageIndexLimit) break;
			this.map.delete(key);
		}
	}

	get(agentId: string, imageId: string) {
		return this.map.get(ImageIndex.key(agentId, imageId));
	}
}

/** The image type the bytes start with, if allowed. */
export function sniffImage(data: Uint8Array): ImageType | null {
	const at = (i: number, ...bytes: number[]) =>
		bytes.every((b, j) => data[i + j] === b);
	if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
	if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
	if (at(0, 0x47, 0x49, 0x46, 0x38) && (data[4] === 0x37 || data[4] === 0x39))
		return "image/gif";
	if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
		return "image/webp";
	return null;
}

/** The value at a JSON path; `"<json>"` steps into a JSON-encoded string. */
function walk(value: unknown, at: Array<string | number>): unknown {
	let cur = value;
	for (const step of at) {
		if (step === "<json>") {
			if (typeof cur !== "string") return undefined;
			try {
				cur = JSON.parse(cur) as unknown;
			} catch {
				return undefined;
			}
		} else if (cur && typeof cur === "object")
			cur = (cur as Record<string | number, unknown>)[step];
		else return undefined;
	}
	return cur;
}

/**
 * omp keeps image bytes in `<agent dir>/blobs/<sha256>`, next to the
 * `sessions` folder that holds the transcript (at any depth).
 */
async function blobFile(
	transcript: string,
	hash: string,
): Promise<string | null> {
	let dir = dirname(transcript);
	for (let i = 0; i < 8; i++) {
		if (basename(dir) === "sessions") {
			const file = join(dirname(dir), "blobs", hash);
			return (await statOrNull(file))?.isFile() ? file : null;
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return null;
}

/** Decodes an image's value from its record. */
async function decodeImage(
	value: unknown,
	source: ImageSource,
	transcript: string,
): Promise<ImageResult> {
	if (typeof value !== "string") return { ok: false, reason: "not_found" };
	let data: Buffer;
	if (source.mediaType === "application/pdf") {
		// Documents: base64 only, and the bytes must be a PDF.
		if (source.encoding !== "base64")
			return { ok: false, reason: "unsupported" };
		if (base64Bytes(value) > DOCUMENT_MAX_BYTES)
			return { ok: false, reason: "too_large" };
		const pdf = Buffer.from(value, "base64");
		return pdf.subarray(0, 5).toString("latin1") === "%PDF-"
			? { ok: true, mediaType: "application/pdf", data: pdf }
			: { ok: false, reason: "unsupported" };
	}
	if (source.encoding === "blob") {
		const hash = blobHash(value);
		const file = hash ? await blobFile(transcript, hash) : null;
		const st = file ? await statOrNull(file) : null;
		if (!file || !st) return { ok: false, reason: "not_found" };
		if (st.size > IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
		data = await readRange(file, 0, st.size);
	} else {
		let start = 0;
		if (source.encoding === "data-url") {
			const parsed = dataUrl(value);
			if (!parsed) return { ok: false, reason: "unsupported" };
			start = parsed.start;
		}
		if (base64Bytes(value, start) > IMAGE_MAX_BYTES)
			return { ok: false, reason: "too_large" };
		data = Buffer.from(start ? value.slice(start) : value, "base64");
	}
	if (data.length > IMAGE_MAX_BYTES) return { ok: false, reason: "too_large" };
	// Serve what the bytes are, and only an allowed type.
	const mediaType = sniffImage(data);
	if (!mediaType) return { ok: false, reason: "unsupported" };
	return { ok: true, mediaType, data };
}

let gapSeq = 0;

/** The marker that tells a viewer events were dropped: re-page from history. */
export function gapEvent(): TranscriptEvent {
	return {
		id: `gap:${Date.now().toString(36)}:${++gapSeq}`,
		ts: Date.now(),
		role: "system",
		kind: "system",
		text: "gap",
	};
}

/** One live listener with its bounded queue. */
class Subscriber {
	private queue: TranscriptEvent[] = [];
	private busy = false;
	private scheduled = false;
	closed = false;
	private readonly fn: TranscriptListener;
	private readonly limit: number;

	constructor(fn: TranscriptListener, limit: number) {
		this.fn = fn;
		this.limit = limit;
	}

	push(events: TranscriptEvent[]) {
		if (this.closed || events.length === 0) return;
		this.queue.push(...events);
		if (this.queue.length > this.limit) this.queue = [gapEvent()];
		this.schedule();
	}

	private schedule() {
		if (this.busy || this.scheduled || this.closed) return;
		this.scheduled = true;
		setImmediate(() => this.flush());
	}

	private flush() {
		this.scheduled = false;
		if (this.busy || this.closed || this.queue.length === 0) return;
		const batch = this.queue;
		this.queue = [];
		let result: unknown;
		try {
			result = this.fn(batch);
		} catch (e) {
			debugLog(`transcript listener threw: ${(e as Error).message}`);
		}
		if (result && typeof (result as Promise<unknown>).then === "function") {
			this.busy = true;
			const done = () => {
				this.busy = false;
				this.schedule();
			};
			(result as Promise<unknown>).then(done, done);
		}
	}
}

/** One agent's live watcher, shared by all its subscribers. */
class Watcher {
	readonly subs = new Set<Subscriber>();
	private timer: NodeJS.Timeout | null = null;
	private fsWatch: FSWatcher | null = null;
	private resolved: ResolvedTranscript | null = null;
	/** The source this watcher follows now (null until found, or once it went away). */
	get source(): ResolvedTranscript | null {
		return this.resolved;
	}
	// File sources.
	private path: string | null = null;
	private ino = -1;
	private start = 0;
	private offset = 0;
	/** Inside a line longer than MAX_READ: drop bytes up to its end. */
	private skipping = false;
	private state: ParseState = newParseState();
	// Poll sources.
	private seen = new Map<string, string>();
	private inFlight = false;
	private closed = false;
	/** The first attach follows the file from its end; later ones read it from the start. */
	private attached = false;
	/** One tick at a time; a tick asked for meanwhile runs right after. */
	private running: Promise<void> | null = null;
	private again = false;
	private readonly agentId: string;
	private readonly opts: Options;
	private readonly images: ImageIndex;
	private readonly onEmit: TranscriptTap;

	constructor(
		agentId: string,
		opts: Options,
		images: ImageIndex,
		onEmit: TranscriptTap,
	) {
		this.agentId = agentId;
		this.opts = opts;
		this.images = images;
		this.onEmit = onEmit;
		// The first tick attaches; the poll starts once the source (and its
		// interval) is known.
		this.ready = this.tick().then(() => {
			if (this.closed) return;
			this.timer = setInterval(() => void this.tick(), this.interval());
			this.timer.unref?.();
		});
	}

	/** Resolves once the first attach finished (the live offset is set). */
	readonly ready: Promise<void>;

	private interval() {
		const source = this.resolved?.source;
		return source?.kind === "poll"
			? (source.intervalMs ?? this.opts.pollMs)
			: this.opts.pollMs;
	}

	/**
	 * Finds the source. On the first attempt a file is followed from its end
	 * (history comes from `read`); a file found later is new, so it is read
	 * from its first line.
	 */
	private async attach(initial: boolean) {
		let resolved: ResolvedTranscript | null = null;
		try {
			resolved = await this.opts.resolve(this.agentId);
		} catch (e) {
			debugLog(
				`transcript resolve ${this.agentId} failed: ${(e as Error).message}`,
			);
		}
		this.resolved = resolved;
		if (!resolved) return;
		if (resolved.source.kind === "poll") {
			void this.poll(true);
			return;
		}
		this.path = resolved.source.path;
		const st = await statOrNull(this.path);
		if (!st) {
			this.resolved = null;
			return;
		}
		this.ino = st.ino;
		const start = await contentStart(this.path, resolved.source.headerLine);
		this.start = start ?? 0;
		if (initial && start !== null) {
			this.offset = await lastLineEnd(this.path, start, st.size);
			await this.prime(resolved);
		} else {
			this.offset = this.start;
			this.skipping = false;
			this.state = newParseState({ atStart: true, cwd: resolved.cwd ?? null });
		}
		this.watchFile();
	}

	/** Parses the end of the history so results find their calls; nothing is emitted. */
	private async prime(resolved: ResolvedTranscript) {
		const path = this.path!;
		let from = Math.max(this.start, this.offset - this.opts.pageBytes);
		if (from > this.start) {
			const buf = await readRange(path, from, this.offset);
			const nl = buf.indexOf(NEWLINE);
			from = nl >= 0 ? from + nl + 1 : this.offset;
		}
		this.state = newParseState({
			atStart: from === this.start,
			cwd: resolved.cwd ?? null,
		});
		try {
			const text = (await readRange(path, from, this.offset)).toString("utf8");
			if (text) resolved.parse(text, this.state);
		} catch (e) {
			debugLog(`transcript prime ${path}: ${(e as Error).message}`);
		}
		// Nothing is emitted, so nothing is indexed.
		this.state.images.clear();
	}

	private watchFile() {
		this.fsWatch?.close();
		this.fsWatch = null;
		if (!this.path) return;
		try {
			this.fsWatch = watch(
				this.path,
				{ persistent: false },
				() => void this.tick(),
			);
			this.fsWatch.on("error", () => {
				this.fsWatch?.close();
				this.fsWatch = null;
			});
		} catch {
			// The poll still runs.
		}
	}

	private emit(events: TranscriptEvent[]) {
		if (events.length === 0) return;
		for (const sub of this.subs) sub.push(events);
		this.onEmit(this.agentId, events);
	}

	/** Reads what is new; resolves when this tick (and any asked for meanwhile) is done. */
	tick(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.running) {
			this.again = true;
			return this.running;
		}
		this.running = (async () => {
			do {
				this.again = false;
				await this.step();
			} while (this.again && !this.closed);
		})().finally(() => {
			this.running = null;
		});
		return this.running;
	}

	private async step() {
		try {
			if (!this.resolved) {
				const initial = !this.attached;
				this.attached = true;
				await this.attach(initial);
				if (!this.resolved || this.closed) return;
			}
			if (this.resolved.source.kind === "poll") await this.poll(false);
			else await this.readFile(this.resolved);
		} catch (e) {
			debugLog(`transcript tick ${this.agentId}: ${(e as Error).message}`);
		}
	}

	private async readFile(resolved: ResolvedTranscript) {
		const path = this.path!;
		const st = await statOrNull(path);
		if (!st) {
			// Gone: look for it again on the next tick.
			this.resolved = null;
			this.fsWatch?.close();
			this.fsWatch = null;
			return;
		}
		const headerLine =
			resolved.source.kind === "file" && resolved.source.headerLine;
		if (st.ino !== this.ino || st.size < this.offset) {
			// Truncated or replaced: start over from the first line.
			this.ino = st.ino;
			this.start = (await contentStart(path, headerLine)) ?? 0;
			this.offset = this.start;
			this.skipping = false;
			this.state = newParseState({ atStart: true, cwd: resolved.cwd ?? null });
			this.emit([gapEvent()]);
			this.watchFile();
		}
		if (headerLine && this.offset === 0) {
			// The header line is still being written.
			const start = await contentStart(path, true);
			if (start === null) return;
			this.start = this.offset = start;
		}
		if (st.size <= this.offset) return;
		const end = Math.min(st.size, this.offset + MAX_READ);
		// More than one chunk behind: read the next one right after, not a tick later.
		if (end < st.size) this.again = true;
		let buf = await readRange(path, this.offset, end);
		if (this.skipping) {
			const first = buf.indexOf(NEWLINE);
			if (first < 0) {
				this.offset += buf.length;
				return;
			}
			this.skipping = false;
			this.offset += first + 1;
			buf = buf.subarray(first + 1);
		}
		let nl = buf.lastIndexOf(NEWLINE);
		if (nl < 0 && end < st.size) {
			// One line longer than a chunk: read on to its end, within limits.
			buf = await readRange(
				path,
				this.offset,
				Math.min(st.size, this.offset + MAX_LIVE_LINE),
			);
			nl = buf.indexOf(NEWLINE);
			if (nl < 0 && buf.length >= MAX_LIVE_LINE) {
				this.offset += buf.length;
				this.skipping = true;
				this.emit([gapEvent()]);
				return;
			}
		}
		if (nl < 0) return; // The line is still being written.
		const complete = buf.subarray(0, nl + 1);
		const base = this.offset;
		this.offset += complete.length;
		// Line by line, so each image is indexed by its line; one batch.
		const out: TranscriptEvent[] = [];
		const file = { path, ino: this.ino };
		for (const line of lines(complete, base)) {
			const events = safeParse(resolved.parse, line.text, this.state);
			this.images.add(this.agentId, file, line, this.state, events);
			out.push(...events);
		}
		this.emit(out);
	}

	private async poll(prime: boolean) {
		const source = this.resolved?.source;
		if (source?.kind !== "poll" || this.inFlight) return;
		this.inFlight = true;
		try {
			const page = await source.fetch(null);
			const fresh: TranscriptEvent[] = [];
			for (const e of page.events) {
				const json = JSON.stringify(e);
				if (this.seen.get(e.id) === json) continue;
				this.seen.delete(e.id);
				this.seen.set(e.id, json);
				fresh.push(e);
			}
			// Remember a bounded window of ids (oldest first in the map).
			for (const id of this.seen.keys()) {
				if (this.seen.size <= 5000) break;
				this.seen.delete(id);
			}
			if (!prime && !this.closed) this.emit(fresh);
		} catch (e) {
			debugLog(`transcript poll ${this.agentId}: ${(e as Error).message}`);
		} finally {
			this.inFlight = false;
		}
	}

	close() {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.fsWatch?.close();
		this.fsWatch = null;
		for (const sub of this.subs) sub.closed = true;
		this.subs.clear();
	}
}

export class TranscriptTailer {
	private readonly opts: Options;
	private readonly watchers = new Map<string, Watcher>();
	private readonly images: ImageIndex;
	/** Set by the service: every live batch also goes here. */
	tap: TranscriptTap | null = null;

	constructor(opts: TailerOptions) {
		this.opts = { ...DEFAULTS, ...opts };
		this.images = new ImageIndex(this.opts);
	}

	/** Agents with a live watcher. */
	get watching(): number {
		return this.watchers.size;
	}

	/** Subscribers on one agent's watcher (0 when none). */
	subscribers(agentId: string): number {
		return this.watchers.get(agentId)?.subs.size ?? 0;
	}

	/**
	 * One page of history, newest page first. Returns null when the agent has
	 * no transcript. Throws on a cursor this source did not hand out.
	 *
	 * Pages end on whole lines, so an id can appear on two pages (a call before
	 * the cursor, its result-updated copy after). Merge a page into what a
	 * client holds by adding missing ids only; never overwrite a held one.
	 */
	async read(
		agentId: string,
		cursor?: string | null,
	): Promise<TranscriptPage | null> {
		// A lookup can miss for a moment (a folder scan under load, a registry
		// update with another cwd): the source a live watcher follows still
		// answers, so a page never says "no transcript" for one it is streaming.
		const resolved =
			(await this.opts.resolve(agentId)) ??
			this.watchers.get(agentId)?.source ??
			null;
		if (!resolved) return null;
		const { source } = resolved;
		if (source.kind === "poll") return source.fetch(cursor ?? null);
		return this.readFile(
			agentId,
			resolved,
			source.path,
			source.headerLine,
			cursor,
		);
	}

	/**
	 * An image an event of this agent's transcript named. Re-reads and
	 * re-parses the line the image was indexed from, so a file that changed
	 * since then gives not_found rather than the wrong bytes.
	 */
	async image(agentId: string, imageId: string): Promise<ImageResult> {
		const missing: ImageResult = { ok: false, reason: "not_found" };
		const at = this.images.get(agentId, imageId);
		if (!at) return missing;
		const resolved = await this.opts.resolve(agentId);
		if (resolved?.source.kind !== "file" || resolved.source.path !== at.path)
			return missing;
		const st = await statOrNull(at.path);
		if (!st || st.ino !== at.ino || st.size < at.offset + at.length)
			return missing;
		if (at.length > IMAGE_LINE_MAX) return { ok: false, reason: "too_large" };
		const text = (
			await readRange(at.path, at.offset, at.offset + at.length)
		).toString("utf8");
		const state = newParseState({ cwd: resolved.cwd ?? null });
		safeParse(resolved.parse, text, state);
		const source = state.images.get(imageId);
		if (!source) return missing;
		let record: unknown;
		try {
			record = JSON.parse(text);
		} catch {
			return missing;
		}
		return decodeImage(walk(record, source.at), source, at.path);
	}

	private async readFile(
		agentId: string,
		resolved: ResolvedTranscript,
		path: string,
		headerLine: boolean | undefined,
		cursor: string | null | undefined,
	): Promise<TranscriptPage> {
		const st = await statOrNull(path);
		const start = st ? await contentStart(path, headerLine) : null;
		if (!st || start === null) return { events: [], cursor: null };
		let end: number;
		if (cursor === undefined || cursor === null || cursor === "")
			end = await lastLineEnd(path, start, st.size);
		else {
			end = Number(cursor);
			if (!/^\d+$/.test(cursor) || end < start || end > st.size)
				throw new RangeError(`bad transcript cursor: ${cursor}`);
		}
		const { pageBytes, maxPageBytes, pageEvents } = this.opts;
		let window = pageBytes;
		for (;;) {
			let from = Math.max(start, end - window);
			if (from > start) {
				// The byte before `end` ends the newest line; a line start must come
				// before it, or the page would be empty and the cursor stuck.
				const head = await readRange(path, from, end - 1);
				const nl = head.indexOf(NEWLINE);
				if (nl < 0) {
					// One line longer than the window: widen until it fits.
					window *= 2;
					continue;
				}
				from += nl + 1;
			}
			const state = newParseState({
				atStart: from === start,
				cwd: resolved.cwd ?? null,
			});
			const file = { path, ino: st.ino };
			const parsed = lines(await readRange(path, from, end), from).map(
				(line) => {
					const events = safeParse(resolved.parse, line.text, state);
					this.images.add(agentId, file, line, state, events);
					return { offset: line.offset, events };
				},
			);
			const total = parsed.reduce((n, l) => n + l.events.length, 0);
			if (total < pageEvents && from > start && window < maxPageBytes) {
				window *= 2;
				continue;
			}
			// Keep whole lines from the end, up to `pageEvents` events.
			let kept = parsed.length;
			let count = 0;
			while (kept > 0) {
				const n = parsed[kept - 1]!.events.length;
				if (count > 0 && count + n > pageEvents) break;
				count += n;
				kept--;
			}
			const first = parsed[kept]?.offset ?? from;
			const events = dedupe(parsed.slice(kept).flatMap((l) => l.events));
			const begin = kept > 0 ? first : from;
			return { events, cursor: begin > start ? String(begin) : null };
		}
	}

	/** Streams live events for an agent; returns the unsubscribe function. */
	subscribe(agentId: string, fn: TranscriptListener): () => void {
		let watcher = this.watchers.get(agentId);
		if (!watcher) {
			watcher = new Watcher(agentId, this.opts, this.images, (id, events) => {
				try {
					this.tap?.(id, events);
				} catch (e) {
					debugLog(`transcript tap ${id}: ${(e as Error).message}`);
				}
			});
			this.watchers.set(agentId, watcher);
		}
		const sub = new Subscriber(fn, this.opts.queueLimit);
		watcher.subs.add(sub);
		const w = watcher;
		return () => {
			if (sub.closed) return;
			sub.closed = true;
			w.subs.delete(sub);
			if (w.subs.size === 0 && this.watchers.get(agentId) === w) {
				w.close();
				this.watchers.delete(agentId);
			}
		};
	}

	/** Checks every watcher now instead of waiting for the poll; resolves when read. */
	async poke(agentId?: string): Promise<void> {
		const ticks: Promise<void>[] = [];
		for (const [id, w] of this.watchers)
			if (!agentId || id === agentId) ticks.push(w.ready.then(() => w.tick()));
		await Promise.all(ticks);
	}

	/** Resolves once an agent's watcher is attached (its live offset set). */
	async ready(agentId: string): Promise<void> {
		await this.watchers.get(agentId)?.ready;
	}

	/** Stops every watcher. */
	close() {
		for (const w of this.watchers.values()) w.close();
		this.watchers.clear();
	}
}

function safeParse(
	parse: ParseFn,
	text: string,
	state: ParseState,
): TranscriptEvent[] {
	try {
		return parse(text, state);
	} catch (e) {
		debugLog(`transcript parse failed: ${(e as Error).message}`);
		return [];
	}
}
