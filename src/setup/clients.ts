import { cpSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	editJson,
	getPath,
	readJsonc,
	runCli,
	setTomlKey,
	tryCli,
	which,
} from "./files.ts";

/** What setup knows when it plans: where the stable copy lives and which node runs it. */
export interface SetupContext {
	node: string;
	installDir: string;
	cli: string;
	skillSource: string;
	mcp: boolean;
	skillsDir: string | null;
}

/** A recorded change, enough to undo it later. */
export type Undo =
	| { type: "json"; file: string; path: string[] }
	| { type: "cli"; cmd: string; args: string[] }
	| { type: "dir"; path: string };

export interface Action {
	client: string;
	describe: string;
	apply: () => void;
	undo: Undo;
}

export interface Client {
	id: string;
	label: string;
	detect: () => boolean;
	/** True when pulsar is already wired into this harness. */
	configured: () => boolean;
	plan: (ctx: SetupContext) => Action[];
}

const home = homedir();
const mcpCommand = (ctx: SetupContext) => ({
	command: ctx.node,
	args: [ctx.cli, "mcp"],
});

function jsonAction(
	client: string,
	file: string,
	path: string[],
	value: unknown,
): Action {
	return {
		client,
		describe: `set ${path.join(".")} in ${file.replace(home, "~")}`,
		apply: () => editJson(file, path, value),
		undo: { type: "json", file, path },
	};
}

function skillAction(client: string, dest: string, ctx: SetupContext): Action {
	return {
		client,
		describe: `install skill to ${dest.replace(home, "~")}`,
		apply: () => {
			rmSync(dest, { recursive: true, force: true });
			cpSync(ctx.skillSource, dest, { recursive: true });
		},
		undo: { type: "dir", path: dest },
	};
}

function skillFor(
	client: string,
	defaultDir: string,
	ctx: SetupContext,
): Action[] {
	if (ctx.skillsDir) return [];
	return [skillAction(client, join(defaultDir, "pulsar"), ctx)];
}

const claudeJson = join(home, ".claude.json");

export const CLIENTS: Client[] = [
	{
		id: "claude",
		label: "Claude Code",
		detect: () => !!which("claude") || existsSync(join(home, ".claude")),
		configured: () =>
			!!getPath(readJsonc(claudeJson), ["mcpServers", "pulsar"]),
		plan: (ctx) => [
			...(ctx.mcp
				? [
						{
							client: "claude",
							describe: "claude mcp add-json pulsar --scope user",
							apply: () => {
								tryCli("claude", [
									"mcp",
									"remove",
									"pulsar",
									"--scope",
									"user",
								]);
								runCli("claude", [
									"mcp",
									"add-json",
									"pulsar",
									JSON.stringify({ type: "stdio", ...mcpCommand(ctx) }),
									"--scope",
									"user",
								]);
							},
							undo: {
								type: "cli",
								cmd: "claude",
								args: ["mcp", "remove", "pulsar", "--scope", "user"],
							},
						} satisfies Action,
					]
				: []),
			{
				client: "claude",
				describe:
					'set crossSessionInbound: "accept" in ~/.claude/settings.json (lets messages from other agents reach sessions that skip permission prompts, without an approval dialog; they still cannot approve anything)',
				apply: () =>
					editJson(
						join(home, ".claude", "settings.json"),
						["crossSessionInbound"],
						"accept",
					),
				undo: {
					type: "json",
					file: join(home, ".claude", "settings.json"),
					path: ["crossSessionInbound"],
				},
			} satisfies Action,
			...skillFor("claude", join(home, ".claude", "skills"), ctx),
		],
	},
	{
		id: "codex",
		label: "Codex",
		detect: () => !!which("codex") || existsSync(join(home, ".codex")),
		configured: () => {
			try {
				return runCli("codex", ["mcp", "get", "pulsar"]).includes("pulsar");
			} catch {
				return false;
			}
		},
		plan: (ctx) => [
			...(ctx.mcp
				? [
						{
							client: "codex",
							describe: "codex mcp add pulsar",
							apply: () => {
								tryCli("codex", ["mcp", "remove", "pulsar"]);
								runCli("codex", [
									"mcp",
									"add",
									"pulsar",
									"--",
									ctx.node,
									ctx.cli,
									"mcp",
								]);
								// pulsar's tools only message other agents: approve them, and let ask/wait block past 60s.
								const toml = join(home, ".codex", "config.toml");
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"default_tools_approval_mode",
									'"approve"',
								);
								setTomlKey(
									toml,
									"mcp_servers.pulsar",
									"tool_timeout_sec",
									"1900",
								);
							},
							undo: {
								type: "cli",
								cmd: "codex",
								args: ["mcp", "remove", "pulsar"],
							},
						} satisfies Action,
					]
				: []),
			...skillFor("codex", join(home, ".codex", "skills"), ctx),
		],
	},
	{
		id: "opencode",
		label: "OpenCode",
		detect: () =>
			!!which("opencode") || existsSync(join(home, ".config", "opencode")),
		configured: () => {
			const cfg = readJsonc(opencodeConfig());
			return !!(
				getPath(cfg, ["mcp", "servers", "pulsar"]) ??
				getPath(cfg, ["mcp", "pulsar"])
			);
		},
		plan: (ctx) => {
			const file = opencodeConfig();
			const cfg = readJsonc(file);
			const mcp = getPath(cfg, ["mcp"]) as Record<string, unknown> | undefined;
			// OpenCode 2 nests servers under mcp.servers; older configs put them right under mcp.
			const path =
				!mcp || "servers" in mcp
					? ["mcp", "servers", "pulsar"]
					: ["mcp", "pulsar"];
			return [
				...(ctx.mcp
					? [
							jsonAction("opencode", file, path, {
								type: "local",
								command: [ctx.node, ctx.cli, "mcp"],
								enabled: true,
							}),
						]
					: []),
				...skillFor(
					"opencode",
					join(home, ".config", "opencode", "skills"),
					ctx,
				),
			];
		},
	},
	{
		id: "pi",
		label: "pi",
		detect: () => !!which("pi") || existsSync(join(home, ".pi", "agent")),
		configured: () =>
			JSON.stringify(
				readJsonc(join(home, ".pi", "agent", "settings.json")) ?? {},
			).includes("pulsar"),
		plan: (ctx) => [
			{
				client: "pi",
				describe: `pi install ${ctx.installDir.replace(home, "~")} (extension: push delivery, MCP tools, skill)`,
				apply: () => runCli("pi", ["install", ctx.installDir]),
				undo: { type: "cli", cmd: "pi", args: ["remove", ctx.installDir] },
			},
		],
	},
	{
		id: "omp",
		label: "omp",
		detect: () => !!which("omp") || existsSync(join(home, ".omp", "agent")),
		configured: () =>
			!!getPath(readJsonc(join(home, ".omp", "agent", "mcp.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) => [
			...(ctx.mcp
				? [
						jsonAction(
							"omp",
							join(home, ".omp", "agent", "mcp.json"),
							["mcpServers", "pulsar"],
							{ type: "stdio", ...mcpCommand(ctx) },
						),
					]
				: []),
			{
				client: "omp",
				describe: `omp install ${ctx.installDir.replace(home, "~")} (extension: push delivery, skill)`,
				apply: () => runCli("omp", ["install", ctx.installDir]),
				undo: {
					type: "cli",
					cmd: "omp",
					args: ["plugin", "uninstall", "pulsar"],
				},
			},
		],
	},
	{
		id: "cursor",
		label: "Cursor",
		detect: () => existsSync(join(home, ".cursor")),
		configured: () =>
			!!getPath(readJsonc(join(home, ".cursor", "mcp.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) =>
			ctx.mcp
				? [
						jsonAction(
							"cursor",
							join(home, ".cursor", "mcp.json"),
							["mcpServers", "pulsar"],
							mcpCommand(ctx),
						),
					]
				: [],
	},
	{
		id: "gemini",
		label: "Gemini CLI",
		detect: () => !!which("gemini") || existsSync(join(home, ".gemini")),
		configured: () =>
			!!getPath(readJsonc(join(home, ".gemini", "settings.json")), [
				"mcpServers",
				"pulsar",
			]),
		plan: (ctx) =>
			ctx.mcp
				? [
						jsonAction(
							"gemini",
							join(home, ".gemini", "settings.json"),
							["mcpServers", "pulsar"],
							mcpCommand(ctx),
						),
					]
				: [],
	},
];

function opencodeConfig(): string {
	const dir = join(home, ".config", "opencode");
	const jsonc = join(dir, "opencode.jsonc");
	return existsSync(jsonc) || !existsSync(join(dir, "opencode.json"))
		? jsonc
		: join(dir, "opencode.json");
}

export function undoAction(undo: Undo) {
	switch (undo.type) {
		case "json":
			editJson(undo.file, undo.path, undefined);
			return;
		case "cli":
			tryCli(undo.cmd, undo.args);
			return;
		case "dir":
			rmSync(undo.path, { recursive: true, force: true });
			return;
	}
}
