/**
 * Opening the phone's git sheet from outside its header button: on a
 * narrow phone the agent page's ••• menu holds "Git" (the button is hidden
 * to make room). Tiny: the agent page imports it without the git chunk.
 */
import { signal } from "../../lib/signals.ts";

/** The agent whose git sheet should open next. */
export const gitAsk = signal<string | null>(null);

/** Whether each offered Git sheet can currently be opened. */
export const gitOffered = signal<ReadonlyMap<string, boolean>>(new Map());

export function showGit(agentId: string) {
	gitAsk.value = agentId;
}

/** Marks an agent's git button as shown (or gone). */
export function offerGit(agentId: string, enabled: boolean | undefined) {
	const cur = gitOffered.peek();
	if (cur.get(agentId) === enabled) return;
	const next = new Map(cur);
	if (enabled === undefined) next.delete(agentId);
	else next.set(agentId, enabled);
	gitOffered.value = next;
}
