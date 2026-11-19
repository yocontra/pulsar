/** Home's header button to the usage page (phone). */
import { ChartColumnIcon } from "lucide-react";
import { navigate } from "../lib/router.ts";
import { IonButton } from "../mobile/ionic.ts";

export default function UsagePhoneButton() {
	return (
		<IonButton
			aria-label="Usage"
			onClick={() => navigate({ view: "page", name: "usage" })}
		>
			<ChartColumnIcon />
		</IonButton>
	);
}
