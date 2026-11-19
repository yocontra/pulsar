import { ChevronLeftIcon } from "lucide-react";
import { back, type Route } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { IonButton } from "./ionic.ts";
import { backTitle } from "./titles.ts";

/**
 * iOS back button: chevron and the previous page's title. It pops through
 * lib/router (history), which animates IonNav back; swipe-back pops IonNav
 * directly and history follows (stack.tsx).
 */
function BackButtonImpl({ route }: { route: Route }) {
	const title = backTitle(route);
	return (
		<IonButton className="p-back" aria-label="Back" onClick={() => back()}>
			<ChevronLeftIcon aria-hidden="true" />
			<span>{title}</span>
		</IonButton>
	);
}

export const BackButton = observer(BackButtonImpl);
