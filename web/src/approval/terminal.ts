/**
 * The words for a prompt only the agent's own terminal can answer (needs-you
 * reason `terminal`): the card (TerminalCard.tsx) and the Needs You rows.
 */
import type { AttentionItem } from "../api/types.ts";

const WHY = {
	expired: "The app's time to answer ran out.",
	"not-sent": "This prompt wasn't sent to the app.",
} as const;

/** "Answer in the terminal on studio". */
export const terminalTitle = (machine: string | null | undefined) =>
	`Answer in the terminal on ${machine ?? "its machine"}`;

/** Why the app can't answer, when this machine knows. */
export const terminalWhy = (item: AttentionItem) =>
	item.terminal ? WHY[item.terminal.why] : null;

/** What the terminal waits on, from the harness ("permission prompt"). */
export function terminalWaitingFor(item: AttentionItem): string | null {
	const d = item.agent.needsYou?.detail ?? item.title;
	const what = d?.replace(/^Waiting in the terminal:\s*/i, "").trim();
	return what || null;
}
