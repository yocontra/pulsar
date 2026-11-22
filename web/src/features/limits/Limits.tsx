/**
 * The Usage page's "Limits" section: each plan limit a harness reported,
 * with how much is used and when it resets. Codex reports a percentage;
 * the other harnesses only say when a limit is reached, so they show here
 * only then.
 */
import type { UsageReport } from "../../api/types.ts";
import { AgentAvatar, harnessName } from "../../ds/index.ts";
import {
	DEFAULT_SETTINGS,
	levelOf,
	reachedText,
	resetText,
	usedText,
} from "./model.ts";
import "./limits.css";

export default function Limits({ report }: { report: UsageReport }) {
	const limits = report.limits ?? [];
	if (!limits.length) return null;
	const thresholds =
		report.limitSettings?.thresholds ?? DEFAULT_SETTINGS.thresholds;
	const names = new Map(report.machines.map((m) => [m.id, m.name]));
	const machines = new Set(limits.map((l) => l.machine));
	const sorted = [...limits].sort(
		(a, b) =>
			a.harness.localeCompare(b.harness) ||
			(b.usedPercent ?? 0) - (a.usedPercent ?? 0),
	);
	return (
		<section className="limits" aria-labelledby="limits-h">
			<h2 className="usage-h2" id="limits-h">
				Limits
			</h2>
			<ul className="limits-list">
				{sorted.map((l) => {
					const pct = l.reached ? 100 : Math.round(l.usedPercent ?? 0);
					const level = levelOf(l, thresholds);
					const reset = [
						l.reached ? reachedText(l.at) : null,
						resetText(l.resetsAt),
					]
						.filter(Boolean)
						.join(" · ");
					return (
						<li
							key={`${l.machine}\0${l.harness}\0${l.account}\0${l.window}`}
							className="limits-row"
							data-level={level}
							data-testid="limit-row"
						>
							<AgentAvatar harness={l.harness} size="xs" />
							<span className="limits-name">
								{harnessName(l.harness)} · {l.label}
								{machines.size > 1 && (
									<span className="limits-machine">
										{" "}
										on {names.get(l.machine) ?? "another machine"}
									</span>
								)}
							</span>
							<span
								className="limits-bar"
								role="meter"
								aria-label={`${harnessName(l.harness)} ${l.label.toLowerCase()} limit used`}
								aria-valuemin={0}
								aria-valuemax={100}
								aria-valuenow={pct}
							>
								<span style={{ width: `${pct}%` }} />
							</span>
							<span className="limits-used">{usedText(l)}</span>
							{reset && <span className="limits-reset">{reset}</span>}
						</li>
					);
				})}
			</ul>
			<p className="limits-note">
				Codex reports how much of each limit is used. Claude Code, pi and omp
				show here only when a limit is reached.
			</p>
		</section>
	);
}
