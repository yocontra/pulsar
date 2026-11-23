/**
 * Settings → "Prove Human" on the phone, the first row: whether this device
 * is proven (a green or amber shield and the status), and a tap opens the
 * sheet.
 */
import { ShieldAlertIcon, ShieldCheckIcon } from "lucide-react";
import { observer } from "../lib/signals.ts";
import { LinkRow, RowIcon } from "../mobile/ui/rows.tsx";
import { proveStatus } from "./ProveNav.tsx";
import { proveHuman } from "./state.ts";

function PhoneRowImpl() {
	const s = proveStatus();
	return (
		<LinkRow
			icon={
				<RowIcon tone={s.ok ? "green" : "orange"}>
					{s.ok ? <ShieldCheckIcon /> : <ShieldAlertIcon />}
				</RowIcon>
			}
			title="Prove Human"
			after={s.ok ? "Proven" : "Not Proven"}
			label={`Prove Human: ${s.text}`}
			onClick={() => void proveHuman("manual")}
			setting="prove-human"
		/>
	);
}
export const ProvePhoneRow = observer(PhoneRowImpl);
