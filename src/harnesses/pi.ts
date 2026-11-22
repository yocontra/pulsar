import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	exists,
	listDir,
	readJsonc,
	runCli,
	tryCli,
	which,
} from "../setup/files.ts";
import { piTurnFailed } from "../transcripts/turn-outcome.ts";
import { locatePiStyle, piSessionLog } from "./pi-sessions.ts";
import { parsePi } from "./pi-transcript.ts";
import { piIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

export const pi: HarnessDriver = {
	...piIdent,

	transcript: {
		locate: (agent) => locatePiStyle("pi", agent),
		parse: parsePi,
		turnFailed: piTurnFailed,
	},

	sessionLog: (agent) => piSessionLog(".pi", agent.cwd),

	setup: {
		detect: (path) =>
			!!which("pi", path) || exists(join(homedir(), ".pi", "agent")),
		configured: () =>
			JSON.stringify(
				readJsonc(join(homedir(), ".pi", "agent", "settings.json")) ?? {},
			).includes("pulsar"),
		plan: (ctx) => [
			{
				client: "pi",
				describe: `pi install ${ctx.installDir.replace(homedir(), "~")} (extension: push delivery, MCP tools, skill)`,
				apply: () => {
					// pi keys packages by path: drop earlier pulsar paths so the extension loads once.
					const root = dirname(ctx.installDir);
					for (const entry of listDir(root)) {
						const path = join(root, entry);
						if (path !== ctx.installDir) tryCli("pi", ["remove", path]);
					}
					runCli("pi", ["install", ctx.installDir]);
				},
				undo: { type: "cli", cmd: "pi", args: ["remove", ctx.installDir] },
			},
		],
	},
};
