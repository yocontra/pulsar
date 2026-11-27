/**
 * Mock modes and slash commands (`GET /agents/:id/modes`, `/commands`;
 * `POST /mode`, `/command`): the daemon's mode lists and built-in commands
 * (src/service/controls.ts MODES, src/harnesses/builtins.ts), a few custom
 * commands and skills, and a per-agent mode that a switch changes. Runs are
 * kept so e2e tests can read what reached the "terminal"
 * (`GET /__mock/commands`).
 */
import { builtinsFor } from "../../src/harnesses/builtins.ts";
import type {
	AgentModes,
	CommandCatalog,
	CommandEntry,
	ControlResult,
} from "../../src/http/wire.ts";
import { MODES, parseCommand } from "../../src/service/controls.ts";

/** What the mock needs of an agent. */
type AgentRow = { id: string; harness: string };

const modeOf = new Map<string, string>();
export const ranCommands: Array<{ agent: string; line: string }> = [];

/** Agents of these harnesses run "outside tmux" in the mock: nothing can run. */
const NOT_IN_TMUX = new Set(["cursor", "copilot"]);

const CUSTOM: CommandEntry[] = [
	{
		name: "ship",
		description: "Tag and ship a release",
		source: "project",
		args: "<version>",
	},
	{
		name: "standup",
		description: "Write my standup from today's commits",
		source: "user",
	},
	{
		name: "gh:review",
		description: "Review a PR the way reviewers will",
		source: "plugin",
		skill: true,
		plugin: "gh",
		args: "[pr]",
	},
	{
		name: "humanizer",
		description: "Rewrite text so it reads as written by a person",
		source: "user",
		skill: true,
	},
];

const defaultMode = (harness: string) => MODES[harness]?.[0]?.id ?? null;

export function mockModes(a: AgentRow): AgentModes {
	const modes = MODES[a.harness] ?? [];
	if (!modes.length)
		return {
			agentId: a.id,
			modes: [],
			current: null,
			live: false,
			canSwitch: false,
			reason: "This harness has no modes Pulsar can switch.",
		};
	return {
		agentId: a.id,
		modes,
		current: modeOf.get(a.id) ?? defaultMode(a.harness),
		live: true,
		canSwitch: true,
		...(a.harness === "opencode"
			? { note: "Switching may not update the terminal view." }
			: {}),
	};
}

export function mockCommands(a: AgentRow): CommandCatalog {
	const builtins = builtinsFor(a.harness, null);
	const commands: CommandEntry[] = [
		...(builtins?.commands ?? []).map(
			(b): CommandEntry => ({
				name: b.name,
				description: b.description,
				source: "builtin",
				...(b.args ? { args: b.args } : {}),
				...(b.dialog ? { dialog: true } : {}),
			}),
		),
		...CUSTOM,
	];
	const runnable = !NOT_IN_TMUX.has(a.harness);
	return {
		agentId: a.id,
		harness: a.harness,
		commands,
		runnable,
		...(runnable
			? {}
			: {
					reason:
						"The agent does not run in tmux, so Pulsar cannot reach its terminal.",
				}),
	};
}

export function mockSetMode(a: AgentRow, mode: string): ControlResult {
	const modes = MODES[a.harness] ?? [];
	if (!modes.some((m) => m.id === mode))
		return {
			agentId: a.id,
			result: "unsupported",
			via: a.harness,
			detail: `no mode ${mode}`,
		};
	modeOf.set(a.id, mode);
	return { agentId: a.id, result: "ok", via: "tmux", mode };
}

export function mockRun(a: AgentRow, line: string): ControlResult {
	if (!parseCommand(line))
		return {
			agentId: a.id,
			result: "failed",
			via: "pulsar",
			detail: "A command is one line: / and a name, then its arguments.",
		};
	if (NOT_IN_TMUX.has(a.harness))
		return {
			agentId: a.id,
			result: "unsupported",
			via: "tmux",
			detail:
				"The agent does not run in tmux, so Pulsar cannot reach its terminal.",
		};
	ranCommands.push({ agent: a.id, line });
	return { agentId: a.id, result: "ok", via: "tmux" };
}
