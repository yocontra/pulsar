import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readJsonc, runCli, tryCli } from "../setup/files.ts";
import { which } from "../util.ts";
import { isOmpHost, isOmpProcess } from "./omp.ts";
import { piSessionLog } from "./pi-sessions.ts";
import type { HarnessDriver } from "./types.ts";

export const pi: HarnessDriver = {
	id: "pi",
	label: "pi",

	matchProcess(args) {
		if (isOmpProcess(args)) return false;
		return (
			args.includes("pi-coding-agent") ||
			/(^|\/)pi(\s|$)/.test(args.split(/\s+/).slice(0, 2).join(" "))
		);
	},

	// Push goes through the pulsar extension. pi is its default host.
	extension: {
		isHost: (argv) => !isOmpHost(argv),
		idleEvents: ["agent_settled"],
	},

	sessionLog: (agent) => piSessionLog(".pi", agent.cwd),

	setup: {
		detect: () => !!which("pi") || existsSync(join(homedir(), ".pi", "agent")),
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
					for (const entry of existsSync(root) ? readdirSync(root) : []) {
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
