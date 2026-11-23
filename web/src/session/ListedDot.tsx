import { useSubagents } from "../data/index.ts";
import { AgentMark } from "../ds/index.ts";
import {
	type DotProps,
	pickColor,
	type SubagentColorScope,
} from "./subagent-colors.tsx";

/** A subagent's dot, from its parent's subagent list (the data layer). */
export function ListedDot({
	agentId,
	scope,
	...p
}: DotProps & { agentId: string; scope: SubagentColorScope }) {
	const rows = useSubagents(agentId).data?.items;
	return (
		<AgentMark color={pickColor(p, scope, rows)} className={p.className} />
	);
}
