/**
 * What an ended turn did, for its notification: the agent's last message,
 * when the turn started, how many files it changed, and (failed turns) the
 * harness's error. Read from the parsed end of the session log. Text is
 * cleaned (secrets redacted) and cut to `SUMMARY_MAX` here, since the turn
 * record goes to the other machines of the pool.
 */
import {
	patchFiles,
	patchText,
	toolKind,
	toolPath,
} from "../transcripts/describe.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import { clean, clip, SUMMARY_MAX, type TurnSummary } from "./push-copy.ts";

/** A message that starts a turn: the operator's, or one Pulsar delivered. */
function starts(e: TranscriptEvent): boolean {
	if (e.sidechain) return false;
	if (e.role === "peer") return true;
	return (
		e.role === "user" &&
		e.kind === "text" &&
		e.subtype !== "hidden" &&
		e.subtype !== "compacted" &&
		e.subtype !== "interrupted"
	);
}

/** The summary of the last turn in `events` (oldest first). */
export function summarizeTurn(
	events: TranscriptEvent[],
	failed: boolean,
): TurnSummary {
	let start = -1;
	for (let i = events.length - 1; i >= 0; i--)
		if (starts(events[i]!)) {
			start = i;
			break;
		}
	const out: TurnSummary = {};
	if (start >= 0) out.startedAt = events[start]!.ts;
	const files = new Set<string>();
	let last = "";
	let error = "";
	for (const e of events.slice(start + 1)) {
		if (e.sidechain) continue;
		if (e.kind === "tool_call" && e.tool) {
			const k = toolKind(e.tool.name);
			if (k === "edit" || k === "write" || k === "notebook" || k === "patch") {
				const p = toolPath(e.tool.input);
				if (p) files.add(p);
				else if (k === "patch")
					for (const f of patchFiles(patchText(e.tool.input)))
						files.add(f.path);
			}
		} else if (e.kind === "text" && e.role === "assistant" && e.text.trim())
			last = e.text;
		else if (e.kind === "system" || e.role === "system")
			if (e.text.trim()) error = e.text;
	}
	if (files.size) out.files = files.size;
	if (failed) {
		// A failed turn's last message is usually the error itself.
		const raw = error || last;
		if (raw) out.error = clip(clean(raw), SUMMARY_MAX);
	} else if (last) out.text = clip(clean(last), SUMMARY_MAX);
	return out;
}
