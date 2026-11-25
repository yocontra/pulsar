import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../paths.ts";
import type {
	TranscriptEvent,
	TranscriptSupport,
} from "../transcripts/types.ts";
import type { SessionRef } from "./types.ts";

export function acpTranscriptPath(harness: string, sessionId: string): string {
	const key = createHash("sha256")
		.update(JSON.stringify([harness, sessionId]))
		.digest("hex");
	return join(stateDir(), "acp", `${key}.jsonl`);
}

export const acpTranscript: TranscriptSupport<SessionRef> = {
	needsSession: true,
	async locate({ harness, sessionId }) {
		if (!sessionId) return null;
		const path = acpTranscriptPath(harness, sessionId);
		const info = await stat(path).catch(() => null);
		return info?.isFile() ? { kind: "file", path } : null;
	},
	parse(chunk) {
		const events: TranscriptEvent[] = [];
		for (const line of chunk.split("\n")) {
			try {
				const event = JSON.parse(line) as TranscriptEvent | null;
				if (
					event &&
					typeof event.id === "string" &&
					typeof event.text === "string"
				)
					events.push(event);
			} catch {
				// An unreadable record must not hide the rest of the transcript.
			}
		}
		return events;
	},
};
