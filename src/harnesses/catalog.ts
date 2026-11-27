import { ACP_PROVIDERS } from "./acp-catalog.ts";
// Data shared by the daemon, the per-session MCP process and the browser.
// Keep this module free of filesystem, process and UI imports.
export interface McpConfig {
	file: string;
	directory: string;
	localType?: boolean;
}

export interface HarnessManifest {
	id: string;
	label: string;
	bin: string;
	launch?: true;
	usage?: "claude" | "codex" | "pi" | "omp";
	mcp?: McpConfig;
}

const builtins = [
	{
		id: "claude",
		label: "Claude Code",
		bin: "claude",
		launch: true,
		usage: "claude",
	},
	{ id: "codex", label: "Codex", bin: "codex", launch: true, usage: "codex" },
	{ id: "opencode", label: "OpenCode", bin: "opencode", launch: true },
	{ id: "pi", label: "pi", bin: "pi", launch: true, usage: "pi" },
	{ id: "omp", label: "omp", bin: "omp", launch: true, usage: "omp" },
	{
		id: "cursor",
		label: "Cursor",
		bin: "cursor-agent",
		mcp: { directory: ".cursor", file: ".cursor/mcp.json" },
	},
	{
		id: "copilot",
		label: "GitHub Copilot",
		bin: "copilot",
		mcp: {
			directory: ".copilot",
			file: ".copilot/mcp-config.json",
			localType: true,
		},
	},
	{
		id: "antigravity",
		label: "Google Antigravity",
		bin: "agy",
		mcp: {
			directory: ".gemini/antigravity-cli",
			file: ".gemini/config/mcp_config.json",
		},
	},
	{ id: "vscode", label: "VS Code", bin: "code" },
] as const satisfies readonly HarnessManifest[];

const managed = ACP_PROVIDERS.map((p) => ({
	id: p.id,
	label: p.label,
	bin: p.binary,
	launch: true as const,
	managed: true as const,
}));
export const HARNESSES = [
	...builtins,
	...managed.filter((p) => !builtins.some((b) => b.id === p.id)),
];
const nativeLaunch = builtins.filter((h) => "launch" in h);
export const launchable = [
	...nativeLaunch,
	...managed.filter((p) => !nativeLaunch.some((h) => h.id === p.id)),
];
export type Launchable = (typeof launchable)[number];
export const usageHarnesses = builtins.flatMap((h) =>
	"usage" in h ? [h.usage] : [],
);
