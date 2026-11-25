import { homedir } from "node:os";
import { join } from "node:path";
import { jsonAction, mcpCommand } from "../setup/actions.ts";
import { exists, getPath, readJsonc, which } from "../setup/files.ts";
import type { HarnessManifest, McpConfig } from "./catalog.ts";
import type { HarnessDriver } from "./types.ts";

/** A user-scoped stdio entry in the harness's own config. */
export function mcpSetup(
	h: HarnessManifest,
	config: McpConfig,
): NonNullable<HarnessDriver["setup"]> {
	const file = () => join(homedir(), config.file);
	const key = ["mcpServers", "pulsar"];
	return {
		detect: (path) =>
			!!which(h.bin, path) ||
			exists(join(homedir(), config.directory)) ||
			exists(file()),
		configured: () => !!getPath(readJsonc(file()), key),
		plan: (ctx) =>
			ctx.mcp
				? [
						jsonAction(h.id, file(), key, {
							...mcpCommand(ctx),
							env: { PULSAR_HARNESS: h.id },
							...(config.localType ? { type: "local", tools: ["*"] } : {}),
						}),
					]
				: [],
	};
}
