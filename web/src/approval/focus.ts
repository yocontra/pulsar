/**
 * "Take me to that prompt": Needs You, push deep links (`#/approval/<id>`)
 * and the tree's badges open the agent's conversation and ask its inline
 * prompt card to scroll into view and focus its first control.
 */
import { signal } from "../lib/signals.ts";

export const promptFocus = signal<{ agentId: string; n: number } | null>(null);

/**
 * The agent whose inline prompt card is on screen now (PromptInline): the
 * phone's "Approval needed" banner hides while the card itself shows.
 */
export const promptOnScreen = signal<string | null>(null);

let n = 0;
export function focusPrompt(agentId: string) {
	promptFocus.value = { agentId, n: ++n };
}

/** Open an agent's conversation at its prompt card (`#/approval/<id>`). */
export async function openPrompt(agentId: string) {
	const { navigate, route } = await import("../lib/router.ts");
	const r = route.peek();
	if (!(r.view === "approval" && r.id === agentId))
		navigate({ view: "approval", id: agentId });
	focusPrompt(agentId);
}
