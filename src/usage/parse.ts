/**
 * Token usage from harness session files, one line at a time. Each parser
 * keeps what it needs between lines (and between scans: the scanner saves
 * it with the file's byte offset) in a small `FileState`.
 *
 * Normalized counts: `input` is uncached input only; cache reads and writes
 * are their own fields, so a price applies to each.
 */

import type { LimitState } from "../http/wire.ts";
import { LIMIT_MARKERS, limitsOf } from "./limits.ts";

export interface UsageRecord {
	/** When the tokens were used (ms). */
	t: number;
	model: string;
	input: number;
	cacheRead: number;
	cacheWrite5m: number;
	cacheWrite1h: number;
	output: number;
	/**
	 * A provider message id seen in more than one line or file (Claude writes
	 * one line per content block, and a resumed session copies old lines):
	 * the scanner counts each id once.
	 */
	dedupeId?: string;
	/** pi/omp: the provider that answered (a later answer clears its reached limit). */
	account?: string;
}

export interface FileState {
	/** Working folder the session ran in. */
	cwd?: string;
	/** The model in use (Codex names it in `turn_context`, before token counts). */
	model?: string;
	/** Codex: the last cumulative totals, so a repeated event adds nothing. */
	total?: CodexTotals;
	/** Tokens in the latest request's context, and the window when the harness says. */
	context?: { used: number; window: number | null };
}

export type UsageHarness = "claude" | "codex" | "pi" | "omp";

type Json = Record<string, unknown>;

const num = (v: unknown) =>
	typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const obj = (v: unknown): Json | null =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
const str = (v: unknown) => (typeof v === "string" && v ? v : null);

function time(v: unknown): number | null {
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v !== "string") return null;
	const t = Date.parse(v);
	return Number.isFinite(t) ? t : null;
}

function parse(line: string): Json | null {
	try {
		return obj(JSON.parse(line));
	} catch {
		return null;
	}
}

/** Cheap substring checks, so most lines (tool output, text) skip JSON.parse. */
const WANTED: Record<UsageHarness, string[]> = {
	claude: ['"usage"'],
	codex: ['"token_count"', '"turn_context"', '"session_meta"'],
	pi: ['"usage"', '"type":"session"'],
	omp: ['"usage"', '"type":"session"'],
};

/**
 * The usage in one line, or null; updates `state`. Plan limit readings in
 * the line (src/usage/limits.ts) go to `onLimit`.
 */
export function parseLine(
	harness: UsageHarness,
	line: string,
	state: FileState,
	onLimit?: (s: LimitState) => void,
): UsageRecord | null {
	const limit =
		onLimit !== undefined &&
		LIMIT_MARKERS[harness].some((m) => line.includes(m));
	if (!limit && !WANTED[harness].some((w) => line.includes(w))) return null;
	const d = parse(line);
	if (!d) return null;
	if (limit) for (const s of limitsOf(harness, d)) onLimit(s);
	switch (harness) {
		case "claude":
			return claudeLine(d, state);
		case "codex":
			return codexLine(d, state);
		default:
			return piLine(d, state);
	}
}

const empty = (r: UsageRecord) =>
	r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h + r.output === 0;

/**
 * Claude Code: an assistant line's `message.usage`. `input_tokens` excludes
 * the cache; `cache_creation` splits writes by lifetime when present.
 */
function claudeLine(d: Json, state: FileState): UsageRecord | null {
	const cwd = str(d.cwd);
	if (cwd) state.cwd = cwd;
	const m = obj(d.message);
	const u = obj(m?.usage);
	if (!m || !u || m.role !== "assistant") return null;
	const model = str(m.model);
	// Claude Code's own placeholder replies (errors, interrupts) cost nothing.
	if (!model || model === "<synthetic>") return null;
	const t = time(d.timestamp);
	if (t === null) return null;
	const split = obj(u.cache_creation);
	const w1h = num(split?.ephemeral_1h_input_tokens);
	const w5m = split
		? num(split.ephemeral_5m_input_tokens)
		: num(u.cache_creation_input_tokens);
	const r: UsageRecord = {
		t,
		model,
		input: num(u.input_tokens),
		cacheRead: num(u.cache_read_input_tokens),
		cacheWrite5m: w5m,
		cacheWrite1h: w1h,
		output: num(u.output_tokens),
	};
	const id = str(m.id);
	if (id) r.dedupeId = id;
	state.model = model;
	state.context = {
		used: r.input + r.cacheRead + r.cacheWrite5m + r.cacheWrite1h,
		window: null,
	};
	return empty(r) ? null : r;
}

interface CodexTotals {
	input: number;
	cached: number;
	write: number;
	output: number;
}

function codexTotals(u: Json | null): CodexTotals | null {
	if (!u) return null;
	return {
		input: num(u.input_tokens),
		cached: num(u.cached_input_tokens),
		write: num(u.cache_write_input_tokens),
		output: num(u.output_tokens),
	};
}

/**
 * Codex: `token_count` events carry cumulative totals and the last turn's
 * usage. The difference from the previous totals is what this event adds
 * (Codex repeats events with unchanged totals); when the totals go down
 * (a new thread in the same file) the last turn's usage counts instead.
 * Codex's `input_tokens` includes the cached part.
 */
function codexLine(d: Json, state: FileState): UsageRecord | null {
	const p = obj(d.payload);
	if (!p) return null;
	if (d.type === "session_meta" || d.type === "turn_context") {
		const cwd = str(p.cwd);
		if (cwd) state.cwd = cwd;
		const model = str(p.model);
		if (model) state.model = model;
		return null;
	}
	if (d.type !== "event_msg" || p.type !== "token_count") return null;
	const info = obj(p.info);
	const total = codexTotals(obj(info?.total_token_usage));
	if (!info || !total) return null;
	const prev = state.total;
	let add: CodexTotals | null;
	if (
		prev &&
		total.input >= prev.input &&
		total.cached >= prev.cached &&
		total.write >= prev.write &&
		total.output >= prev.output
	)
		add = {
			input: total.input - prev.input,
			cached: total.cached - prev.cached,
			write: total.write - prev.write,
			output: total.output - prev.output,
		};
	else add = prev ? codexTotals(obj(info.last_token_usage)) : total;
	state.total = total;
	const last = obj(info.last_token_usage);
	if (last)
		state.context = {
			used: num(last.input_tokens) + num(last.output_tokens),
			window: num(info.model_context_window) || null,
		};
	const t = time(d.timestamp);
	if (!add || t === null) return null;
	const r: UsageRecord = {
		t,
		model: state.model ?? "unknown",
		input: Math.max(0, add.input - add.cached),
		cacheRead: add.cached,
		cacheWrite5m: add.write,
		cacheWrite1h: 0,
		output: add.output,
	};
	return empty(r) ? null : r;
}

/**
 * pi and omp: a `session` header names the folder; each assistant
 * `message` line has `usage` with input, cache reads and writes, output.
 */
function piLine(d: Json, state: FileState): UsageRecord | null {
	if (d.type === "session") {
		const cwd = str(d.cwd);
		if (cwd) state.cwd = cwd;
		return null;
	}
	if (d.type !== "message") return null;
	const m = obj(d.message);
	const u = obj(m?.usage);
	if (!m || !u || m.role !== "assistant") return null;
	const t = time(d.timestamp) ?? time(m.timestamp);
	if (t === null) return null;
	const model = str(m.model) ?? state.model ?? "unknown";
	const write = num(u.cacheWrite);
	const w1h = Math.min(write, num(u.cacheWrite1h));
	const r: UsageRecord = {
		t,
		model,
		input: num(u.input),
		cacheRead: num(u.cacheRead),
		cacheWrite5m: write - w1h,
		cacheWrite1h: w1h,
		output: num(u.output),
	};
	const id = str(m.responseId);
	if (id) r.dedupeId = id;
	const provider = str(m.provider);
	if (provider) r.account = provider;
	state.model = model;
	state.context = { used: r.input + r.cacheRead + write, window: null };
	return empty(r) ? null : r;
}
