import { PlusIcon } from "lucide-react";
import { IonButton } from "../../mobile/ionic.ts";
import { isMaterial } from "../../mobile/platform.ts";
import { openDraft } from "./open.ts";

/** Home's header on iOS: start a new agent (Android has the FAB). */
export default function PhoneButton() {
	if (isMaterial) return null;
	return (
		<IonButton aria-label="New agent" onClick={() => openDraft()}>
			<PlusIcon />
		</IonButton>
	);
}
