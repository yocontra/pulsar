/**
 * The Diagnostics page on the phone, pushed from Settings: an inline-title
 * bar (PageShell), when this machine was last checked, and every machine's
 * report as a card on the grouped background.
 */
import { PageShell } from "../../mobile/ui/PageShell.tsx";
import { CheckStatus, DiagnosticsView } from "./DiagnosticsView.tsx";
import { useDiagnostics } from "./model.ts";

export function DiagnosticsPhone() {
	const d = useDiagnostics();
	return (
		<PageShell
			title="Diagnostics"
			route={{ view: "page", name: "diagnostics" }}
			large={false}
			className="diag-phone-page"
			testId="diagnostics"
		>
			<div className="diag-phone-bar">
				<CheckStatus d={d} />
			</div>
			<DiagnosticsView variant="phone" d={d} />
		</PageShell>
	);
}

export default DiagnosticsPhone;
