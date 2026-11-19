/**
 * The find bar's state: which agent's session it is open on, with what
 * query, and the event to land on first (a search hit the operator chose).
 */
import { navigate } from "../../lib/router.ts";
import { signal } from "../../lib/signals.ts";
import type { MessageHit } from "./api.ts";

export interface FindState {
	agentId: string;
	q: string;
	/** Land on this event first (else the newest match). */
	eventId: string | null;
	/** Bumps on every open, so opening the same hit again lands again. */
	seq: number;
}

export const find = signal<FindState | null>(null);

let seq = 0;

/** Opens the find bar on an agent's session. */
export function openFind(
	agentId: string,
	q = "",
	eventId: string | null = null,
) {
	find.value = { agentId, q, eventId, seq: ++seq };
}

export function closeFind() {
	find.value = null;
}

/** Opens a hit: its agent's session, the find bar prefilled, at the hit. */
export function openHit(hit: MessageHit, q: string) {
	navigate({ view: "agent", id: hit.agentId });
	openFind(hit.agentId, q, hit.eventId);
}
