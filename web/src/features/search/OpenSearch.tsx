import { SearchIcon } from "lucide-react";
import { navigate } from "../../lib/router.ts";
import { IonButton } from "../../mobile/ionic.ts";

/** Home's header button to the phone's message search. */
export default function OpenSearch() {
	return (
		<IonButton
			aria-label="Search messages"
			onClick={() => navigate({ view: "page", name: "search" })}
		>
			<SearchIcon />
		</IonButton>
	);
}
