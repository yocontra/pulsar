import { diffLines } from "diff";
import type { TranscriptEvent } from "../api/types.ts";

/** Pages may come newest-first; the transcript renders oldest-first. */
export function chronological(events: TranscriptEvent[]): TranscriptEvent[] {
	if (events.length > 1 && events[0]!.ts > events[events.length - 1]!.ts)
		return [...events].reverse();
	return events;
}

/**
 * Merge a history page (the newest page, or an older one) into what we hold.
 * History never overwrites: live events are newer (a tool call re-sent with
 * its result folded in), so only ids we don't hold are added.
 */
export function mergeHistory(
	held: TranscriptEvent[],
	page: TranscriptEvent[],
): TranscriptEvent[] {
	const ordered = chronological(page);
	if (ordered.length === 0) return held;
	const byId = new Map(held.map((e) => [e.id, e]));
	const inPage = new Set(ordered.map((e) => e.id));
	// Held events before the page: everything held ahead of the first event the
	// page shares with us, or (no overlap) everything older than the page.
	const firstShared = held.findIndex((e) => inPage.has(e.id));
	const pageStart = ordered[0]!.ts;
	const before: TranscriptEvent[] = [];
	const after: TranscriptEvent[] = [];
	held.forEach((e, i) => {
		if (inPage.has(e.id)) return;
		const older = firstShared >= 0 ? i < firstShared : e.ts < pageStart;
		(older ? before : after).push(e);
	});
	return [...before, ...ordered.map((e) => byId.get(e.id) ?? e), ...after];
}

/** Live events replace what we hold by id, and append new ones. */
export function mergeLive(
	held: TranscriptEvent[],
	live: TranscriptEvent[],
): { events: TranscriptEvent[]; added: number } {
	const next = held.slice();
	const index = new Map(next.map((e, i) => [e.id, i]));
	let added = 0;
	for (const e of live) {
		const i = index.get(e.id);
		if (i !== undefined) next[i] = e;
		else {
			index.set(e.id, next.length);
			next.push(e);
			added++;
		}
	}
	return { events: next, added };
}

export const isGap = (e: TranscriptEvent) =>
	e.kind === "system" && e.text === "gap";

export type Item =
	| { t: "msg"; key: string; ev: TranscriptEvent }
	| { t: "thinking"; key: string; ev: TranscriptEvent }
	| { t: "peer"; key: string; ev: TranscriptEvent }
	| { t: "system"; key: string; ev: TranscriptEvent }
	| { t: "tool"; key: string; call?: TranscriptEvent; result?: TranscriptEvent }
	| {
			t: "task";
			key: string;
			call: TranscriptEvent;
			result?: TranscriptEvent;
			children: Item[];
			steps: number;
	  }
	| { t: "side"; key: string; children: Item[]; steps: number };

/**
 * Turn raw events into display items: tool calls paired with results by
 * `callId`, subagent (sidechain) events folded under their Task call.
 */
export function buildItems(events: TranscriptEvent[]): Item[] {
	const out: Item[] = [];
	const tools = new Map<string, Extract<Item, { t: "tool" | "task" }>>();
	const tasks = new Map<string, Extract<Item, { t: "task" }>>();

	const place = (list: Item[], ev: TranscriptEvent) => {
		const callId = ev.tool?.callId;
		if (ev.kind === "tool_call" && callId) {
			if (isSubagent(ev.tool?.name)) {
				const it: Extract<Item, { t: "task" }> = {
					t: "task",
					key: ev.id,
					call: ev,
					children: [],
					steps: 0,
				};
				tasks.set(callId, it);
				tools.set(callId, it);
				list.push(it);
			} else {
				const it: Extract<Item, { t: "tool" }> = {
					t: "tool",
					key: ev.id,
					call: ev,
				};
				tools.set(callId, it);
				list.push(it);
			}
			return;
		}
		if (ev.kind === "tool_result") {
			const it = callId ? tools.get(callId) : undefined;
			if (it) it.result = ev;
			else list.push({ t: "tool", key: ev.id, result: ev });
			return;
		}
		if (ev.kind === "thinking") list.push({ t: "thinking", key: ev.id, ev });
		else if (ev.kind === "peer" || ev.role === "peer")
			list.push({ t: "peer", key: ev.id, ev });
		else if (ev.kind === "system") list.push({ t: "system", key: ev.id, ev });
		else list.push({ t: "msg", key: ev.id, ev });
	};

	for (const ev of events) {
		if (ev.checklist?.length === 0) continue;
		if (ev.sidechain) {
			const task =
				typeof ev.sidechain === "string" ? tasks.get(ev.sidechain) : undefined;
			if (task) {
				place(task.children, ev);
				if (ev.kind !== "tool_result") task.steps++;
				continue;
			}
			let side = out[out.length - 1];
			if (side?.t !== "side") {
				side = { t: "side", key: `side-${ev.id}`, children: [], steps: 0 };
				out.push(side);
			}
			place(side.children, ev);
			if (ev.kind !== "tool_result") side.steps++;
			continue;
		}
		place(out, ev);
	}
	return out;
}

/** Claude's Task/Agent calls run a subagent whose steps fold under the call. */
export function isSubagent(name: string | undefined): boolean {
	const n = name?.toLowerCase();
	return n === "task" || n === "agent";
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

export interface DiffLine {
	sign: "+" | "-" | " ";
	text: string;
}

/** The before/after text of an Edit or Write call, or null for other tools. */
export function editTexts(
	name: string,
	input: Record<string, unknown> | undefined,
): { before: string; after: string; created: boolean } | null {
	if (!input) return null;
	const n = name.toLowerCase();
	if (n === "edit" || n === "multiedit" || n === "str_replace") {
		const edits = Array.isArray(input.edits)
			? (input.edits as Record<string, unknown>[])
			: null;
		if (edits?.length)
			return {
				before: edits
					.map((e) => str(e.old_string ?? e.oldText ?? e.old_str))
					.join("\n"),
				after: edits
					.map((e) => str(e.new_string ?? e.newText ?? e.new_str))
					.join("\n"),
				created: false,
			};
		return {
			before: str(input.old_string ?? input.oldText ?? input.old_str),
			after: str(input.new_string ?? input.newText ?? input.new_str),
			created: false,
		};
	}
	if (n === "write" || n === "create")
		return { before: "", after: str(input.content), created: true };
	return null;
}

/** Edit/Write tool input as a line diff. */
export function toolDiff(
	name: string,
	input: Record<string, unknown> | undefined,
): { lines: DiffLine[]; added: number; removed: number } | null {
	const t = editTexts(name, input);
	if (!t) return null;
	const { before, after } = t;
	const lines: DiffLine[] = [];
	let added = 0;
	let removed = 0;
	for (const part of diffLines(before, after)) {
		const sign = part.added ? "+" : part.removed ? "-" : " ";
		const rows = part.value.replace(/\n$/, "").split("\n");
		for (const text of rows) {
			lines.push({ sign, text });
			if (sign === "+") added++;
			else if (sign === "-") removed++;
		}
	}
	return { lines, added, removed };
}

/** The one-line target of a tool call: a path, a command, a pattern. */
export function toolTarget(_name: string, raw: unknown): string {
	const input = asRecord(raw);
	if (!input) return "";
	const s =
		str(input.file_path) ||
		str(input.path) ||
		str(input.command) ||
		str(input.pattern) ||
		str(input.description) ||
		str(input.url) ||
		str(input.query) ||
		"";
	return s.split("\n")[0] ?? "";
}

/** A tool call's input as an object, when it is one. */
export function asRecord(v: unknown): Record<string, unknown> | undefined {
	return v && typeof v === "object" && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: undefined;
}
