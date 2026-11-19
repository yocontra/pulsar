import { InboxIcon } from "lucide-react";
import { observer } from "../lib/signals.ts";
import { attention } from "../lib/store.ts";
import { openNeeds } from "./actions.ts";
import { BackButton } from "./BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { IonList } from "./ionic-lazy.tsx";
import { NeedsRowView } from "./rows.tsx";

function NeedsPageImpl() {
	const items = attention.value;
	const approvals = items.filter((i) => i.kind === "approval");
	const asked = items.filter((i) => i.kind === "asked");
	// Prompts only the agent's terminal answers: shown, not answerable here.
	const terminal = items.filter((i) => i.kind === "terminal");
	const group = (title: string, list: typeof items) =>
		list.length > 0 && (
			<section aria-label={title}>
				<h3 className="p-group-head">{title}</h3>
				<IonList inset className="p-set-list">
					{list.map((item, i) => (
						<IonItem
							key={item.id}
							button
							detail
							lines={i === list.length - 1 ? "none" : "inset"}
							className="p-attn"
							data-agent={item.agent.id}
							onClick={() => openNeeds(item)}
						>
							<NeedsRowView item={item} />
						</IonItem>
					))}
				</IonList>
			</section>
		);
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "needs" }} />
					</IonButtons>
					<IonTitle>Needs You</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="p-needs">
				<IonHeader collapse="condense">
					<IonToolbar>
						<IonTitle size="large">Needs You</IonTitle>
					</IonToolbar>
				</IonHeader>
				{items.length === 0 ? (
					<div className="p-empty">
						<InboxIcon />
						<h3>You're All Caught Up</h3>
						<p>
							When an agent asks for approval or has a question, it shows up
							here.
						</p>
					</div>
				) : (
					<>
						{group(
							approvals.length === 1 ? "Approval" : "Approvals",
							approvals,
						)}
						{group(asked.length === 1 ? "Question" : "Questions", asked)}
						{group("In the Terminal", terminal)}
					</>
				)}
			</IonContent>
		</>
	);
}
export default observer(NeedsPageImpl);
