/** Navigation helpers shared by rows (kept small: Home's first route loads it). */
import type { AgentRow, AttentionItem, TreeNode } from "../api/types.ts";
import { focusPrompt } from "../approval/focus.ts";
import { sessionless } from "../approval/sessionless.ts";
import { navigate, route } from "../lib/router.ts";
import { can, pins } from "../lib/store.ts";

export const isPinned = (id: string) => pins.value.some((p) => p.id === id);

/** Open an approval: its agent's conversation, at the inline prompt card. */
export function openApproval(agentId: string) {
	// No conversation to show it in (the operator's): its own sheet.
	if (sessionless(agentId)) {
		navigate({ view: "approval", id: agentId });
		return;
	}
	const r = route.peek();
	if (!((r.view === "agent" || r.view === "approval") && r.id === agentId))
		navigate({ view: "agent", id: agentId });
	focusPrompt(agentId);
}

export function openNeeds(item: AttentionItem) {
	if (item.kind === "approval") openApproval(item.agent.id);
	else navigate({ view: "agent", id: item.agent.id });
}

export function messageGroup(n: TreeNode) {
	navigate({ view: "node", id: n.id });
}

export const canStop = (a: AgentRow) =>
	can("stop") && a.canStop && a.state !== "offline";
