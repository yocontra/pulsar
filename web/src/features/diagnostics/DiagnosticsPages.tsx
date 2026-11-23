/**
 * The Diagnostics page on the desktop: the main pane (Esc goes back). The
 * phone's pushed page is PhonePage.tsx. Both render `DiagnosticsView`.
 */
import { DiagnosticsView } from "./DiagnosticsView.tsx";
import { useDiagnostics } from "./model.ts";

export function DiagnosticsDesktop() {
	const d = useDiagnostics();
	return (
		<main className="diag-page" aria-label="Diagnostics">
			<DiagnosticsView variant="desktop" d={d} />
		</main>
	);
}

export default DiagnosticsDesktop;
