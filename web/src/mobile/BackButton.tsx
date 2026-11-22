import { ArrowLeftIcon, ChevronLeftIcon } from "lucide-react";
import { back, hrefFor, type Route, stack } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { IonButton } from "./ionic.ts";
import { isMaterial } from "./platform.ts";
import { pagesOf } from "./stack.tsx";
import { backTitle } from "./titles.ts";

/**
 * iOS back button: chevron and the previous page's title (Android: an
 * arrow). It pops through
 * lib/router (history), which animates IonNav back; swipe-back pops IonNav
 * directly and history follows (stack.tsx).
 */
function BackButtonImpl({
	route,
	compact = false,
}: {
	route: Route;
	/** Chevron only: a top bar whose title needs the room (the agent page). */
	compact?: boolean;
}) {
	// A tab's root page has nothing under it (the tab bar switches tabs).
	const first = pagesOf(stack.value)[0];
	if (first && hrefFor(first) === hrefFor(route)) return null;
	// Android: Material's back arrow, without the previous title.
	if (isMaterial)
		return (
			<IonButton
				className="p-back is-md"
				aria-label="Back"
				onClick={() => back()}
			>
				<ArrowLeftIcon aria-hidden="true" />
			</IonButton>
		);
	const title = backTitle(route);
	return (
		<IonButton
			className={compact ? "p-back is-compact" : "p-back"}
			aria-label={compact && title ? `Back to ${title}` : "Back"}
			onClick={() => back()}
		>
			<ChevronLeftIcon aria-hidden="true" />
			{!compact && <span>{title}</span>}
		</IonButton>
	);
}

export const BackButton = observer(BackButtonImpl);
