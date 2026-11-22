import { homedir } from "node:os";
import { join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { exists, getPath, readJsonc, which } from "../setup/files.ts";
import { geminiIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

/** Pull only: messages wait in the inbox. */
export const gemini: HarnessDriver = {
	...geminiIdent,

	setup: {
		detect: (path) =>
			!!which("gemini", path) || exists(join(homedir(), ".gemini")),
		configured: () =>
			!!getPath(readJsonc(join(homedir(), ".gemini", "settings.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) =>
			ctx.mcp
				? [
						jsonAction(
							"gemini",
							join(homedir(), ".gemini", "settings.json"),
							["mcpServers", "pulsar"],
							mcpCommand(ctx),
						),
					]
				: [],
	},
};
