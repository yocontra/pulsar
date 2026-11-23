/**
 * A message to an explicit list of agents (`#/ids`, "message non-repliers"):
 * the scope's preview and composer under the platform's top bar.
 */
import { IdsView } from "../components/chrome.tsx";
import { PageShell } from "./ui/PageShell.tsx";

export default function IdsPage({ ids }: { ids: string[] }) {
	return (
		<PageShell
			title={ids.length === 1 ? "1 Agent" : `${ids.length} Agents`}
			route={{ view: "ids", ids }}
			large={false}
			scrollY={false}
			className="p-plain"
		>
			<IdsView ids={ids} mobile />
		</PageShell>
	);
}
