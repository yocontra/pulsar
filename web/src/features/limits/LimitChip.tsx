/**
 * The session header's limit note: shown only when the agent's harness is
 * past a warning threshold on its machine ("Weekly limit: 88%") or has hit
 * its limit. Opens the Usage page.
 */
import { GaugeIcon } from "lucide-react";
import { harnessName } from "../../ds/index.ts";
import { navigate } from "../../lib/router.ts";
import { useAgentUsage } from "../../usage/data.ts";
import {
	DEFAULT_SETTINGS,
	levelOf,
	resetText,
	useLimits,
	worst,
} from "./model.ts";
import "./limits.css";

export default function LimitChip({
	agentId,
	mobile,
}: {
	agentId: string;
	mobile: boolean;
}) {
	const u = useAgentUsage(agentId);
	const settings = useLimits().data?.settings ?? DEFAULT_SETTINGS;
	const l = worst(u.data?.limits ?? [], settings.thresholds);
	if (!l) return null;
	const pct = Math.round(l.usedPercent ?? 0);
	const text = l.reached
		? `${l.label} limit reached`
		: `${l.label} limit: ${pct}%`;
	const reset = resetText(l.resetsAt);
	return (
		<button
			type="button"
			className={mobile ? "limit-chip is-phone" : "limit-chip"}
			data-level={levelOf(l, settings.thresholds)}
			data-testid="limit-chip"
			title={`${harnessName(l.harness)} · ${text}${reset ? ` · ${reset}` : ""}`}
			onClick={() => navigate({ view: "page", name: "usage" })}
		>
			<GaugeIcon aria-hidden="true" />
			<span>{mobile ? (l.reached ? "Limit" : `${pct}%`) : text}</span>
		</button>
	);
}
