import type { TranscriptEvent, TranscriptPush } from "../api/types.ts";
import type { Item } from "./items.ts";

/**
 * TranscriptEvent[] → chat-shaped messages for the AI Elements components
 * (no `ai` SDK): consecutive assistant events (text, reasoning, tools,
 * subagent tasks) form one assistant message; user, peer and system events
 * are their own messages.
 */
export type ChatMessage =
	| { kind: "user"; id: string; ev: TranscriptEvent }
	| { kind: "peer"; id: string; ev: TranscriptEvent }
	| { kind: "system"; id: string; ev: TranscriptEvent }
	| { kind: "assistant"; id: string; ts: number; parts: Item[] };

export function toMessages(items: Item[]): ChatMessage[] {
	const out: ChatMessage[] = [];
	for (const it of items) {
		if (it.t === "msg" && it.ev.role === "user") {
			out.push({ kind: "user", id: it.key, ev: it.ev });
			continue;
		}
		if (it.t === "peer") {
			out.push({ kind: "peer", id: it.key, ev: it.ev });
			continue;
		}
		if (it.t === "system") {
			out.push({ kind: "system", id: it.key, ev: it.ev });
			continue;
		}
		const last = out[out.length - 1];
		if (last?.kind === "assistant") last.parts.push(it);
		else
			out.push({
				kind: "assistant",
				id: `m-${it.key}`,
				ts: tsOf(it),
				parts: [it],
			});
	}
	return out;
}

function tsOf(it: Item): number {
	switch (it.t) {
		case "tool":
			return (it.call ?? it.result)?.ts ?? 0;
		case "task":
			return it.call.ts;
		case "side":
			return 0;
		default:
			return it.ev.ts;
	}
}

/** Plain text of an assistant message, for the copy action. */
export function messageText(
	m: Extract<ChatMessage, { kind: "assistant" }>,
): string {
	return m.parts
		.filter((p): p is Extract<Item, { t: "msg" }> => p.t === "msg")
		.map((p) => p.ev.text)
		.join("\n\n");
}

/** The label of an unverified send from the Pulsar app. */
export const APP_SENDER = "From the Pulsar app (not verified)";

/** "codex@apparish · m_7a1" → { agent, machine? } for "from X @ machine". */
export function peerFrom(from: string | undefined): string {
	if (!from) return "Another agent";
	return from.split(" · ")[0] ?? from;
}

/**
 * Who wrote a user turn. A message the operator sent through Pulsar (proven
 * with a passkey) is theirs: "Ada Lovelace", "via Pulsar on studio", with
 * the Pulsar message id. "you via pulsar (studio)" → { name: "You", via:
 * "via Pulsar · studio" }.
 */
export function userAuthor(
	from: string | undefined,
	pulsar?: TranscriptPush,
): {
	name: string;
	via?: string;
	messageId?: string;
} {
	if (pulsar?.sender === "operator")
		return {
			name: from || "Operator",
			via: pulsar.machine ? `via Pulsar on ${pulsar.machine}` : "via Pulsar",
			...(pulsar.messageId ? { messageId: pulsar.messageId } : {}),
		};
	if (!from) return { name: "You" };
	const m = /^you(?: via pulsar)?(?: \((.+)\))?$/i.exec(from.trim());
	if (m)
		return { name: "You", via: m[1] ? `via Pulsar · ${m[1]}` : "via Pulsar" };
	return { name: from };
}
