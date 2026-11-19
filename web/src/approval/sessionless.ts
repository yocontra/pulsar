/**
 * Prompts with no conversation to show them in: the operator at the
 * terminal (`cli:operator`, e.g. a pool change started in a terminal) has
 * no session page, so its prompt opens as a dialog (desktop) or a sheet
 * (phone). Every agent's prompt shows inline in its conversation.
 */
export const sessionless = (agentId: string) =>
	agentId === "cli:operator" || agentId.endsWith("/cli:operator");
