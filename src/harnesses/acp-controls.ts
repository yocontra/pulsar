import type {
	AvailableCommand,
	ClientContext,
	SessionConfigOption,
	SessionModeState,
	SessionUpdate,
} from "@agentclientprotocol/sdk";
import type { CommandEntry, ModeOption } from "../http/wire.ts";

const CALL_TIMEOUT_MS = 4000;

export function validAcpModeId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length <= 128 &&
		!!id.trim() &&
		!/\p{Cc}/u.test(id)
	);
}

function modeOption(
	id: string,
	label: string,
	hint?: string | null,
): ModeOption[] {
	if (!validAcpModeId(id)) return [];
	return [
		{
			id,
			label: label.slice(0, 120),
			...(hint ? { hint: hint.slice(0, 300) } : {}),
		},
	];
}

function commandEntry(command: AvailableCommand): CommandEntry[] {
	if (!/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/.test(command.name)) return [];
	return [
		{
			name: command.name,
			source: "agent",
			...(command.name.startsWith("skill:") ? { skill: true } : {}),
			description: command.description.slice(0, 300),
			...(command.input?.hint
				? { args: command.input.hint.slice(0, 160) }
				: {}),
		},
	];
}

export type AcpSelectorCommand = "model" | "effort";
type Selection = { current: string; modes: ModeOption[]; configId?: string };

function configSelection(
	options: SessionConfigOption[],
	category: "mode" | "model" | "thought_level",
): Selection | null {
	const option = options.find(
		(item) => item.category === category && item.type === "select",
	);
	if (option?.type !== "select" || !validAcpModeId(option.id)) return null;
	const values = option.options.flatMap((item) =>
		"options" in item ? item.options : [item],
	);
	return {
		configId: option.id,
		current: option.currentValue,
		modes: values
			.slice(0, 100)
			.flatMap((item) => modeOption(item.value, item.name, item.description)),
	};
}

export class AcpSessionControls {
	private configured: Selection | null = null;
	private legacy: Selection | null = null;
	private selectors: Record<AcpSelectorCommand, Selection | null> = {
		model: null,
		effort: null,
	};
	commands: CommandEntry[] = [];
	model: string | null = null;

	get selection(): Selection | null {
		return this.configured ?? this.legacy;
	}

	install(response?: {
		modes?: SessionModeState | null;
		configOptions?: SessionConfigOption[] | null;
	}) {
		const { modes, configOptions } = response ?? {};
		if (modes) {
			this.legacy = {
				current: modes.currentModeId,
				modes: modes.availableModes
					.slice(0, 100)
					.flatMap((item) => modeOption(item.id, item.name, item.description)),
			};
		}
		if (configOptions) this.config(configOptions);
	}

	current(kind: AcpSelectorCommand): string | null {
		return this.selectors[kind]?.current ?? null;
	}

	commandChoices(
		command: AcpSelectorCommand,
	): { value: string; label: string }[] {
		return (
			this.selectors[command]?.modes.flatMap(({ id, label }) =>
				id === id.trim() ? [{ value: id, label }] : [],
			) ?? []
		);
	}

	catalog(): CommandEntry[] {
		const entries = new Map(this.commands.map((entry) => [entry.name, entry]));
		for (const name of ["model", "effort"] as const) {
			const argumentChoices = this.commandChoices(name);
			if (!argumentChoices.length) continue;
			const native = entries.get(name);
			const label = name === "model" ? "model" : "reasoning effort";
			const selected = argumentChoices.find(
				({ value }) => value === this.selectors[name]?.current,
			);
			const detail = native
				? `Choose the ${label}, or run /${name} alone for the provider command.`
				: `Choose the ${label}.`;
			entries.set(name, {
				...native,
				name,
				source: "agent",
				args: name === "model" ? "<model>" : "<level>",
				argumentChoices,
				...(selected ? { currentArgument: selected.value } : {}),
				description: selected
					? `${detail} Current: ${selected.label}.`
					: detail,
			});
		}
		return [...entries.values()];
	}

	private config(options: SessionConfigOption[]) {
		this.selectors.model = configSelection(options, "model");
		this.selectors.effort = configSelection(options, "thought_level");
		if (validAcpModeId(this.selectors.model?.current))
			this.model = this.selectors.model.current;
		this.configured = configSelection(options, "mode");
	}

	commandHelp(command: AcpSelectorCommand): string {
		const ids = this.commandChoices(command).map(({ value }) => value);
		const listed = ids.slice(0, 8).join(", ");
		return `Use /${command} <id>. Available: ${listed}${ids.length > 8 ? `, and ${ids.length - 8} more` : ""}`;
	}

	update(update: SessionUpdate): boolean {
		switch (update.sessionUpdate) {
			case "available_commands_update":
				this.commands = update.availableCommands
					.slice(0, 500)
					.flatMap(commandEntry);
				return true;
			case "config_option_update":
				this.config(update.configOptions);
				return true;
			case "current_mode_update":
				if (this.legacy)
					this.legacy = { ...this.legacy, current: update.currentModeId };
				return true;
			default:
				return false;
		}
	}

	async select(
		agent: ClientContext,
		sessionId: string,
		target: string,
		kind: "mode" | AcpSelectorCommand = "mode",
	) {
		const selection = kind === "mode" ? this.selection : this.selectors[kind];
		if (!selection?.modes.some((item) => item.id === target)) {
			return {
				result: "unsupported",
				detail:
					kind !== "mode"
						? this.commandHelp(kind)
						: "The agent did not advertise this ACP mode.",
			};
		}
		if (selection.current === target)
			return kind !== "mode"
				? { result: "ok" }
				: { result: "ok", mode: target };
		const options = {
			cancellationSignal: AbortSignal.timeout(CALL_TIMEOUT_MS),
			stopWaitingOnCancel: true,
		};
		if (selection.configId) {
			const result = await agent.request(
				"session/set_config_option",
				{
					sessionId,
					configId: selection.configId,
					value: target,
				},
				options,
			);
			this.config(result.configOptions);
		} else {
			await agent.request(
				"session/set_mode",
				{ sessionId, modeId: target },
				options,
			);
			if (this.legacy === selection)
				this.legacy = { ...selection, current: target };
		}
		if (kind !== "mode") {
			return this.selectors[kind]?.current === target
				? { result: "ok" }
				: {
						result: "failed",
						detail: `The ACP agent did not report the selected ${kind}.`,
					};
		}
		const mode = this.selection?.current;
		return mode === target
			? { result: "ok", mode }
			: {
					result: "failed",
					mode,
					detail: "The ACP agent did not report the selected mode.",
				};
	}
}
