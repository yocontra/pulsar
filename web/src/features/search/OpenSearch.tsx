import { SearchIcon } from "lucide-react";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { IonButton } from "../../mobile/ionic.ts";

/** Home's header button to the phone's message search (hidden when it is off). */
function OpenSearch() {
	if (!can("search")) return null;
	return (
		<IonButton
			aria-label="Search messages"
			onClick={() => navigate({ view: "page", name: "search" })}
		>
			<SearchIcon />
		</IonButton>
	);
}

export default observer(OpenSearch);
