import type { PageProps } from "../../lib/registry.tsx";
import { PageShell } from "../../mobile/ui/PageShell.tsx";
import { Draft } from "./Draft.tsx";

/** The phone's full-screen draft: the same draft, its pickers as pages. */
export default function DraftPhone({ params }: PageProps) {
	return (
		<PageShell
			title="New agent"
			route={{ view: "page", name: "new", params }}
			large={false}
			scrollY={false}
			className="ld-phone-content"
		>
			<Draft params={params} mobile />
		</PageShell>
	);
}
