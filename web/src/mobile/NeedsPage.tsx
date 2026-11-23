/**
 * The Needs You tab: approvals, questions and terminal waits, each group an
 * inset list (Konsta) of the same rows as Home's needs summary. A tap opens
 * the approval or the agent. The tab's badge counts the same items.
 */
import { InboxIcon } from "lucide-react";
import { observer } from "../lib/signals.ts";
import { attention } from "../lib/store.ts";
import { openNeeds } from "./actions.ts";
import { NeedsRowView } from "./rows.tsx";
import { GroupedList, ListItem } from "./ui/GroupedList.tsx";
import { TabShell } from "./ui/PageShell.tsx";

function NeedsPageImpl() {
	const items = attention.value;
	const approvals = items.filter((i) => i.kind === "approval");
	const asked = items.filter((i) => i.kind === "asked");
	// Prompts only the agent's terminal answers: shown, not answerable here.
	const terminal = items.filter((i) => i.kind === "terminal");
	const group = (title: string, list: typeof items) =>
		list.length > 0 && (
			<GroupedList title={title}>
				{list.map((item) => (
					<ListItem
						key={item.id}
						link
						linkComponent="button"
						className="p-attn"
						contentClassName="p-li-button"
						titleWrapClassName="p-attn-wrap"
						data-agent={item.agent.id}
						linkProps={{ type: "button", onClick: () => openNeeds(item) }}
						title={<NeedsRowView item={item} />}
					/>
				))}
			</GroupedList>
		);
	return (
		<TabShell title="Needs You" className="p-needs" testId="needs">
			{items.length === 0 ? (
				<div className="p-empty" data-testid="needs-empty">
					<InboxIcon aria-hidden="true" />
					<h3>Nothing needs you.</h3>
					<p>
						When an agent asks for approval or has a question, it shows up here.
					</p>
				</div>
			) : (
				<>
					{group(approvals.length === 1 ? "Approval" : "Approvals", approvals)}
					{group(asked.length === 1 ? "Question" : "Questions", asked)}
					{group("In the Terminal", terminal)}
				</>
			)}
		</TabShell>
	);
}
export default observer(NeedsPageImpl);
