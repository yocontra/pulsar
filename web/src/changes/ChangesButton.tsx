/** The phone agent page's "Changes (N)" button: opens the changes page. */
import { FileDiffIcon } from "lucide-react";
import { navigate } from "../lib/router.ts";
import { IonButton } from "../mobile/ionic.ts";
import { useChangesPeek } from "./data.ts";
import "./changes-button.css";

export function ChangesButton({ id }: { id: string }) {
	const peek = useChangesPeek(id).data;
	const n = peek?.available ? peek.total : 0;
	return (
		<IonButton
			className="p-changes-btn"
			aria-label={n ? `Changes (${n})` : "Changes"}
			onClick={() => navigate({ view: "changes", id })}
		>
			<FileDiffIcon aria-hidden="true" />
			{n > 0 && <span className="p-changes-n">{n}</span>}
		</IonButton>
	);
}
