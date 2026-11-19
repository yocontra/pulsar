import { homedir } from "node:os";
import { join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { exists, getPath, readJsonc } from "../setup/files.ts";
import { cursorIdent } from "./simple-ident.ts";
import type { HarnessDriver } from "./types.ts";

/** Pull only: messages wait in the inbox. */
export const cursor: HarnessDriver = {
	...cursorIdent,

	setup: {
		detect: () => exists(join(homedir(), ".cursor")),
		configured: () =>
			!!getPath(readJsonc(join(homedir(), ".cursor", "mcp.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) =>
			ctx.mcp
				? [
						jsonAction(
							"cursor",
							join(homedir(), ".cursor", "mcp.json"),
							["mcpServers", "pulsar"],
							mcpCommand(ctx),
						),
					]
				: [],
	},
};
