import { lazyBody } from "./lazy.ts";
import type { HarnessUi } from "./types.ts";

/** Codex. */
export const codex: HarnessUi = {
	id: "codex",
	title(approval) {
		if (approval.tool === "request_user_input") return "Codex asks";
		return "Codex approval";
	},
	name: "Codex",
	// Mark: drawn for Pulsar (a C around a prompt chevron); OpenAI publishes
	// no logo licensed for this use.
	icon: {
		viewBox: "2.5 2.5 19 19",
		stroke: true,
		paths: ["M18.2 7.4a8 8 0 1 0 0 9.2", "M9.5 9.2 12.3 12l-2.8 2.8"],
	},
	toolCards: {
		// Code mode: a TypeScript script that calls tools. Its
		// tools.exec_command calls show as commands, the script under them.
		exec: { kind: "shell", Body: lazyBody("CommandBody") },
		exec_command: { Body: lazyBody("CommandBody") },
		shell: { Body: lazyBody("CommandBody") },
		local_shell: { Body: lazyBody("CommandBody") },
		apply_patch: { Body: lazyBody("PatchBody") },
		update_plan: { Body: lazyBody("TodoBody") },
	},
};
