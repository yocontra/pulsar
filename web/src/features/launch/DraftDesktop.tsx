import type { PageProps } from "../../lib/registry.tsx";
import { Draft } from "./Draft.tsx";

/** `#/new?machine=&project=&cwd=` on the desktop: the draft in the session pane. */
export default function DraftDesktop({ params }: PageProps) {
	return (
		<div className="d-session ld-desktop">
			<header className="d-session-head session-header">
				<div className="d-sh-id">
					<div className="d-sh-line1">
						<h1 className="d-sh-name">New agent</h1>
					</div>
				</div>
			</header>
			<Draft
				key={`${params.machine ?? ""} ${params.project ?? ""} ${params.cwd ?? ""}`}
				params={params}
				mobile={false}
			/>
		</div>
	);
}
