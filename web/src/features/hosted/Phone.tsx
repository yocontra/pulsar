import { PageShell } from "../../mobile/ui/PageShell.tsx";
import { HostedView } from "./HostedView.tsx";

export default function HostedPhone() {
	return (
		<PageShell
			title="Hosted agents"
			route={{ view: "page", name: "hosted" }}
			large={false}
			testId="hosted"
		>
			<HostedView />
		</PageShell>
	);
}
