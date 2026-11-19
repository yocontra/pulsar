import { PlusIcon } from "lucide-react";
import { IonButton } from "../../mobile/ionic.ts";
import { openDraft } from "./open.ts";

/** Home's header on the phone: start a new agent. */
export default function PhoneButton() {
	return (
		<IonButton aria-label="New agent" onClick={() => openDraft()}>
			<PlusIcon />
		</IonButton>
	);
}
