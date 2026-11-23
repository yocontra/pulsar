/**
 * Settings → "Usage limits" on the phone: a switch, the thresholds (an
 * action sheet of presets; a computer can set any) and the help, as rows in
 * the group Settings draws (Konsta, mobile/ui/rows.tsx).
 */
import { BellRingIcon, GaugeIcon } from "lucide-react";
import { showActions } from "../../mobile/ui/actions.ts";
import { LinkRow, NoteRow, RowIcon, ToggleRow } from "../../mobile/ui/rows.tsx";
import { HELP, PRESETS, show, useSettings } from "./Section.tsx";
import "./limits.css";

export function PhoneSection() {
	const { settings, loaded, error, save } = useSettings();
	const edit = async () => {
		const now = settings.thresholds.join();
		await showActions({
			header: "Warn at",
			subHeader: "Other percentages can be set in Settings on a computer.",
			buttons: [
				...PRESETS.map((t) => ({
					text: t.join() === now ? `${show(t)} ✓` : show(t),
					handler: () => void save({ thresholds: t }),
				})),
				{ text: "Cancel", role: "cancel" },
			],
		});
	};
	return (
		<>
			<ToggleRow
				icon={
					<RowIcon tone="red">
						<BellRingIcon />
					</RowIcon>
				}
				title="Usage Limit Warnings"
				checked={settings.enabled}
				disabled={!loaded}
				onChange={(on) => void save({ enabled: on })}
				setting="usage-limits"
			/>
			<LinkRow
				icon={
					<RowIcon tone="blue">
						<GaugeIcon />
					</RowIcon>
				}
				title="Warn At"
				after={show(settings.thresholds)}
				disabled={!loaded || !settings.enabled}
				onClick={() => void edit()}
				setting="usage-limit-thresholds"
			/>
			<NoteRow alert={Boolean(error)}>{error ?? HELP}</NoteRow>
		</>
	);
}
