import { Fab } from "konsta/react";
import { PlusIcon } from "lucide-react";
import { openDraft } from "./open.ts";

/** Home on Android: Material's floating action button above the bottom nav. */
export default function PhoneFab() {
	return (
		<Fab
			className="p-fab"
			aria-label="New agent"
			icon={<PlusIcon />}
			onClick={() => openDraft()}
		/>
	);
}
