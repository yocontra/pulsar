import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { getPath, readJsonc } from "../setup/files.ts";
import type { HarnessDriver } from "./types.ts";

/** Pull only: messages wait in the inbox. */
export const cursor: HarnessDriver = {
	id: "cursor",
	label: "Cursor",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "cursor" || args.includes("Cursor.app");
	},

	setup: {
		detect: () => existsSync(join(homedir(), ".cursor")),
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
