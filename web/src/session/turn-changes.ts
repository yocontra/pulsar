/**
 * What an agent's turn changed, from the file-editing tool calls the
 * transcript already holds (Claude Edit/MultiEdit/Write/NotebookEdit, Codex
 * and OpenCode apply_patch, pi/omp/OpenCode edit and write): the files with
 * their +/− and each file's hunks in call order. Not a net diff: an edit
 * carries only its snippets, so a file's diff is its edits one after the
 * other. Pure: no React, no DOM.
 */
import { diffLines } from "diff";
import {
	patchFiles,
	patchText,
	toolKind,
	toolPath,
} from "../../../src/transcripts/describe.ts";
import type { TranscriptEvent } from "../api/types.ts";
import type { DiffItem } from "./Diff.tsx";
import type { Item } from "./items.ts";
import type { ChatMessage } from "./messages.ts";

export type TurnFileStatus = "added" | "modified" | "deleted" | "moved";

export interface TurnFile {
	/** The absolute path when the folder is known, else as the tool gave it. */
	key: string;
	/** The path shown: relative to the agent's folder when inside it. */
	path: string;
	/** The path it moved from (apply_patch `Move to`). */
	from?: string;
	status: TurnFileStatus;
	added: number;
	removed: number;
	/** Rows for `DiffBody`: `a`/`b` index `before`/`after`. */
	items: DiffItem[];
	before: string;
	after: string;
}

export interface TurnChanges {
	files: TurnFile[];
	added: number;
	removed: number;
}

/** One file's part of one call. */
interface Piece {
	path: string;
	status: TurnFileStatus;
	moveTo?: string;
	/** Header over this piece's rows ("Edit 2 of 3", a patch's `@@` line). */
	hunks: { label: string; rows: Row[] }[];
}
type Row = { sign: "+" | "-" | " "; text: string };

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const rec = (v: unknown): Record<string, unknown> =>
	v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
const first = (o: Record<string, unknown>, ...keys: string[]) => {
	for (const k of keys) {
		const v = str(o[k]);
		if (v) return v;
	}
	return "";
};

function lineRows(text: string, sign: "+" | "-"): Row[] {
	if (!text) return [];
	return text
		.replace(/\n$/, "")
		.split("\n")
		.map((t) => ({ sign, text: t }));
}

function diffRows(before: string, after: string): Row[] {
	const nl = (t: string) => (t && !t.endsWith("\n") ? `${t}\n` : t);
	const rows: Row[] = [];
	for (const part of diffLines(nl(before), nl(after))) {
		const sign = part.added ? "+" : part.removed ? "-" : " ";
		for (const text of part.value.replace(/\n$/, "").split("\n"))
			rows.push({ sign, text });
	}
	return rows;
}

const OLD = ["old_string", "oldText", "old_str", "oldString"];
const NEW = ["new_string", "newText", "new_str", "newString"];

/** A non-file target: omp's `proc://` job input and `xd://` devices. */
const notAFile = (path: string) => /^(proc|xd):\/\//i.test(path);

/** What one call changed, file by file (before checking it applied). */
function pieces(name: string, input: unknown, result?: string): Piece[] {
	const a = rec(input);
	const kind = toolKind(name);
	const path = toolPath(input);
	if (kind === "patch") {
		return patchFiles(patchText(input)).map((f) => {
			const hunks: Piece["hunks"] = [];
			for (const line of f.lines) {
				if (line.startsWith("@@")) {
					hunks.push({ label: line, rows: [] });
					continue;
				}
				const sign = line[0];
				if (sign !== "+" && sign !== "-" && sign !== " ") continue;
				if (!hunks.length) hunks.push({ label: "", rows: [] });
				hunks[hunks.length - 1]!.rows.push({ sign, text: line.slice(1) });
			}
			const status: TurnFileStatus = f.moveTo
				? "moved"
				: f.op === "add"
					? "added"
					: f.op === "delete"
						? "deleted"
						: "modified";
			return {
				path: f.path,
				status,
				...(f.moveTo ? { moveTo: f.moveTo } : {}),
				hunks: hunks.filter((h) => h.rows.length || h.label),
			};
		});
	}
	if (!path || notAFile(path)) return [];
	if (kind === "edit") {
		const cmd = str(a.command);
		// str_replace_editor: one tool, several commands.
		if (cmd === "view" || cmd === "undo_edit") return [];
		if (cmd === "create")
			return [
				{
					path,
					status: "added",
					hunks: [{ label: "", rows: lineRows(str(a.file_text), "+") }],
				},
			];
		if (cmd === "insert")
			return [
				{
					path,
					status: "modified",
					hunks: [{ label: "", rows: lineRows(str(a.new_str), "+") }],
				},
			];
		const edits = Array.isArray(a.edits) && a.edits.length ? a.edits : [a];
		return [
			{
				path,
				status: "modified",
				hunks: edits.map((e, i) => {
					const o = rec(e);
					return {
						label: edits.length > 1 ? `Edit ${i + 1} of ${edits.length}` : "",
						rows: diffRows(first(o, ...OLD), first(o, ...NEW)),
					};
				}),
			},
		];
	}
	if (kind === "write") {
		// An overwrite says so (Claude: "The file … has been updated").
		const created = !/updated|overwr/i.test(result ?? "");
		return [
			{
				path,
				status: created ? "added" : "modified",
				hunks: [
					{
						label: "",
						rows: lineRows(first(a, "content", "contents", "file_text"), "+"),
					},
				],
			},
		];
	}
	if (kind === "notebook") {
		const mode = str(a.edit_mode);
		const cell = str(a.cell_id);
		return [
			{
				path,
				status: "modified",
				hunks: [
					{
						label: `${mode === "insert" ? "New cell" : mode === "delete" ? "Deleted cell" : "Cell"}${cell ? ` ${cell}` : ""}`,
						rows: mode === "delete" ? [] : lineRows(str(a.new_source), "+"),
					},
				],
			},
		];
	}
	return [];
}

/** Calls that can change files. */
export function isFileEdit(name: string | undefined): boolean {
	if (!name) return false;
	const k = toolKind(name);
	return k === "edit" || k === "patch" || k === "write" || k === "notebook";
}

/**
 * Did the call change anything: it finished (a result, or the call re-sent
 * as done) and wasn't refused, stopped or failed.
 */
export function applied(call: TranscriptEvent, result?: TranscriptEvent) {
	const t = call.tool;
	if (!t || (!result && !t.done)) return false;
	if (t.isError || result?.tool?.isError) return false;
	const d = result?.tool?.detail ?? t.detail;
	return !d?.denied && !d?.interrupted;
}

// A history re-renders on every live event: compute each call's pieces once.
const cache = new WeakMap<TranscriptEvent, Piece[]>();

function callPieces(call: TranscriptEvent, result?: TranscriptEvent): Piece[] {
	let p = cache.get(call);
	if (!p) {
		p = pieces(call.tool?.name ?? "", call.tool?.input, result?.text);
		cache.set(call, p);
	}
	return p;
}

function absolute(path: string, cwd: string | null | undefined): string {
	if (path.startsWith("/") || !cwd) return path;
	return `${cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
}

function relative(path: string, cwd: string | null | undefined): string {
	if (cwd && path.startsWith(`${cwd.replace(/\/$/, "")}/`))
		return path.slice(cwd.replace(/\/$/, "").length + 1);
	return path;
}

/** Edit calls in these parts, subagents' own edits included, in order. */
function editCalls(parts: Item[], out: Extract<Item, { t: "tool" }>[] = []) {
	for (const p of parts) {
		if (p.t === "tool") {
			if (p.call && isFileEdit(p.call.tool?.name)) out.push(p);
		} else if (p.t === "task" || p.t === "side") editCalls(p.children, out);
	}
	return out;
}

/** The files these parts (one turn's) changed, or null when none. */
export function turnChanges(
	parts: Item[],
	cwd?: string | null,
): TurnChanges | null {
	const files = new Map<
		string,
		{ file: TurnFile; hunks: Piece["hunks"]; firstStatus: TurnFileStatus }
	>();
	for (const it of editCalls(parts)) {
		const call = it.call!;
		if (!applied(call, it.result)) continue;
		const base = call.tool?.cwd ?? cwd;
		for (const piece of callPieces(call, it.result)) {
			let key = absolute(piece.path, base);
			let entry = files.get(key);
			if (!entry) {
				entry = {
					file: {
						key,
						path: relative(key, cwd),
						status: piece.status,
						added: 0,
						removed: 0,
						items: [],
						before: "",
						after: "",
					},
					hunks: [],
					firstStatus: piece.status,
				};
				files.set(key, entry);
			} else if (piece.status === "deleted") entry.file.status = "deleted";
			else if (entry.file.status === "deleted")
				// Deleted, then written again in the same turn.
				entry.file.status =
					piece.status === "added" ? "modified" : piece.status;
			entry.hunks.push(...piece.hunks);
			if (piece.moveTo) {
				// The file lives on under its new name.
				const to = absolute(piece.moveTo, base);
				files.delete(key);
				key = to;
				entry.file.key = to;
				entry.file.from = entry.file.path;
				entry.file.path = relative(to, cwd);
				if (entry.firstStatus !== "added") entry.file.status = "moved";
				files.set(to, entry);
			}
		}
	}
	if (!files.size) return null;
	let added = 0;
	let removed = 0;
	const out: TurnFile[] = [];
	for (const { file, hunks } of files.values()) {
		const before: string[] = [];
		const after: string[] = [];
		const labelled = hunks.length > 1 || hunks.some((h) => h.label);
		hunks.forEach((h, i) => {
			if (labelled)
				file.items.push({ hunk: h.label || `Change ${i + 1}`, key: `h${i}` });
			for (const r of h.rows) {
				if (r.sign === "+") {
					file.items.push({ sign: "+", b: after.length, text: r.text });
					after.push(r.text);
					file.added++;
				} else if (r.sign === "-") {
					file.items.push({ sign: "-", a: before.length, text: r.text });
					before.push(r.text);
					file.removed++;
				} else {
					file.items.push({
						sign: " ",
						a: before.length,
						b: after.length,
						text: r.text,
					});
					before.push(r.text);
					after.push(r.text);
				}
			}
		});
		file.before = before.join("\n");
		file.after = after.join("\n");
		added += file.added;
		removed += file.removed;
		out.push(file);
	}
	return { files: out, added, removed };
}

/**
 * Each finished turn's changes, keyed by the id of the turn's last assistant
 * message (where the summary shows). A turn runs from one user or peer
 * message to the next; system rows inside it don't end it. While `busy`, the
 * last turn is still going and gets no summary yet.
 */
export function turnSummaries(
	messages: ChatMessage[],
	cwd?: string | null,
	busy = false,
): Map<string, TurnChanges> {
	const out = new Map<string, TurnChanges>();
	let parts: Item[] = [];
	let lastId: string | null = null;
	const close = () => {
		if (lastId) {
			const c = turnChanges(parts, cwd);
			if (c) out.set(lastId, c);
		}
		parts = [];
		lastId = null;
	};
	for (const m of messages) {
		if (m.kind === "user" || m.kind === "peer") close();
		else if (m.kind === "assistant") {
			parts.push(...m.parts);
			lastId = m.id;
		}
	}
	if (!busy) close();
	return out;
}
