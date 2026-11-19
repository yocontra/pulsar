import { useEffect } from "react";
import { signal } from "./signals.ts";

/**
 * Actions in flight that closing a dialog would lose: a passkey ceremony, a
 * send. While above zero, backdrops, Escape, swipes and the close X don't
 * close the dialog or sheet that holds them.
 */
export const inFlight = signal(0);

/** Count an action as in flight while `active` is true. */
export function useInFlight(active: boolean) {
	useEffect(() => {
		if (!active) return;
		inFlight.value++;
		return () => {
			inFlight.value--;
		};
	}, [active]);
}
