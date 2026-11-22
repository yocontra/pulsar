/**
 * The desktop session header's issue chip: "#1378" opens the issue card in
 * a popover. The sidebar's menu (`showIssue`) opens it too.
 */
import { CircleDotIcon } from "lucide-react";
import { Popover } from "radix-ui";
import { useState } from "react";
import type { AgentRow } from "../../api/types.ts";
import { observer } from "../../lib/signals.ts";
import { IssueCard, useAsked } from "./IssueCard.tsx";
import "./issues.css";

type Props = { agent: AgentRow; mobile: boolean; number: string };

function IssueDesktop({ agent, number }: Props) {
	const [open, setOpen] = useState(false);
	useAsked(agent.id, () => setOpen(true));
	return (
		<Popover.Root open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="d-btn sm i-chip"
					aria-label={`Issue #${number}`}
					title={`Issue #${number}`}
				>
					<CircleDotIcon aria-hidden="true" />#{number}
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					className="i-pop"
					align="end"
					sideOffset={6}
					aria-label={`Issue #${number}`}
				>
					{open && <IssueCard agent={agent} number={number} mobile={false} />}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

export default observer(IssueDesktop);
