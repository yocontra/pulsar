import {
	antigravityHookCommand,
	antigravityHookPath,
	ANTIGRAVITY_HOOK_EVENTS as EVENTS,
	ANTIGRAVITY_HOOK_GROUP as GROUP,
	ANTIGRAVITY_HOOK_MARKER as MARKER,
} from "../harnesses/antigravity-hook-config.ts";
import type { HarnessDriver } from "../harnesses/types.ts";
import { updateNamedHook } from "./actions.ts";

/** Antigravity loads global hooks from config/hooks.json, separate from MCP. */
export function withAntigravityWake(
	setup: NonNullable<HarnessDriver["setup"]>,
): NonNullable<HarnessDriver["setup"]> {
	return {
		...setup,
		plan(ctx) {
			const file = antigravityHookPath();
			const hook = {
				type: "command" as const,
				command: antigravityHookCommand(ctx.node, ctx.cli),
				timeout: 5,
			};
			return [
				...setup.plan(ctx),
				...EVENTS.map((event) => ({
					client: "antigravity",
					describe: `add a ${event} hook in ~/.gemini/config/hooks.json for native message wake`,
					apply: () => updateNamedHook(file, GROUP, event, MARKER, hook),
					undo: {
						type: "hook" as const,
						file,
						group: GROUP,
						event,
						marker: MARKER,
					},
				})),
			];
		},
	};
}
