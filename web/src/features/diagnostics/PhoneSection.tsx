/** Settings → "Diagnostics" on the phone: a row that opens the page. */
import { StethoscopeIcon } from "lucide-react";
import { navigate } from "../../lib/router.ts";
import { IonItem } from "../../mobile/ionic.ts";
import { IonLabel } from "../../mobile/ionic-lazy.tsx";

export default function PhoneSection() {
	return (
		<IonItem
			button
			detail
			onClick={() => navigate({ view: "page", name: "diagnostics" })}
			data-setting="diagnostics"
		>
			<span className="p-set-icon is-blue" slot="start" aria-hidden="true">
				<StethoscopeIcon />
			</span>
			<IonLabel>Check Every Machine</IonLabel>
		</IonItem>
	);
}
