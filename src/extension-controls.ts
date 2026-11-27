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
		path?: string;
	}>;
}

/**
 * The extension's answer to a `control` request from the daemon
 * (src/service/controls.ts): its commands, omp's plan mode, or a command
 * line to run while idle. OMP exposes installed skills by file path.
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
				path: c.sourceInfo?.path ?? c.path,
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
		if (!pi.sendUserMessage || (harness !== "pi" && harness !== "omp"))
			return { result: "unsupported", detail: "This host cannot submit input" };
		if (ctx?.isIdle && !ctx.isIdle())
			return {
				result: "busy",
				detail: "Send the command when the session is idle",
			};
		let submission: unknown;
		if (harness === "omp") {
			const [, name, args] = /^\/(\S+)(?:\s+(.+))?$/.exec(req.line) ?? [];
			const entry = pi
				.getCommands?.()
				.find((c) => c.name === name && c.source === "skill");
			if (!entry?.path)
				return {
					result: "unsupported",
					detail: "This command needs the OMP terminal",
				};
			submission = pi.sendUserMessage(
				`Read the installed skill at ${JSON.stringify(entry.path)} and follow its instructions.${args ? `\n\nUser request: ${args}` : ""}`,
			);
		} else {
			submission = pi.sendUserMessage(req.line, {
				expandPromptTemplates: true,
			});
		}
		// Some host APIs resolve after the whole model turn. Report receipt once
		// the session becomes busy, without timing out a long skill invocation.
		if (
			submission &&
			typeof (submission as PromiseLike<unknown>).then === "function" &&
			ctx?.isIdle
		) {
			let timer: ReturnType<typeof setInterval> | undefined;
			try {
				await Promise.race([
					Promise.resolve(submission),
					new Promise<void>((resolve, reject) => {
						const start = Date.now();
						timer = setInterval(() => {
							try {
								if (!ctx.isIdle?.()) resolve();
								else if (Date.now() - start >= 3500)
									reject(
										new Error(
											"The host did not confirm that it started the command.",
										),
									);
							} catch (error) {
								reject(error);
							}
						}, 50);
					}),
				]);
			} finally {
				clearInterval(timer);
			}
		} else {
			await submission;
		}
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
