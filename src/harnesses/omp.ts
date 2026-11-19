import { homedir } from "node:os";
import { join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { exists, getPath, readJsonc, runCli, which } from "../setup/files.ts";
import { piTurnFailed } from "../transcripts/turn-outcome.ts";
import {
	listOmpSubagents,
	ompSubagentStamp,
	ompSubagentTranscript,
} from "./more-subagents.ts";
import { piSessionFile, piSessionLog } from "./pi-sessions.ts";
import { parsePi } from "./pi-transcript.ts";
import { ompIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

export const omp: HarnessDriver = {
	...ompIdent,

	// omp pads line 1 (the session title) and rewrites it in place: never read it.
	transcript: {
		async locate(agent) {
			const file = await piSessionFile(".omp", agent.cwd, agent.sessionId);
			return file ? { kind: "file", path: file, headerLine: true } : null;
		},
		parse: parsePi,
		turnFailed: piTurnFailed,
	},

	subagents: {
		stamp: ompSubagentStamp,
		list: listOmpSubagents,
		transcript: ompSubagentTranscript,
	},

	sessionLog: (agent) => piSessionLog(".omp", agent.cwd),

	setup: {
		detect: () => !!which("omp") || exists(join(homedir(), ".omp", "agent")),
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
