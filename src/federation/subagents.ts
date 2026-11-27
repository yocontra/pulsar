import { conversationTitle } from "../harnesses/acp-session-info.ts";
import type {
	SubagentCounts,
	SubagentKind,
	SubagentList,
	SubagentRow,
	SubagentState,
} from "../http/wire.ts";
import { NOTICE_COLORS } from "../transcripts/types.ts";
import { clean } from "./protocol.ts";

/**
 * Subagents from a peer, taken as data: every field checked and bounded,
 * ids rewritten to this node's pool addresses (`<machineId>/<home id>`).
 * A peer may name only subagents of the agent asked about.
 */

const STATES = new Set<SubagentState>(["running", "idle", "done", "unknown"]);
const KINDS = new Set<SubagentKind>(["task", "teammate", "thread", "session"]);
const MAX_ITEMS = 200;

/** A peer's string: control and bidi characters removed, bounded; null when empty. */
function text(v: unknown, max: number): string | null {
	return typeof v === "string" ? clean(v, max) || null : null;
}

function num(v: unknown): number {
	const n = Number(v);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** `AgentRow.subagents` from a peer's agent record; null when absent or malformed. */
export function cleanCounts(v: unknown): SubagentCounts | null {
	if (!v || typeof v !== "object") return null;
	const c = v as Record<string, unknown>;
	const total = Math.min(num(c.total), 100_000) | 0;
	const running = Math.min(num(c.running), total) | 0;
	if (total <= 0) return null;
	// `done` is absent from older peers; keep it absent then.
	if (c.done === undefined) return { total, running };
	return { total, running, done: Math.min(num(c.done), total - running) | 0 };
}

/** A peer's answer to `subagents.list` for `localParent`, as this node shows it. */
export function cleanSubagentList(
	raw: unknown,
	machineId: string,
	localParent: string,
): SubagentList {
	const list = (raw && typeof raw === "object" ? raw : {}) as Record<
		string,
		unknown
	>;
	const prefix = `${localParent}/sub:`;
	const items: SubagentRow[] = [];
	for (const r of Array.isArray(list.items)
		? list.items.slice(0, MAX_ITEMS)
		: []) {
		if (!r || typeof r !== "object") continue;
		const x = r as Record<string, unknown>;
		const id = text(x.id, 400);
		if (!id?.startsWith(prefix) || id.slice(prefix.length).includes("/"))
			continue;
		const parentSub = text(x.parentSubId, 400);
		const mode = (x.messaging as Record<string, unknown> | undefined)?.mode;
		items.push({
			id: `${machineId}/${id}`,
			parentId: `${machineId}/${localParent}`,
			name: text(x.name, 80) ?? "Subagent",
			harness: text(x.harness, 40) ?? "unknown",
			kind: KINDS.has(x.kind as SubagentKind)
				? (x.kind as SubagentKind)
				: "task",
			color: NOTICE_COLORS.find((c) => c === x.color) ?? null,
			agentType: text(x.agentType, 80),
			description: text(x.description, 300),
			...(typeof x.conversationTitle === "string"
				? { conversationTitle: conversationTitle(x.conversationTitle) }
				: {}),
			state: STATES.has(x.state as SubagentState)
				? (x.state as SubagentState)
				: "done",
			startedAt: num(x.startedAt),
			updatedAt: num(x.updatedAt),
			finishedAt: x.finishedAt == null ? null : num(x.finishedAt),
			callId: text(x.callId, 100),
			parentSubId: parentSub?.startsWith(prefix)
				? `${machineId}/${parentSub}`
				: null,
			hasTranscript: x.hasTranscript === true,
			messaging: {
				mode: mode === "direct" ? "direct" : "parent",
				note:
					text(
						(x.messaging as Record<string, unknown> | undefined)?.note,
						300,
					) ?? "This goes to the parent agent, naming the subagent.",
			},
		});
	}
	return {
		agentId: `${machineId}/${localParent}`,
		items,
		total: items.length,
		running: items.filter((i) => i.state === "running").length,
	};
}
