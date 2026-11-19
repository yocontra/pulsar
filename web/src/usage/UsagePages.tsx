/**
 * The usage page in each layout: the desktop's main pane (Esc goes back)
 * and the phone's pushed page. Both render the same `UsageView`.
 */
import { BackButton } from "../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../mobile/ionic.ts";
import { UsageView } from "./UsageView.tsx";

/** The desktop's main pane; the shell's Esc goes back (a sheet closes first). */
export function UsageDesktop() {
	return (
		<main className="usage-page" aria-label="Usage">
			<UsageView variant="desktop" />
		</main>
	);
}

export function UsagePhone() {
	return (
		<>
			<IonHeader>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "page", name: "usage" }} />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>Usage</h1>
						</span>
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent className="p-plain">
				<UsageView variant="phone" />
			</IonContent>
		</>
	);
}

export default UsageDesktop;
