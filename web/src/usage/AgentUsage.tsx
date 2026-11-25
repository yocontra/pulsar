/**
 * One agent's usage in its session header: the context bar when the
 * harness reports a window ("Context: 42% used"), and the session's cost
 * (an API estimate) or its tokens when the model has no price.
 */
import { Popover } from "radix-ui";
import { useAgentUsage } from "./data.ts";
import {
	compact,
	costSourcesLabel,
	modelName,
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
	const scopeLabel =
		u.byModel?.length && label === "API estimate"
			? "Session API estimate"
			: label;
	const costLabel =
		u.cost === null ? label : `${money(u.cost)} · ${scopeLabel}`;
	const dates = new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
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
			{u.byModel?.length ? (
				<Popover.Root>
					<Popover.Trigger asChild>
						<button
							type="button"
							className="usage-session-cost"
							title="Session usage by model"
						>
							{costLabel}
						</button>
					</Popover.Trigger>
					<Popover.Portal>
						<Popover.Content
							className="usage-cost-detail"
							sideOffset={6}
							collisionPadding={8}
							aria-label="Session usage by model"
						>
							<strong>Session usage by model</strong>
							{u.period && (
								<p>
									{dates.formatRange(u.period.firstHour, u.period.lastHour)}
								</p>
							)}
							<table>
								<thead>
									<tr>
										<th>Model</th>
										<th>Responses</th>
										<th>Estimate</th>
									</tr>
								</thead>
								<tbody>
									{u.byModel.map((row) => (
										<tr key={row.model}>
											<td>{modelName(row.model)}</td>
											<td>{row.records.toLocaleString()}</td>
											<td>
												{row.cost === null
													? "Unpriced"
													: row.cost >= 1000
														? row.cost.toLocaleString("en-US", {
																style: "currency",
																currency: "USD",
															})
														: money(row.cost)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
							<p>Includes recorded subagent usage. Estimates use API rates.</p>
						</Popover.Content>
					</Popover.Portal>
				</Popover.Root>
			) : (
				<span>{costLabel}</span>
			)}
		</span>
	);
}
