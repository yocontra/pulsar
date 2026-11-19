import type { PageProps } from "../../lib/registry.tsx";
import { BackButton } from "../../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../../mobile/ionic.ts";
import { Draft } from "./Draft.tsx";

/** The phone's full-screen draft: the same draft, its pickers as pages. */
export default function DraftPhone({ params }: PageProps) {
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "page", name: "new", params }} />
					</IonButtons>
					<IonTitle>New agent</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="ld-phone-content" scrollY={false}>
				<Draft params={params} mobile />
			</IonContent>
		</>
	);
}
