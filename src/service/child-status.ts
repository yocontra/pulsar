import type { Agent, AgentStatus } from "../types.ts";
import { SUB_MARK } from "./pool.ts";

/** Observations are separate from message addresses. An ACP provider can announce
 * a running child without providing any way to send a prompt to that child. */
export interface ChildStatus {
	key: string;
	name: string;
	status: AgentStatus;
}

export function observedAgent(parent: Agent, child: ChildStatus): Agent {
	const localId = (parent.meta.localId ?? parent.id) + SUB_MARK + child.key;
	return {
		...parent,
		id: parent.id + SUB_MARK + child.key,
		name: child.name,
		status: child.status,
		pid: null,
		sessionId: null,
		activity: null,
		model: null,
		registered: false,
		inbound: "refuse",
		reach: "pull",
		tags: [],
		meta: {
			subagentOf: parent.id,
			subagentKey: child.key,
			...(parent.meta.machineId
				? { machineId: parent.meta.machineId, localId }
				: {}),
		},
		capabilities: {
			surface: parent.capabilities?.surface ?? "attached",
			inbox: false,
			wake: false,
			stop: false,
			transcript: false,
			subagents: false,
			status: child.status === "busy" || child.status === "idle",
		},
	};
}

/** A child leaving its home node's live list has ended. Only an explicit idle
 * observation reports a finished turn. A sibling or parent cannot satisfy it. */
export function changedChildren(
	before: ChildStatus[],
	after: ChildStatus[],
	notify: (child: ChildStatus) => void,
) {
	const current = new Map(after.map((item) => [item.key, item]));
	for (const old of before) {
		if (old.status === "gone") continue;
		const next = current.get(old.key);
		if (!next) notify({ ...old, status: "gone" });
		else if (next.status === "gone") notify(next);
		else if (next.status === "idle" && old.status !== "idle") notify(next);
	}
}
