import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessDriver } from "../harnesses/types.ts";
import { updateNamedHook } from "./actions.ts";

const GROUP = "pulsar-native-wake";
const MARKER = " hook antigravity-session";
const EVENTS = ["SessionStart", "PreInvocation"];
const shellQuote = (text: string) =>
	/^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;

/** Antigravity loads global hooks from config/hooks.json, separate from MCP. */
export function withAntigravityWake(
	setup: NonNullable<HarnessDriver["setup"]>,
): NonNullable<HarnessDriver["setup"]> {
	return {
		...setup,
		plan(ctx) {
			const file = join(homedir(), ".gemini", "config", "hooks.json");
			const hook = {
				type: "command" as const,
				command: `exec ${shellQuote(ctx.node)} ${shellQuote(ctx.cli)}${MARKER}`,
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
