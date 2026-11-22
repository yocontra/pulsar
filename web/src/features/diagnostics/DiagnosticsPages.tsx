/**
 * The Diagnostics page in each layout: the desktop's main pane (Esc goes
 * back) and the phone's pushed page. Both render `DiagnosticsView`.
 */
import { BackButton } from "../../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonTitle,
	IonToolbar,
} from "../../mobile/ionic.ts";
import { CheckStatus, DiagnosticsView } from "./DiagnosticsView.tsx";
import { useDiagnostics } from "./model.ts";

export function DiagnosticsDesktop() {
	const d = useDiagnostics();
	return (
		<main className="diag-page" aria-label="Diagnostics">
			<DiagnosticsView variant="desktop" d={d} />
		</main>
	);
}

export function DiagnosticsPhone() {
	const d = useDiagnostics();
	return (
		<>
			<IonHeader>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "page", name: "diagnostics" }} />
					</IonButtons>
					<IonTitle>
						<span className="p-nav-title">
							<h1>Diagnostics</h1>
						</span>
					</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent className="p-plain">
				<div className="diag-phone-bar">
					<CheckStatus d={d} />
				</div>
				<DiagnosticsView variant="phone" d={d} />
			</IonContent>
		</>
	);
}

export default DiagnosticsDesktop;
