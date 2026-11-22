/**
 * Opening an agent's issue card from outside its header (the sidebar's
 * context menu, the phone's agent menu): open the session, and the header
 * chip opens its card. Tiny: loaded at start.
 */
import { tagValue } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { signal } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";

/** The agent whose header should open its issue card next. */
export const issueAsk = signal<string | null>(null);

/** The issue number an agent's tags name, when the daemon serves cards. */
export function issueOf(agent: { id: string; tags: string[] }): string | null {
	// A subagent's record carries no issue of its own.
	if (agent.id.includes("/sub:")) return null;
	const n = tagValue(agent.tags, "issue");
	return n && /^\d{1,7}$/.test(n) && can("issues") ? n : null;
}

/** Opens the agent's session with its issue card shown. */
export function showIssue(agentId: string) {
	navigate({ view: "agent", id: agentId });
	issueAsk.value = agentId;
}
