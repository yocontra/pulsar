/**
 * Query keys for every server read. The first element names the read; the
 * live layer (live.ts) maps keys to stream topics and patches their data.
 */
import type {
	AgentSort,
	AskRequest,
	ChangesMode,
	FacetKey,
	TreeGroup,
	TreeSort,
} from "../api/types.ts";

export const keys = {
	hello: () => ["hello"] as const,
	tree: (group: TreeGroup, filter: string, sort: TreeSort) =>
		["tree", group, filter, sort] as const,
	children: (nodeId: string, filter: string, sort: TreeSort) =>
		["children", nodeId, filter, sort] as const,
	/** A cursor-paged list of agents; its first page is the `results` topic. */
	agents: (selector: string, sort: AgentSort, limit: number) =>
		["agents", selector, sort, limit] as const,
	/** Match count, machines and wake totals for a selector (the `query` topic). */
	count: (selector: string) => ["count", selector] as const,
	agent: (id: string) => ["agent", id] as const,
	/** An agent's subagents (the `subagents` topic). */
	subagents: (agentId: string) => ["subagents", agentId] as const,
	/** One subagent (its page). */
	subagent: (id: string) => ["subagent", id] as const,
	attention: () => ["attention"] as const,
	/** Approvals as `approval` events showed them (client-side log). */
	approvals: () => ["approvals"] as const,
	approval: (requestId: string) => ["approval", requestId] as const,
	recent: () => ["recent"] as const,
	facets: (selector: string, facet: FacetKey, q: string, top: number) =>
		["facets", selector, facet, q, top] as const,
	search: (q: string) => ["search", q] as const,
	receipts: (messageId: string) => ["receipts", messageId] as const,
	/** Messages not yet in an agent's conversation (the `queue` topic). */
	queue: (agentId: string) => ["queue", agentId] as const,
	transcript: (agentId: string) => ["transcript", agentId] as const,
	/** An agent's worktree changes (the `changes` topic while it is the newest). */
	changes: (agentId: string, mode: ChangesMode) =>
		["changes", agentId, mode] as const,
	/** The changes count beside a session (worktree mode, slow poll, no topic). */
	changesPeek: (agentId: string) => ["changesPeek", agentId] as const,
	/** One file's diff; `key` is the summary entry's, so a change refetches it. */
	changeFile: (agentId: string, mode: ChangesMode, path: string, key: string) =>
		["changeFile", agentId, mode, path, key] as const,
	sessions: () => ["sessions"] as const,
	passkeys: () => ["passkeys"] as const,
	pushKey: () => ["pushKey"] as const,
	ask: (req: AskRequest) => ["ask", req] as const,
};

export type KeyName = keyof typeof keys;
