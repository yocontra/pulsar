import { ChevronRightIcon } from "lucide-react";
import type { SubagentRow } from "../api/types.ts";
import { useNow } from "../data/clock.ts";
import { AgentAvatar } from "../ds/index.ts";
import { navigate } from "../lib/router.ts";
import {
	STATE_WORD,
	subagentStateText,
	toggleSubagents,
} from "../lib/subagents.ts";
import type { Row } from "./treeRows.ts";

/**
 * The desktop sidebar's subagent rows: a disclosure under an agent that has
 * subagents ("2 running subagents"; finished ones only with the "Show
 * finished subagents" setting), and, when open, one indented row per
 * subagent (the agent row's shape, a smaller avatar). Clicking one opens
 * its transcript in the main pane.
 */

/** Left padding, as TreeDesktop's `indent` (kept here to avoid a cycle). */
const indent = (depth: number) => 4 + depth * 18;

export { STATE_WORD, subagentStateText };

export function SubagentsToggle({
	row,
	focused,
}: {
	row: Extract<Row, { t: "subs" }>;
	focused: boolean;
}) {
	const { running } = row.counts;
	const label = row.label;
	return (
		<button
			type="button"
			className={`d-row d-subs${focused ? " focused" : ""}`}
			style={{ paddingLeft: indent(row.depth) }}
			aria-expanded={row.open}
			aria-label={`${row.open ? "Hide" : "Show"} ${label}`}
			data-subs={row.agentId}
			onClick={() => toggleSubagents(row.agentId)}
		>
			<span className="chev" aria-hidden="true">
				<ChevronRightIcon />
			</span>
			<span className="d-subs-label">{label}</span>
			{running > 0 && <span className="d-subs-live" aria-hidden="true" />}
		</button>
	);
}

export function SubagentTreeRow({
	row,
	focused,
	current,
}: {
	row: Extract<Row, { t: "sub" }>;
	focused: boolean;
	current: boolean;
}) {
	const now = useNow();
	const s = row.sub;
	const line = s.agentType ?? kindWord(s);
	return (
		<button
			type="button"
			className={`d-row d-two d-sub s-${s.state}${focused ? " focused" : ""}${current ? " current" : ""}`}
			style={{ paddingLeft: indent(row.depth) + 6 }}
			aria-current={current ? "page" : undefined}
			aria-label={`Subagent ${s.name}, ${STATE_WORD[s.state].toLowerCase()}`}
			data-subagent={s.id}
			onClick={() => navigate({ view: "subagent", id: s.id })}
		>
			<AgentAvatar
				harness={s.harness}
				size="xs"
				status={s.state === "running" ? "busy" : undefined}
			/>
			<span className="d-lines">
				<span className="d-line1">
					<span className="d-name">{s.name}</span>
					<span className="d-trail">
						<SubagentStateWord sub={s} now={now} />
					</span>
				</span>
				<span className="d-line2">{line}</span>
			</span>
		</button>
	);
}

export function SubagentStateWord({
	sub,
	now,
}: {
	sub: SubagentRow;
	now?: number;
}) {
	return (
		<span className={`d-sub-state s-${sub.state}`}>
			{subagentStateText(sub, now)}
		</span>
	);
}

export function kindWord(s: SubagentRow) {
	switch (s.kind) {
		case "teammate":
			return "Teammate";
		case "thread":
			return "Spawned thread";
		case "session":
			return "Child session";
		default:
			return "Task";
	}
}
