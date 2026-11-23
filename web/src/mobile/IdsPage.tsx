/**
 * A message to an explicit list of agents (`#/ids`, "message non-repliers"):
 * the agents as an inset list with "N agents" as its footer, and the
 * composer docked at the bottom.
 */
import { Composer } from "../components/Composer.tsx";
import { useAgents } from "../components/ScopeView.tsx";
import { num, plural } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { AgentRowView } from "./rows.tsx";
import { GroupedList, ListItem } from "./ui/GroupedList.tsx";
import { PageShell } from "./ui/PageShell.tsx";

const SHOWN = 12;

export default function IdsPage({ ids }: { ids: string[] }) {
	const page = useAgents({ ids }, SHOWN);
	const label = plural(ids.length, "selected agent");
	const more = ids.length - (page?.items.length ?? 0);
	return (
		<PageShell
			title={ids.length === 1 ? "1 Agent" : `${num(ids.length)} Agents`}
			route={{ view: "ids", ids }}
			large={false}
			className="p-ids"
			testId="ids-page"
			footer={
				<div className="p-ids-dock">
					<Composer
						key={ids.join(",")}
						target={{ kind: "ids", ids, label }}
						compact
						autofocus={false}
					/>
				</div>
			}
		>
			<GroupedList
				title="Sent by id"
				label="Agents"
				footer={
					<span data-testid="ids-footer">
						{plural(ids.length, "agent")}
						{page && more > 0 ? ` · ${num(more)} more not shown` : ""}
					</span>
				}
			>
				{page
					? page.items.map((a) => (
							<ListItem
								key={a.id}
								className="p-ids-row"
								link
								linkComponent="button"
								title={<AgentRowView a={a} withPlace />}
								onClick={() => navigate({ view: "agent", id: a.id })}
							/>
						))
					: [0, 1, 2].map((i) => (
							<ListItem key={i} title={<span className="p-sk p-sk-line" />} />
						))}
			</GroupedList>
		</PageShell>
	);
}
