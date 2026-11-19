import { IdsView } from "../components/chrome.tsx";
import { BackButton } from "./BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "./ionic.ts";

export default function IdsPage({ ids }: { ids: string[] }) {
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "ids", ids }} />
					</IonButtons>
					<IonTitle>
						{ids.length === 1 ? "1 Agent" : `${ids.length} Agents`}
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent scrollY={false} className="p-plain">
				<IdsView ids={ids} mobile />
			</IonContent>
		</>
	);
}
