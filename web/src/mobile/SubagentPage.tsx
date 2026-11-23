/**
 * A subagent, pushed from its parent's page: the parent's name as the back
 * title, the subagent's name and state in the bar, its transcript and the
 * composer below (session/SubagentView.tsx).
 */
import { useRef } from "react";
import { useSubagent } from "../data/index.ts";
import { observer } from "../lib/signals.ts";
import { SubagentView } from "../session/SubagentView.tsx";
import { AgentBar, useUnderGlass } from "./AgentBar.tsx";
import { IonContent } from "./ionic.ts";
import { isMaterial } from "./platform.ts";

function SubagentPageImpl({ id }: { id: string }) {
	const sub = useSubagent(id).data;
	const content = useRef<HTMLIonContentElement | null>(null);
	useUnderGlass(content);
	return (
		<>
			<AgentBar
				route={{ view: "subagent", id }}
				name={sub?.name ?? "Subagent"}
				sub={
					sub && (
						<>
							{sub.state === "running"
								? "Running"
								: sub.state === "idle"
									? "Idle"
									: "Done"}
							{sub.agentType ? ` · ${sub.agentType}` : ""}
						</>
					)
				}
				compactBack={false}
				className="p-sub-header"
			/>
			<IonContent
				ref={content}
				scrollY={false}
				fullscreen={!isMaterial}
				className="p-plain p-agent"
			>
				<div className="p-agent-body">
					<SubagentView id={id} mobile bare />
				</div>
			</IonContent>
		</>
	);
}

export default observer(SubagentPageImpl);
