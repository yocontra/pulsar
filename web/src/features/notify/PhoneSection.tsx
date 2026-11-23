/**
 * Settings → "Agent activity" on the phone: rows in the group Settings
 * draws (Konsta, mobile/ui/rows.tsx). The mode opens an action sheet; the
 * in-app note is a switch. State is shared with the desktop (Section.tsx).
 */
import { BellRingIcon, EyeIcon, MessageSquareIcon } from "lucide-react";
import { observer } from "../../lib/signals.ts";
import { showActions } from "../../mobile/ui/actions.ts";
import { LinkRow, NoteRow, RowIcon, ToggleRow } from "../../mobile/ui/rows.tsx";
import { inApp, MODES, previews, shownMode, subscribed } from "./prefs.ts";
import { HELP, useAgentActivity } from "./Section.tsx";
import "./notify.css";

function PhoneImpl() {
	const { error, busy, choose, toggleInApp, togglePreviews } =
		useAgentActivity();
	const current = shownMode();
	const pick = async () => {
		await showActions({
			header: "When an agent finishes or fails",
			subHeader: HELP,
			buttons: [
				...MODES.map(([value, label]) => ({
					text: value === current ? `${label} ✓` : label,
					handler: () => void choose(value),
				})),
				{ text: "Cancel", role: "cancel" },
			],
		});
	};
	return (
		<>
			<LinkRow
				icon={
					<RowIcon tone="red">
						<BellRingIcon />
					</RowIcon>
				}
				title="Finished or Failed"
				after={MODES.find(([m]) => m === current)?.[1]}
				disabled={busy}
				onClick={() => void pick()}
				setting="agent-activity"
			/>
			{error && <NoteRow alert>{error}</NoteRow>}
			<ToggleRow
				icon={
					<RowIcon tone="blue">
						<MessageSquareIcon />
					</RowIcon>
				}
				title="In-App Notifications"
				checked={inApp.value}
				onChange={(on) => void toggleInApp(on)}
				setting="in-app-notifications"
			/>
			{subscribed.value && (
				<ToggleRow
					icon={
						<RowIcon tone="gray">
							<EyeIcon />
						</RowIcon>
					}
					title="Show Previews on Lock Screen"
					checked={previews.value}
					onChange={(on) => void togglePreviews(on)}
					setting="notification-previews"
				/>
			)}
		</>
	);
}

export const PhoneSection = observer(PhoneImpl);
