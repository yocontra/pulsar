/**
 * Pulsar extension for pi and omp.
 *
 * pi and omp have no outside door into a running session, so this extension
 * opens one: it keeps a connection to the pulsar daemon and injects messages
 * with `sendMessage`, waking an idle session. It also reports busy/idle, and
 * on pi it registers the pulsar MCP server so the agent gets the tools too.
 */
import { fileURLToPath } from "node:url";
import { DaemonClient } from "./client.ts";
import {
	type PlanReviewEvent,
	planPrompt,
	type Relay,
	type RelayResult,
	relayUi,
} from "./extension-interactions.ts";
import {
	isOmpChild,
	type OmpChildApi,
	type OmpChildContext,
	ompChildMessaging,
} from "./extension-omp.ts";
import { gitInfoAsync } from "./git.ts";
import { extensionHostFor } from "./harnesses/ident.ts";
import { daemonLog } from "./log.ts";
import { autoTags, envTags } from "./tags.ts";
import type { DeliveredMessage, Registration } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

/** The part of the context pi and omp pass to event handlers that Stop uses. */
interface HostContext extends OmpChildContext {
	/** No agent run (or compaction, on pi) in progress. */
	isIdle?(): boolean;
	/** Starts aborting the current run; returns before it finishes. */
	abort?(): void;
	/** omp: the session's background jobs (subagents, evals, bash). */
	getAsyncJobSnapshot?(): {
		running?: Array<{ type?: string }>;
	} | null;
	/**
	 * pi 1.5 and omp: the session's own id, stable across a restart (resume),
	 * and its name (`/name`, `/rename`, omp's generated title). omp's header
	 * says who set the name (`titleSource`).
	 */
	sessionManager?: {
		getSessionId?(): string | undefined;
		getSessionFile?(): string | undefined;
		getSessionName?(): string | undefined;
		getHeader?(): { titleSource?: string } | null | undefined;
	};
	/** The host's dialogs (shared with its own tools on omp); relayed to the app. */
	ui?: Record<string, unknown>;
	hasUI?: boolean;
	/** omp: which agent this session runs; subagents share the host process. */
	agent?: { kind?: string };
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
	/** omp: answers the open plan review as if picked in it. */
	resolvePlanReview?(
		reviewId: string,
		choice: string,
		input?: { feedback?: string },
	): boolean;
}

/**
 * Background work still running after a turn ends: omp `task` (subagent) and
 * `eval` jobs. Background bash jobs (a dev server) are not work: they could
 * keep the agent busy forever.
 */
export function backgroundWork(ctx: HostContext | undefined): number {
	try {
		const running = ctx?.getAsyncJobSnapshot?.()?.running ?? [];
		return running.filter((j) => j.type !== "bash").length;
	} catch {
		// A stale context (pi, after a session switch) throws.
		return 0;
	}
}

/**
 * The host session's name and who set it: omp's header says (`titleSource`;
 * none means its generated title), pi names a session only on `/name`.
 * An empty name: the session has none. null: the host could not say.
 */
export function hostSessionName(
	harness: string,
	ctx: HostContext | undefined,
	api: { getSessionName?(): string | undefined },
): { name: string; source: "user" | "auto" } | null {
	try {
		const name =
			(
				ctx?.sessionManager?.getSessionName?.() ?? api.getSessionName?.()
			)?.trim() ?? "";
		const set = ctx?.sessionManager?.getHeader?.()?.titleSource;
		const source =
			set === "user" || set === "auto"
				? set
				: harness === "omp"
					? "auto"
					: "user";
		return { name: name.slice(0, 200), source };
	} catch {
		// A stale context (pi, after a session switch) throws.
		return null;
	}
}

/**
 * How a host's "turn ended" event ends the run. omp sends extensions one
 * `agent_end` per stopped model loop: `willContinue` marks a loop whose run
 * goes on (a retry, compaction or reminder turn, queued input), plus
 * `awaitingAsyncWork` when only background work can resume it. Only an
 * `agent_end` without `willContinue` (or pi's `agent_settled`) ends the run.
 */
export function endKind(event: unknown): "continues" | "awaits" | "ends" {
	const e = event as { willContinue?: boolean; awaitingAsyncWork?: boolean };
	if (e?.willContinue !== true) return "ends";
	return e.awaitingAsyncWork === true ? "awaits" : "continues";
}

/** Status tracing for debugging busy/idle (PULSAR_DEBUG_STATUS=1). */
const traceStatus = (line: string) => {
	if (process.env.PULSAR_DEBUG_STATUS === "1") daemonLog(`status: ${line}`);
};

/** The subset of the pi / omp ExtensionAPI this extension uses. */
interface HostApi extends OmpChildApi {
	on(
		event: string,
		handler: (event: unknown, ctx: HostContext | undefined) => unknown,
	): void;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { triggerTurn?: boolean; deliverAs?: string },
	): unknown;
	/** pi and omp: the session's display name. */
	getSessionName?(): string | undefined;
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
	registerMcpServer?: (
		name: string,
		config: { command: string; args: string[]; env?: Record<string, string> },
	) => void;
}

/**
 * The extension's answer to a `control` request from the daemon
 * (src/service/controls.ts): its commands, omp's plan mode, or a command
 * line to run (pi only, while idle).
 */
export async function answerControl(
	req: { kind?: string; mode?: string; line?: string },
	host: {
		pi: Pick<HostApi, "getCommands" | "sendUserMessage">;
		ctx: HostContext | undefined;
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

export default function pulsarExtension(
	pi: HostApi,
	opts: {
		jobPollMs?: number;
		/** How long a run omp said continues may stay quiet before it counts as ended. */
		continueGraceMs?: number;
		/** How long background bash jobs that can resume a paused run keep it busy. */
		bashGraceMs?: number;
	} = {},
) {
	const jobPollMs = opts.jobPollMs ?? 3000;
	const continueGraceMs = opts.continueGraceMs ?? 120_000;
	const bashGraceMs = opts.bashGraceMs ?? 300_000;
	// The executable path too: a host built as one Bun binary (omp) has only
	// `bun /$bunfs/root/<entry>` in its argv.
	const host = extensionHostFor(
		[process.execPath, process.argv0, ...process.argv].join(" "),
	);
	const harness = host?.id ?? "unknown";
	const child = harness === "omp" ? ompChildMessaging(pi) : null;
	const isSub = isOmpChild;
	let boundChild = false;
	let boundParent = false;
	if (child) pi.on("tool_call", (event, c) => child.blockParentMcp(event, c));
	const client = new DaemonClient();
	let stopped = false;
	// The host session's id: the agent id is the pid, so this is what lets
	// tracked messages follow a restarted (resumed) session.
	let resumeKey: string | undefined;
	// The host session's name, as last reported (sent again with each hello).
	let named: { name: string; source: "user" | "auto" } | null = null;

	const registration = async (): Promise<Registration> => {
		const cwd = process.cwd();
		const git = await gitInfoAsync(cwd, { lane: "user" });
		return {
			harness,
			// pid-based identity: the MCP server finds the same pid as its parent.
			sessionId: null,
			pid: process.pid,
			cwd,
			project: git.project,
			branch: git.branch,
			tags: [...autoTags(harness, git), ...envTags()],
			role: "extension",
			...(resumeKey ? { resumeKey } : {}),
			...(named
				? {
						meta: {
							harnessName: named.name,
							harnessNameSource: named.source,
						},
					}
				: {}),
		};
	};

	/** Best effort: skipped while the daemon is away; a failed call is ignored. */
	const notify = (method: string, params: unknown) => {
		if (client.connected) client.call(method, params).catch(() => {});
	};

	// Acks lost with a dropped connection; each is sent once more after reconnect.
	const pendingAcks = new Set<string>();

	function ack(messageId: string, retry: boolean) {
		client.call("ack", { messageId, via: "extension" }).catch((e) => {
			if (retry) pendingAcks.add(messageId);
			else
				daemonLog(
					`extension ack for ${messageId} failed: ${(e as Error).message}`,
				);
		});
	}

	async function connect() {
		if (stopped) return;
		await client.connect(true);
		try {
			const reg = await registration();
			if (stopped) return client.close();
			await client.call("hello", {
				protocol: PROTOCOL_VERSION,
				version: VERSION,
				registration: reg,
			});
			if (stopped) return client.close();
		} catch (e) {
			// Refused: close this connection, never keep it open while retrying.
			client.close();
			throw e;
		}
		for (const id of pendingAcks) ack(id, false);
		pendingAcks.clear();
		// A new daemon (restart, upgrade) knows nothing of a turn in progress.
		if (status) client.call("set_status", { status }).catch(() => {});
	}

	// One reconnect loop at a time, backing off exponentially (with jitter);
	// a refused hello (session claimed by another process) backs off longer.
	let reconnecting = false;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let failures = 0;
	function reconnectLater() {
		if (stopped || reconnecting) return;
		reconnecting = true;
		const base = Math.min(500 * 2 ** failures, 30_000);
		reconnectTimer = setTimeout(
			() => {
				reconnectTimer = null;
				connect()
					.then(() => {
						failures = 0;
						reconnecting = false;
					})
					.catch((e) => {
						failures +=
							(e as { code?: string }).code === "session_claimed" ? 3 : 1;
						failures = Math.min(failures, 10);
						reconnecting = false;
						reconnectLater();
					});
			},
			base / 2 + Math.random() * (base / 2),
		).unref();
	}

	client.onClose(() => reconnectLater());

	client.on("push", (data) => {
		const { message, text } = data as {
			message: DeliveredMessage;
			text: string;
		};
		try {
			pi.sendMessage(
				{
					customType: "pulsar",
					content: text,
					display: true,
					details: { id: message.id, from: message.from.name },
				},
				{
					triggerTurn: true,
					deliverAs: message.priority === "urgent" ? "steer" : "followUp",
				},
			);
			ack(message.id, true);
		} catch (e) {
			// The daemon puts it back in the inbox.
			client
				.call("nack", { messageId: message.id, reason: (e as Error).message })
				.catch(() => {});
		}
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

	// Interactions: host dialogs race the app (first answer wins). The daemon
	// answers null at once when nobody could answer from the app.
	const relay: Relay = {
		ask: async (req) => {
			if (!client.connected) return null;
			const r = await client
				.call<{ result: RelayResult | null }>("interaction.ask", req, 0)
				.catch(() => null);
			return r?.result ?? null;
		},
		local: (ref) => notify("interaction.local", { ref }),
	};
	const relayDialogs = (c: HostContext | undefined) => {
		try {
			if (c?.ui && c.hasUI !== false) relayUi(c.ui, relay);
		} catch {}
	};

	// omp's plan review: a real API (resolvePlanReview), raced the same way.
	const reviews = new Map<string, string>();
	pi.on("plan_review_requested", (event, c) => {
		if (boundChild || isSub(c)) return;
		const e = event as PlanReviewEvent;
		const prompt = planPrompt(e);
		if (!prompt || !e.reviewId || !c?.resolvePlanReview) return;
		const ref = `plan-${e.reviewId}`.replace(/[^\w-]/g, "").slice(0, 64);
		reviews.set(e.reviewId, ref);
		// Not awaited: omp waits for handlers before it can resolve the review.
		void relay
			.ask({ ref, kind: "plan", tool: "plan_review", prompt })
			.then((r) => {
				if (!r || !reviews.has(e.reviewId)) return;
				const a = r.answer;
				if (a?.kind !== "plan") return;
				c.resolvePlanReview?.(e.reviewId, a.choice, {
					...(a.feedback ? { feedback: a.feedback } : {}),
				});
			});
	});
	pi.on("plan_review_resolved", (event, c) => {
		if (boundChild || isSub(c)) return;
		const e = event as { reviewId?: string; by?: string };
		const ref = e.reviewId ? reviews.get(e.reviewId) : undefined;
		if (!ref || !e.reviewId) return;
		reviews.delete(e.reviewId);
		if (e.by !== "extension") relay.local(ref);
	});

	// Stop: the newest handler context (pi marks older ones stale after a
	// session switch or reload, and a stale one throws).
	let ctx: HostContext | undefined;
	for (const event of [
		"session_start",
		"agent_start",
		"turn_start",
		"agent_end",
	])
		pi.on(event, (_e, c) => {
			if (isSub(c)) {
				child?.observe(c);
				return;
			}
			if (boundChild) return;
			if (c) ctx = c;
			relayDialogs(c);
			if (event === "session_start") noteSession(c);
			noteName(c);
		});
	// Renames: pi announces them; omp's generated title lands mid-turn, so
	// the name is also read again when a turn ends.
	for (const event of ["session_info_changed", "session_switch", "turn_end"])
		pi.on(event, (_e, c) => {
			if (!boundChild && !isSub(c)) noteName(c ?? ctx);
		});

	/** Reports the host session's name once it is known or changes. */
	function noteName(c: HostContext | undefined) {
		const next = hostSessionName(harness, c, pi);
		if (!next) return;
		if (!next.name) {
			// A new session with no name yet (`/new`): the old name goes.
			if (!named) return;
			named = null;
		} else if (next.name === named?.name && next.source === named?.source)
			return;
		else named = next;
		notify("harness_name", next);
	}

	/** Reports the host's session id once it is known or changes (new, resume, fork). */
	function noteSession(c: HostContext | undefined) {
		let id: string | undefined;
		try {
			id = c?.sessionManager?.getSessionId?.();
		} catch {}
		const key = id ? `${harness}:${id}` : undefined;
		if (!key || key === resumeKey) return;
		resumeKey = key;
		notify("resume_key", { key: resumeKey });
	}

	client.on("interrupt", (data) => {
		const { requestId } = data as { requestId: string };
		let result: "interrupted" | "not-running" | "unsupported" = "unsupported";
		let detail: string | undefined;
		try {
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

	// The status last reported; sent again after each (re)connect.
	let status: "busy" | "idle" | null = null;
	const setStatus = (next: "busy" | "idle") => {
		if (next === status) return;
		status = next;
		traceStatus(`${harness} pid ${process.pid} -> ${next}`);
		notify("set_status", { status: next });
	};

	// A run omp paused stays busy: until its next loop starts, until its jobs
	// finish (checked every few seconds), or at the latest after a grace
	// period (a run a session switch abandoned sends no final `agent_end`).
	let jobsTimer: ReturnType<typeof setInterval> | null = null;
	let graceTimer: ReturnType<typeof setTimeout> | null = null;
	// When the run paused awaiting background work (0: not paused that way).
	let awaitingSince = 0;
	const stopWatchingJobs = () => {
		if (jobsTimer) clearInterval(jobsTimer);
		if (graceTimer) clearTimeout(graceTimer);
		jobsTimer = graceTimer = null;
		awaitingSince = 0;
	};
	/**
	 * Background work that keeps the agent busy now: subagents and evals; a
	 * paused run's bash jobs too (it resumes when they finish), for a while
	 * only, since a dev server never finishes.
	 */
	const busyWork = () => {
		const work = backgroundWork(ctx);
		if (work > 0 || !awaitingSince) return work;
		if (Date.now() - awaitingSince >= bashGraceMs) return 0;
		try {
			return ctx?.getAsyncJobSnapshot?.()?.running?.length ?? 0;
		} catch {
			return 0;
		}
	};
	const settle = () => {
		if (busyWork() === 0) {
			stopWatchingJobs();
			setStatus("idle");
			return;
		}
		setStatus("busy");
		if (jobsTimer) return;
		// While the timer runs the status stays busy, so a tick only acts at zero.
		jobsTimer = setInterval(settle, jobPollMs);
		jobsTimer.unref?.();
	};
	/** Ends a continued run that went quiet; a loop still streaming is not quiet. */
	const armGrace = () => {
		graceTimer = setTimeout(() => {
			graceTimer = null;
			let streaming = false;
			try {
				streaming = ctx?.isIdle?.() === false;
			} catch {}
			if (streaming) armGrace();
			else settle();
		}, continueGraceMs);
		graceTimer.unref?.();
	};
	/** A host event that may end the turn: `endKind` says whether the run goes on. */
	const turnEnded = (event: string, payload: unknown) => {
		const kind = endKind(payload);
		traceStatus(`${harness} ${event} ${kind}`);
		if (kind === "continues") {
			// The session's own next loop follows (retry, compaction, reminder).
			setStatus("busy");
			if (!graceTimer) armGrace();
			return;
		}
		if (graceTimer) clearTimeout(graceTimer);
		graceTimer = null;
		if (kind === "awaits") awaitingSince ||= Date.now();
		else awaitingSince = 0;
		settle();
	};

	pi.on("session_start", async (_e, c) => {
		if (isSub(c)) {
			if (boundParent) return;
			boundChild = true;
			// The task loop must start even if the daemon is unavailable.
			void child?.start(c);
			return;
		}
		if (boundChild) return;
		boundParent = true;
		if (pi.registerMcpServer) {
			try {
				pi.registerMcpServer("pulsar", {
					command: process.execPath,
					args: [fileURLToPath(new URL("./cli.js", import.meta.url)), "mcp"],
					env: { PULSAR_HARNESS: harness },
				});
			} catch {
				// A `pulsar` entry in mcp.json takes precedence; that is fine.
			}
		}
		if (!client.connected && !reconnecting)
			await connect().catch(() => reconnectLater());
	});
	pi.on("agent_start", (_e, c) => {
		if (boundChild && isSub(c)) void child?.start(c);
		if (boundChild || isSub(c)) return;
		traceStatus(`${harness} agent_start`);
		stopWatchingJobs();
		setStatus("busy");
	});
	// Report the model after each reply, so `model=…` selectors find this agent.
	let lastModel: string | null = null;
	pi.on("message_end", (event, c) => {
		if (boundChild || isSub(c)) return;
		const message = (event as { message?: { role?: string; model?: string } })
			?.message;
		if (
			message?.role !== "assistant" ||
			!message.model ||
			message.model === lastModel
		)
			return;
		lastModel = message.model;
		notify("set_identity", { model: message.model });
	});
	for (const event of host?.extension?.idleEvents ?? [])
		pi.on(event, (e, c) => {
			if (boundChild || isSub(c)) return;
			if (c) ctx = c;
			turnEnded(event, e);
		});
	// Any shutdown ends this instance: pi disposes the session and loads the
	// extension again for the next one (`/new`, `/resume`, `/fork`, `/reload`);
	// omp emits it only on exit. A connection left open would linger as a
	// retired one and, once closed, reconnect and take pushes back.
	pi.on("session_shutdown", (_e, c) => {
		if (boundChild) {
			child?.stop();
			return;
		}
		if (isSub(c)) return;
		stopped = true;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		stopWatchingJobs();
		client.close();
	});
}
