/**
 * The usage page on the desktop: the main pane (Esc goes back). The phone's
 * Usage tab is UsagePhone.tsx.
 */
import { UsageView } from "./UsageView.tsx";

/** The desktop's main pane; the shell's Esc goes back (a sheet closes first). */
export function UsageDesktop() {
	return (
		<main className="usage-page" aria-label="Usage">
			<UsageView />
		</main>
	);
}

export default UsageDesktop;
