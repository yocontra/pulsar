import { createContext, useContext } from "react";
import {
	parseMessages,
	parseWait,
	pulsarTool,
	resultBody,
} from "../../../../src/transcripts/pulsar.ts";
import type { TranscriptEvent } from "../../api/types.ts";

/** A Pulsar message this transcript holds: who sent it and what it said. */
export interface KnownMessage {
	from: string;
	/** Sent by the human operator: named, never linked as an agent. */
	operator?: boolean;
	harness?: string;
	text: string;
}

export type KnownMessages = ReadonlyMap<string, KnownMessage>;

const EMPTY: KnownMessages = new Map();

/**
 * Pulsar messages by id, from the transcript: pushed into the conversation
 * (`[pulsar]` frames) or read with inbox and wait. A respond card names the
 * sender and quotes the message it answers from these.
 */
export const PulsarMessages = createContext<KnownMessages>(EMPTY);

export const useKnownMessage = (id: string | undefined) => {
	const all = useContext(PulsarMessages);
	return id ? all.get(id) : undefined;
};

/** "codex@apparish · m_7a1" → "codex@apparish". */
const fromName = (from: string | undefined) =>
	(from ?? "").split(" · ")[0]?.trim() || "Another agent";

export function knownMessages(
	events: readonly TranscriptEvent[],
): KnownMessages {
	let out: Map<string, KnownMessage> | null = null;
	const add = (id: string, m: KnownMessage) => {
		out ??= new Map();
		if (!out.has(id)) out.set(id, m);
	};
	for (const ev of events) {
		const id = ev.pulsar?.messageId;
		if (id)
			add(
				id,
				ev.pulsar?.sender === "operator"
					? { from: ev.from || "Operator", operator: true, text: ev.text }
					: { from: fromName(ev.from), text: ev.text },
			);
		if (ev.kind !== "tool_result" || !ev.tool?.name || ev.tool.isError)
			continue;
		const tool = pulsarTool(ev.tool.name);
		if (tool !== "inbox" && tool !== "history" && tool !== "wait") continue;
		const msgs =
			tool === "wait"
				? [parseWait(ev.text).message].filter((m) => !!m)
				: parseMessages(resultBody(ev.text));
		for (const m of msgs)
			add(m.id, {
				from: m.from.name,
				...(m.from.harness ? { harness: m.from.harness } : {}),
				text: m.body,
			});
	}
	return out ?? EMPTY;
}
