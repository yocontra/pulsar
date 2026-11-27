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
			subagentObserved: "1",
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
			status: child.status !== "gone",
		},
	};
}

/** Only a reported state can finish a wait. An omitted row may be outside
 * the discovery limit or temporarily unavailable. */
export function changedChildren(
	before: ChildStatus[],
	after: ChildStatus[],
	notify: (child: ChildStatus) => void,
) {
	const previous = new Map(before.map((item) => [item.key, item.status]));
	for (const child of after)
		if (
			(child.status === "gone" || child.status === "idle") &&
			previous.get(child.key) !== child.status
		)
			notify(child);
}
