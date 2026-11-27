import { createHash } from "node:crypto";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { neutralizeHumanTag } from "../human-tag.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";

/** Provider titles are display text, independent of Pulsar names and addresses. */
export function conversationTitle(value: unknown): string {
	if (typeof value !== "string") return "";
	return neutralizeHumanTag(value.slice(0, 2048))
		.replace(/\p{Bidi_Control}/gu, "")
		.replace(/[\s\p{Cc}]+/gu, " ")
		.trim()
		.slice(0, 200);
}

export function sessionNotice(
	agentId: string,
	raw: { title?: unknown; severity?: unknown; description?: unknown },
) {
	const title = conversationTitle(raw.title);
	if (!title) return null;
	const severity =
		raw.severity === "warning" || raw.severity === "error"
			? raw.severity
			: "info";
	return {
		agentId,
		title,
		description: conversationTitle(raw.description),
		severity,
	} as const;
}

export function compactionEvent(
	update: Extract<SessionUpdate, { sessionUpdate: "compaction_update" }>,
): Omit<TranscriptEvent, "ts"> | null {
	const labels: Record<string, string> = {
		in_progress: "Compacting conversation",
		completed: "Conversation compacted",
		failed: "Conversation compaction failed",
		cancelled: "Conversation compaction cancelled",
	};
	if (!Object.hasOwn(labels, update.status)) return null;
	return {
		id: `acp:compaction:${createHash("sha256").update(update.compactionId).digest("hex")}`,
		role: "system",
		kind: "system",
		subtype: update.status === "completed" ? "compacted" : undefined,
		text: labels[update.status]!,
	};
}
