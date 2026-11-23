/**
 * Opening the phone's git sheet from outside its header button: on a
 * narrow phone the agent page's ••• menu holds "Git" (the button is hidden
 * to make room). Tiny: the agent page imports it without the git chunk.
 */
import { signal } from "../../lib/signals.ts";

/** The agent whose git sheet should open next. */
export const gitAsk = signal<string | null>(null);

/** Agents whose header offers git (a repository, git allowed). */
export const gitOffered = signal<ReadonlySet<string>>(new Set());

export function showGit(agentId: string) {
	gitAsk.value = agentId;
}

/** Marks an agent's git button as shown (or gone). */
export function offerGit(agentId: string, on: boolean) {
	const cur = gitOffered.peek();
	if (cur.has(agentId) === on) return;
	const next = new Set(cur);
	if (on) next.add(agentId);
	else next.delete(agentId);
	gitOffered.value = next;
}
