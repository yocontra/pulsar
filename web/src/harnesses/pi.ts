import { lazyBody } from "./lazy.ts";
import type { HarnessUi } from "./types.ts";

/** pi. */
export const pi: HarnessUi = {
	id: "pi",
	name: "pi",
	// Mark: Simple Icons 16.36.0 (CC0), icons/pi.svg.
	icon: {
		viewBox: "-2.5 -2.5 29 29",
		paths: ["M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z"],
	},
	toolCards: {
		bash: { Body: lazyBody("CommandBody") },
	},
};
