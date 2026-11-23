import { ArrowUpRightIcon } from "lucide-react";
import { useSubagents } from "../data/index.ts";

import { navigate } from "../lib/router.ts";
import { SubagentDot } from "./subagent-colors.tsx";

/**
 * In a parent's transcript, a subagent card's way to the subagent's own
 * page: found by the Task call that started it (Claude's `toolUseId`).
 * Renders nothing until the parent's subagent list names that call.
 */
export function SubagentLink({
	agentId,
	callId,
}: {
	agentId: string;
	callId: string;
}) {
	const list = useSubagents(agentId).data;
	const sub = list?.items.find((s) => s.callId === callId);
	if (!sub) return null;
	return (
		<button
			type="button"
			className="ds-task-open"
			data-subagent-link={sub.id}
			onClick={() => navigate({ view: "subagent", id: sub.id })}
		>
			<SubagentDot name={sub.name} callId={sub.callId} />
			Open {sub.name}
			<ArrowUpRightIcon aria-hidden="true" />
		</button>
	);
}
