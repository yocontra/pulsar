/**
 * One agent's usage in its session header: the context bar when the
 * harness reports a window ("Context: 42% used"), and the session's cost
 * (an API estimate) or its tokens when the model has no price.
 */
import { useAgentUsage } from "./data.ts";
import {
	compact,
	costSourcesLabel,
	money,
	tokenSourcesLabel,
} from "./model.ts";
import "./usage.css";

export default function AgentUsage({ agentId }: { agentId: string }) {
	const q = useAgentUsage(agentId);
	const u = q.data;
	if (!u) return null;
	const c = u.context;
	const pct = c?.window
		? Math.min(100, Math.round((c.used / c.window) * 100))
		: null;
	const total =
		u.tokens.input +
		u.tokens.cacheRead +
		u.tokens.cacheWrite5m +
		u.tokens.cacheWrite1h +
		u.tokens.output;
	const tokenSources = u.tokenSources ?? [
		u.tokens.records > 0 ? "reported" : "unavailable",
	];
	const costSources = u.costSources ?? [
		u.cost === null ? "unavailable" : "estimated",
	];
	const label =
		u.cost === null && u.tokens.records > 0
			? `${compact(total)} ${tokenSourcesLabel(tokenSources)} · ${costSourcesLabel(costSources)}`
			: costSourcesLabel(costSources);
	return (
		<span className="usage-agent" data-high={pct !== null && pct >= 80}>
			{pct !== null && c?.window && (
				<span
					className="usage-agent-ctx"
					title={`${c.used.toLocaleString()} of ${c.window.toLocaleString()} tokens`}
				>
					<span>Context: {pct}% used</span>
					<span
						className="usage-bar"
						role="meter"
						aria-label="Context used"
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={pct}
					>
						<span style={{ width: `${pct}%` }} />
					</span>
				</span>
			)}
			<span>{u.cost === null ? label : `${money(u.cost)} · ${label}`}</span>
		</span>
	);
}
