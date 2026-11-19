import type { HarnessUi } from "./types.ts";

/** VS Code agents (detected only). */
export const vscode: HarnessUi = {
	id: "vscode",
	name: "VS Code",
	// Mark: drawn for Pulsar (angle brackets); no logo licensed for this use.
	icon: {
		viewBox: "1.5 1.5 21 21",
		stroke: true,
		paths: ["M8.5 6.5 3 12l5.5 5.5", "M15.5 6.5 21 12l-5.5 5.5"],
	},
};
