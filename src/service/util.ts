import { randomBytes } from "node:crypto";
import { neutralizeHumanTag } from "../human-tag.ts";
import type { Store } from "../store.ts";
import type {
	Agent,
	DeliveredMessage,
	Message,
	Priority,
	PublicAgent,
	Receipt,
} from "../types.ts";
import { isFolderGuess } from "../types.ts";

/** A numeric request field clamped to [min, max]; missing or non-numeric input gets the default. */
export function clampInt(
	raw: unknown,
	fallback: number,
	min: number,
	max: number,
) {
	const n = Number(raw ?? fallback);
	const value = Number.isFinite(n) ? Math.trunc(n) : fallback;
	return Math.min(Math.max(value, min), max);
}

export function normalPriority(priority: Priority): Priority {
	return ["urgent", "normal", "fyi"].includes(priority) ? priority : "normal";
}

export function newId(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;
}

export function toPublic(agent: Agent): PublicAgent {
	const { meta, ...rest } = agent;
	return {
		...rest,
		...(meta.acpTitle ? { conversationTitle: meta.acpTitle } : {}),
		...(isFolderGuess(agent) ? { sessionFrom: "folder" } : {}),
	};
}

/** A stored message with its sender's public details, as receivers see it. */
export function delivered(
	msg: Message,
	sender: Agent | undefined,
): DeliveredMessage {
	return {
		...msg,
		// Agents read this shape (inbox, wait, ask, notifications): no tag look-alikes.
		body: neutralizeHumanTag(msg.body),
		from: {
			id: msg.fromId,
			name: neutralizeHumanTag(msg.fromName),
			harness: sender?.harness ?? "unknown",
			project: sender?.project ?? null,
		},
	};
}

export { type Framing, formatPush, type PushMessage } from "../push-frame.ts";

/** Records (or moves) one recipient's receipt for a message. */
export function writeReceipt(
	store: Store,
	messageId: string,
	agent: Agent,
	state: Receipt["state"],
	via: string | null,
	detail: string | null,
): Receipt {
	const r: Receipt = {
		messageId,
		agentId: agent.id,
		agentName: agent.name,
		state,
		via,
		detail,
		updatedAt: Date.now(),
	};
	store.setReceipt(r);
	return r;
}
