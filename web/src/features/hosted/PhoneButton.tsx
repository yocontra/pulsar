import { CloudIcon } from "lucide-react";
import { IonButton } from "../../mobile/ionic.ts";

export default function PhoneButton({ open }: { open: () => void }) {
	return (
		<IonButton aria-label="Hosted agents" onClick={open}>
			<CloudIcon />
		</IonButton>
	);
}
