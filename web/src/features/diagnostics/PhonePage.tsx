/**
 * The Diagnostics page on the phone, pushed from Settings: an inline-title
 * bar (PageShell) over Konsta grouped lists (PhoneView.tsx).
 */
import { PageShell } from "../../mobile/ui/PageShell.tsx";
import { useDiagnostics } from "./model.ts";
import { DiagnosticsPhoneView } from "./PhoneView.tsx";

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
			<DiagnosticsPhoneView d={d} />
		</PageShell>
	);
}

export default DiagnosticsPhone;
