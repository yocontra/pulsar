import { homedir } from "node:os";
import { join } from "node:path";
import { cliUndo, jsonAction, mcpCommand } from "../setup/actions.ts";
import { exists, getPath, readJsonc, runCli, which } from "../setup/files.ts";
import { piTurnFailed } from "../transcripts/turn-outcome.ts";
import {
	listOmpSubagents,
	ompSubagentStamp,
	ompSubagentTranscript,
} from "./more-subagents.ts";
import { ompActivity } from "./omp-activity.ts";
import { piAgentDir } from "./pi-paths.ts";
import { locatePiStyle, piSessionLog } from "./pi-sessions.ts";
import { parsePi } from "./pi-transcript.ts";
import { ompIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

export const omp: HarnessDriver = {
	...ompIdent,
	activity: ompActivity,

	// omp pads line 1 (the session title) and rewrites it in place: never read it.
	transcript: {
		locate: (agent) => locatePiStyle("omp", agent),
		parse: parsePi,
		turnFailed: piTurnFailed,
	},

	subagents: {
		stamp: ompSubagentStamp,
		list: listOmpSubagents,
		transcript: ompSubagentTranscript,
	},

	sessionLog: (agent) => piSessionLog("omp", agent),

	setup: {
		detect: (path) => !!which("omp", path) || exists(piAgentDir("omp")),
		configured: () =>
			!!getPath(readJsonc(join(piAgentDir("omp"), "mcp.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) => [
			...(ctx.mcp
				? [
						jsonAction(
							"omp",
							join(piAgentDir("omp"), "mcp.json"),
							["mcpServers", "pulsar"],
							{ type: "stdio", ...mcpCommand(ctx) },
						),
					]
				: []),
			{
				client: "omp",
				describe: `omp install ${ctx.installDir.replace(homedir(), "~")} (extension: push delivery, skill)`,
				apply: () => runCli("omp", ["install", ctx.installDir]),
				undo: cliUndo("omp", ["plugin", "uninstall", "pulsar"]),
			},
		],
	},
};
