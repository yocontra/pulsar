import { lazyBody } from "./lazy.ts";
import type { HarnessUi } from "./types.ts";

/** OpenCode. */
export const opencode: HarnessUi = {
	id: "opencode",
	title(approval) {
		return approval.tool === "question" ? "OpenCode asks" : null;
	},
	name: "OpenCode",
	// Mark: Simple Icons 16.36.0 (CC0), icons/opencode.svg.
	icon: {
		viewBox: "-2.5 -2.5 29 29",
		paths: ["M22 24H2V0h20zM17 4.8H7v14.4h10z"],
	},
	toolCards: {
		bash: { Body: lazyBody("CommandBody") },
		todowrite: { Body: lazyBody("TodoBody") },
		question: { Body: lazyBody("QuestionBody") },
	},
};
