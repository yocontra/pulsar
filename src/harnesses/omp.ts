import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { getPath, readJsonc, runCli } from "../setup/files.ts";
import { which } from "../util.ts";
import { piSessionLog } from "./pi-sessions.ts";
import type { HarnessDriver } from "./types.ts";

/** omp command lines (pi's matcher defers to this one: omp ships pi's packages). */
export function isOmpProcess(args: string): boolean {
	return /(^|\/)omp(\s|$)/.test(args) || args.includes("@oh-my-pi/");
}

/** The pulsar extension runs inside omp (its argv), not pi. */
export function isOmpHost(argv: string): boolean {
	return /oh-my-pi|(^|\/)omp(\s|$)/.test(argv);
}

export const omp: HarnessDriver = {
	id: "omp",
	label: "omp",

	matchProcess: isOmpProcess,

	// Push goes through the pulsar extension; omp reports idle with `agent_end`.
	extension: {
		isHost: isOmpHost,
		idleEvents: ["agent_settled", "agent_end"],
	},

	sessionLog: (agent) => piSessionLog(".omp", agent.cwd),

	setup: {
		detect: () =>
			!!which("omp") || existsSync(join(homedir(), ".omp", "agent")),
		configured: () =>
			!!getPath(readJsonc(join(homedir(), ".omp", "agent", "mcp.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) => [
			...(ctx.mcp
				? [
						jsonAction(
							"omp",
							join(homedir(), ".omp", "agent", "mcp.json"),
							["mcpServers", "pulsar"],
							{ type: "stdio", ...mcpCommand(ctx) },
						),
					]
				: []),
			{
				client: "omp",
				describe: `omp install ${ctx.installDir.replace(homedir(), "~")} (extension: push delivery, skill)`,
				apply: () => runCli("omp", ["install", ctx.installDir]),
				undo: {
					type: "cli",
					cmd: "omp",
					args: ["plugin", "uninstall", "pulsar"],
				},
			},
		],
	},
};
