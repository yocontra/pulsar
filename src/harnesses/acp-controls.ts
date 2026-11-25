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
			description: command.description.slice(0, 300),
			...(command.input?.hint
				? { args: command.input.hint.slice(0, 160) }
				: {}),
		},
	];
}

type Selection = { current: string; modes: ModeOption[]; configId?: string };

export class AcpSessionControls {
	private configured: Selection | null = null;
	private legacy: Selection | null = null;
	commands: CommandEntry[] = [];

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

	private config(options: SessionConfigOption[]) {
		const option = options.find(
			(item) => item.category === "mode" && item.type === "select",
		);
		if (option?.type !== "select") {
			this.configured = null;
			return;
		}
		const values = option.options.flatMap((item) =>
			"options" in item ? item.options : [item],
		);
		this.configured = {
			configId: option.id,
			current: option.currentValue,
			modes: values
				.slice(0, 100)
				.flatMap((item) => modeOption(item.value, item.name, item.description)),
		};
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

	async select(agent: ClientContext, sessionId: string, target: string) {
		const selection = this.selection;
		if (!selection?.modes.some((item) => item.id === target)) {
			return {
				result: "unsupported",
				detail: "The agent did not advertise this ACP mode.",
			};
		}
		if (selection.current === target) return { result: "ok", mode: target };
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
