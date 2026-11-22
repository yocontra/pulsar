/**
 * Settings → "Diagnostics" on a computer: opens the Diagnostics page.
 * Nothing runs until the page opens (each machine runs doctor then). The
 * phone's row is PhoneSection.tsx.
 */
import { navigate } from "../../lib/router.ts";

export default function DesktopSection({ close }: { close: () => void }) {
	return (
		<ul className="d-card d-set-card" data-section="diagnostics">
			<li className="d-set-row">
				<span className="d-set-text">
					<span className="d-set-label">Check every machine</span>
					<span className="d-set-help">
						Run pulsar doctor on every machine: problems and how to fix them,
						versions, Tailscale and certificates.
					</span>
				</span>
				<button
					type="button"
					className="d-btn"
					onClick={() => {
						// Settings is a layer over the page: close it first.
						close();
						navigate({ view: "page", name: "diagnostics" });
					}}
				>
					Open diagnostics
				</button>
			</li>
		</ul>
	);
}
