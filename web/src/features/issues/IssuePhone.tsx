/**
 * The phone's issue sheet. No top-bar button (the bar is full): the agent
 * menu's "Issue #N" (`showIssue`, from the ••• button or a long-press)
 * opens it. Rendered in the agent header's slot, it shows nothing else.
 */
import { useState } from "react";
import type { AgentRow } from "../../api/types.ts";
import { observer } from "../../lib/signals.ts";
import { SheetShell } from "../../mobile/ui/SheetShell.tsx";
import { IssueCard, useAsked } from "./IssueCard.tsx";
import "./issues.css";

type Props = { agent: AgentRow; mobile: boolean; number: string };

function IssuePhone({ agent, number }: Props) {
	const [open, setOpen] = useState(false);
	// Mounted from the first open until it has animated out.
	const [mounted, setMounted] = useState(false);
	const show = () => {
		setMounted(true);
		setOpen(true);
	};
	useAsked(agent.id, show);
	return mounted ? (
		<SheetShell
			open={open}
			onClose={() => setOpen(false)}
			onClosed={() => setMounted(false)}
			title={`Issue #${number}`}
			detents={[0, 0.7, 1]}
			initial={0.7}
			className="i-modal"
			testId="issue-sheet"
		>
			<div className="p-sheet-pad">
				<IssueCard agent={agent} number={number} mobile />
			</div>
		</SheetShell>
	) : null;
}

export default observer(IssuePhone);
