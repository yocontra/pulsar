import type { DaemonClient } from "./client.ts";

export interface ControlContext {
	isIdle?(): boolean;
	abort?(): void;
	/**
	 * omp: its session modes (plan, vibe, goal, loop), from outside the TUI.
	 * `set` answers `{ok, error?}` (`busy`, `conflict`, `disabled`, ...).
	 */
	sessionModes?: {
		getState?(): Record<string, unknown> | null | undefined;
		set?(req: {
			mode: string;
			action: "enter" | "exit";
		}):
			| Promise<{ ok?: boolean; error?: unknown; message?: unknown }>
			| { ok?: boolean; error?: unknown; message?: unknown };
	};
}

export interface ControlApi {
	/**
	 * pi: runs input as if typed (extension commands, prompt templates,
	 * `/skill:name`) when `expandPromptTemplates` is set and the session is
	 * idle. omp's never runs commands.
	 */
	sendUserMessage?(text: string, options?: Record<string, unknown>): unknown;
	/** pi and omp: extension commands, prompt templates and skills. */
	getCommands?(): Array<{
		name?: string;
		description?: string;
		source?: string;
		sourceInfo?: { path?: string };
	}>;
}

/**
 * The extension's answer to a `control` request from the daemon
 * (src/service/controls.ts): its commands, omp's plan mode, or a command
 * line to run (pi only, while idle).
 */
export async function answerControl(
	req: { kind?: string; mode?: string; line?: string },
	host: {
		pi: ControlApi;
		ctx: ControlContext | undefined;
		harness: string;
	},
): Promise<Record<string, unknown>> {
	const { pi, ctx, harness } = host;
	if (req.kind === "commands") {
		const list = pi.getCommands?.() ?? [];
		return {
			result: "ok",
			commands: list.slice(0, 500).map((c) => ({
				name: c.name,
				description: c.description,
				source: c.source,
				path: c.sourceInfo?.path,
			})),
		};
	}
	if (req.kind === "mode.get" || req.kind === "mode.set") {
		const modes = ctx?.sessionModes;
		if (!modes?.getState || !modes.set)
			return {
				result: "unsupported",
				detail: `${harness} has no mode control here`,
			};
		const planOn = () => {
			const plan = modes.getState?.()?.plan as unknown;
			const status =
				typeof plan === "object" && plan
					? (plan as { status?: unknown }).status
					: plan;
			return (
				status === true ||
				status === "active" ||
				status === "on" ||
				status === "enabled"
			);
		};
		if (req.kind === "mode.get")
			return { result: "ok", mode: planOn() ? "plan" : "default" };
		const want = req.mode === "plan";
		if (planOn() !== want) {
			const r = await modes.set({
				mode: "plan",
				action: want ? "enter" : "exit",
			});
			if (!r?.ok) {
				const code = String(r?.error ?? "failed");
				return {
					result:
						code === "busy"
							? "busy"
							: code === "disabled"
								? "unsupported"
								: "failed",
					detail: typeof r?.message === "string" ? r.message : code,
					mode: planOn() ? "plan" : "default",
				};
			}
		}
		return { result: "ok", mode: planOn() ? "plan" : "default" };
	}
	if (req.kind === "command" && typeof req.line === "string") {
		if (harness !== "pi" || !pi.sendUserMessage)
			return {
				result: "unsupported",
				detail: `${harness} runs commands only when typed in its terminal`,
			};
		// With `deliverAs` (a run in progress) pi takes it as plain text.
		if (ctx?.isIdle && !ctx.isIdle())
			return {
				result: "busy",
				detail: "pi runs a turn; send the command when it is idle",
			};
		pi.sendUserMessage(req.line, { expandPromptTemplates: true });
		return { result: "ok" };
	}
	return { result: "unsupported", detail: "unknown request" };
}

/** Use the host context bound to this extension connection when Stop arrives. */
export function registerExtensionControls(
	client: Pick<DaemonClient, "on" | "call">,
	harness: string,
	pi: ControlApi,
	context: () => ControlContext | undefined,
) {
	client.on("interrupt", (data) => {
		const { requestId } = data as { requestId: string };
		let result: "interrupted" | "not-running" | "unsupported" = "unsupported";
		let detail: string | undefined;
		try {
			const ctx = context();
			if (!ctx?.abort || !ctx.isIdle) detail = "this host has no abort";
			else if (ctx.isIdle()) result = "not-running";
			else {
				ctx.abort();
				result = "interrupted";
			}
		} catch (e) {
			detail = (e as Error).message;
		}
		client
			.call("interrupt_result", { requestId, result, detail })
			.catch(() => {});
	});

	// Modes and slash commands from the app (src/service/controls.ts). The
	// daemon asks; this answers once with `control_result`.
	client.on("control", (data) => {
		const req = data as {
			requestId: string;
			kind?: string;
			mode?: string;
			line?: string;
		};
		void (async (): Promise<Record<string, unknown>> => {
			try {
				const ctx = context();
				if (!ctx)
					return { result: "unsupported", detail: "No active session context" };
				return await answerControl(req, { pi, ctx, harness });
			} catch (e) {
				return { result: "failed", detail: (e as Error).message };
			}
		})().then((answer) =>
			client
				.call("control_result", { requestId: req.requestId, ...answer })
				.catch(() => {}),
		);
	});
}
