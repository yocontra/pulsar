/**
 * A subagent, pushed from its parent's page: the parent's name as the back
 * title, the subagent's name and state in the bar, its transcript and the
 * composer below (session/SubagentView.tsx).
 */
import { useSubagent } from "../data/index.ts";
import { observer } from "../lib/signals.ts";
import { SubagentView } from "../session/SubagentView.tsx";
import { BackButton } from "./BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";

function SubagentPageImpl({ id }: { id: string }) {
	const sub = useSubagent(id).data;
	return (
		<>
			<IonHeader className="p-agent-header p-sub-header">
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "subagent", id }} />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>{sub?.name ?? "Subagent"}</h1>
							{sub && (
								<span className="p-nav-sub">
									{sub.state === "running"
										? "Running"
										: sub.state === "idle"
											? "Idle"
											: "Done"}
									{sub.agentType ? ` · ${sub.agentType}` : ""}
								</span>
							)}
						</span>
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent scrollY={false} className="p-plain p-agent">
				<div className="p-agent-body">
					<SubagentView id={id} mobile bare />
				</div>
			</IonContent>
		</>
	);
}

export default observer(SubagentPageImpl);
