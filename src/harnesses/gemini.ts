import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { getPath, readJsonc } from "../setup/files.ts";
import { which } from "../util.ts";
import type { HarnessDriver } from "./types.ts";

/** Pull only: messages wait in the inbox. */
export const gemini: HarnessDriver = {
	id: "gemini",
	label: "Gemini CLI",

	matchProcess(args) {
		const exe = basename(args.split(/\s+/)[0] ?? "").toLowerCase();
		return exe === "gemini" || args.includes("@google/gemini-cli");
	},

	setup: {
		detect: () => !!which("gemini") || existsSync(join(homedir(), ".gemini")),
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
