/**
 * Ask: a question in plain words, answered from what Pulsar already knows
 * (nobody is woken), then optionally asked of the agents directly.
 */
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { AskPanel } from "../components/AskPanel.tsx";
import { BackButton } from "./BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";
import { IonLabel, IonList, IonSearchbar } from "./ionic-lazy.tsx";

const SUGGESTIONS = [
	"Who is editing src/auth/session.ts?",
	"Who has PR 1402?",
	"Who is idle on apparish?",
];

export default function AskPage() {
	const [q, setQ] = useState("");
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "ask" }} />
					</IonButtons>
					<IonTitle>Ask</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="p-ask">
				<IonHeader collapse="condense">
					<IonToolbar>
						<IonTitle size="large">Ask</IonTitle>
					</IonToolbar>
					<IonToolbar>
						<IonSearchbar
							className="p-search"
							placeholder="Ask about your agents"
							aria-label="Ask"
							value={q}
							debounce={0}
							enterkeyhint="search"
							onIonInput={(e) => setQ(e.detail.value ?? "")}
						/>
					</IonToolbar>
				</IonHeader>
				{!q.trim() ? (
					<>
						<div className="p-empty p-ask-empty">
							<SparklesIcon />
							<h3>Ask in Plain Words</h3>
							<p>
								Answers come from what Pulsar already knows, so no agent is
								interrupted.
							</p>
						</div>
						<IonList inset aria-label="Suggestions">
							{SUGGESTIONS.map((s, i) => (
								<IonItem
									key={s}
									button
									detail={false}
									lines={i === SUGGESTIONS.length - 1 ? "none" : "inset"}
									className="m-suggest"
									onClick={() => setQ(s)}
								>
									<IonLabel color="primary">{s}</IonLabel>
								</IonItem>
							))}
						</IonList>
					</>
				) : (
					<div className="p-ask-results">
						<AskPanel question={q} onClose={() => {}} />
					</div>
				)}
			</IonContent>
		</>
	);
}
