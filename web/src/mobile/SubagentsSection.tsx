import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { subagentStateText } from "../components/SubagentRows.tsx";
import { useNow } from "../data/clock.ts";
import { useSubagents } from "../data/index.ts";
import { AgentAvatar } from "../ds/index.ts";
import { navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import {
	orderSubagents,
	showFinished,
	subagentsLabel,
	visibleSubagents,
} from "../lib/subagents.ts";
import { IonToolbar } from "./ionic.ts";

/**
 * The phone agent page's Subagents section: collapsed to a count line by
 * default (the conversation stays first); open, one row per subagent.
 * Finished ones are listed only with "Show finished subagents" (Settings).
 * Tapping one pushes its page.
 */
function SubagentsSectionImpl({ agentId }: { agentId: string }) {
	const [open, setOpen] = useState(false);
	const now = useNow();
	const show = showFinished.value;
	const list = useSubagents(agentId).data;
	const rows = list ? orderSubagents(visibleSubagents(list.items, show)) : [];
	if (list && rows.length === 0) return null;
	const label = list
		? subagentsLabel(
				{
					total: list.items.length,
					running: list.items.filter((s) => s.state === "running").length,
					done: list.items.filter((s) => s.state === "done").length,
				},
				show,
			)
		: "Subagents";
	// Its own toolbar row in the page header: none at all when nothing is listed.
	return (
		<IonToolbar className="p-subs-bar">
			<section
				className="p-sa"
				aria-label="Subagents"
				data-subs-section={agentId}
			>
				<button
					type="button"
					className="p-sa-row p-sa-toggle"
					aria-expanded={open}
					onClick={() => setOpen(!open)}
				>
					<span className="p-sa-lines">
						<span className="p-sa-name">{label}</span>
					</span>
					<ChevronRightIcon
						aria-hidden="true"
						style={{ transform: open ? "rotate(90deg)" : undefined, width: 16 }}
					/>
				</button>
				{open && (
					<div className="p-sa-list">
						{rows.map(({ sub, level }) => (
							<button
								type="button"
								key={sub.id}
								className={`p-sa-row s-${sub.state}`}
								style={{ paddingLeft: level * 16 }}
								data-subagent={sub.id}
								onClick={() => navigate({ view: "subagent", id: sub.id })}
							>
								<AgentAvatar
									harness={sub.harness}
									size="sm"
									status={sub.state === "running" ? "busy" : undefined}
								/>
								<span className="p-sa-lines">
									<span className="p-sa-name">{sub.name}</span>
									<span className="p-sa-line">
										{[subagentStateText(sub, now), sub.agentType]
											.filter(Boolean)
											.join(" · ")}
									</span>
								</span>
								<ChevronRightIcon aria-hidden="true" style={{ width: 16 }} />
							</button>
						))}
					</div>
				)}
			</section>
		</IonToolbar>
	);
}

export const SubagentsSection = observer(SubagentsSectionImpl);
