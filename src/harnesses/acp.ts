import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import {
	PROTOCOL_VERSION as ACP_PROTOCOL_VERSION,
	type AgentCapabilities,
	ClientApp,
	type ClientConnection,
	type CreateElicitationRequest,
	type CreateElicitationResponse,
	type InitializeResponse,
	type LoadSessionResponse,
	type McpServerStdio,
	type NewSessionResponse,
	ndJsonStream,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionUpdate,
	type Stream,
} from "@agentclientprotocol/sdk";
import { DaemonClient } from "../client.ts";
import { gitInfoAsync } from "../git.ts";
import { ensureDir, stateDir } from "../paths.ts";
import { parsePush } from "../push-frame.ts";
import type {
	InteractionRequest,
	InteractionResult,
} from "../service/approvals.ts";
import { autoTags, envTags } from "../tags.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import { PROTOCOL_VERSION, type Registration } from "../types.ts";
import { AcpUsageWriter, loadAcpUsage } from "../usage/acp.ts";
import { VERSION } from "../version.ts";
import { AcpChildren, readAcpChildren } from "./acp-children.ts";
import { AcpCommandCatalog } from "./acp-commands.ts";
import { AcpSessionControls } from "./acp-controls.ts";
import { ACP_IDENTITY_ENV } from "./acp-identity.ts";
import { permissionArguments } from "./acp-permission.ts";
import { antigravityQuestion, elicitationQuestions } from "./acp-questions.ts";
import { AcpToolResults } from "./acp-tool-results.ts";
import { acpTranscriptPath } from "./acp-transcript.ts";
import { antigravitySkillPrompt } from "./antigravity-commands.ts";

export interface AcpBridgeOptions {
	command: string[];
	env?: Readonly<Record<string, string>>;
	harness: string;
	cwd: string;
	name?: string;
	sessionId?: string;
	initialPrompt?: string;
}

const SETUP_TIMEOUT_MS = 30_000;
const PERMISSION_TIMEOUT_MS = 120_000;
const MAX_QUEUE = 64;
const MAX_RECEIPTS = MAX_QUEUE * 4;
const MAX_PROMPT_BYTES = 256 * 1024;
const MAX_OUTPUT_BACKLOG = 256 * 1024;
const MAX_SETUP_NOTIFICATION_BYTES = 1024 * 1024;
const MAX_PERMISSION_REQUESTS = 16;
const MAX_TEXT = 64 * 1024;
const TRANSCRIPT_UPDATE_MS = 250;
const DETACHED_QUIET_MS = 30_000;

type Prompt = {
	text: string;
	providerText?: string;
	messageId?: string;
	command?: true;
	urgent?: true;
};

function supportsHostOwnedSteering(initialized: InitializeResponse): boolean {
	const steering = initialized._meta?.steering as
		| { supported?: unknown }
		| undefined;
	if (steering?.supported !== true) return false;
	// The general capability also exists in releases that start a detached
	// turn when steering races with completion. Require a verified version.
	const info = initialized.agentInfo;
	const minimum =
		info?.name === "@agentclientprotocol/codex-acp"
			? [2, 12, 0]
			: info?.name === "@agentclientprotocol/claude-agent-acp"
				? [0, 110, 0]
				: undefined;
	const actual = info?.version
		?.match(/^(\d+)\.(\d+)\.(\d+)$/)
		?.slice(1)
		.map(Number);
	if (!minimum || !actual) return false;
	const difference = actual.findIndex((part, index) => part !== minimum[index]);
	return difference === -1 || actual[difference]! > minimum[difference]!;
}

type Turn = {
	prompt?: Prompt;
	childSessionId?: string;
	cancelled: boolean;
	delivered: boolean;
	printed: boolean;
	permissions: Map<string, () => void>;
	block?: {
		id: string;
		messageId?: string | null;
		kind: "text" | "thinking";
		text: string;
		lastWrite: number;
		written: number;
	};
};

class Bridge {
	private readonly daemon = new DaemonClient();
	private readonly controls = new AcpSessionControls();
	private readonly commands: AcpCommandCatalog;
	private readonly tools = new AcpToolResults(MAX_TEXT);
	private readonly setupUpdates: Array<{
		sessionId: string;
		update: SessionUpdate;
	}> = [];
	private setupNotificationBytes = 0;
	private switchingConfig = false;
	private usageObserved = false;
	private usageWriter?: AcpUsageWriter;
	private readonly options: AcpBridgeOptions;
	private readonly identityPath: string;
	private readonly queue: Prompt[] = [];
	private readonly received = new Set<string>();
	private readonly receipts = new Map<
		string,
		{ method: "ack" | "nack" | "msg.nack"; params: unknown }
	>();
	private readonly app: ClientApp;
	private readonly flushingReceipts = new Set<string>();
	private terminalOutput = true;
	private connection?: ClientConnection;
	private sessionId?: string;
	private transcript?: number;
	private turn?: Turn;
	private children?: AcpChildren;
	private readonly childInteractions = new Map<string, Turn>();
	private detachedTimeout?: ReturnType<typeof setTimeout>;
	private detachedSettled = false;
	private draining?: Promise<void>;
	private steering?: Promise<void>;
	private canSteer = false;
	private reconnect?: ReturnType<typeof setTimeout>;
	private retryMs = 500;
	private stopping = false;
	private ready = false;
	private capabilities?: AgentCapabilities;
	private registration?: Registration;

	constructor(options: AcpBridgeOptions, identityPath: string) {
		this.options = options;
		this.identityPath = identityPath;
		this.commands = new AcpCommandCatalog({
			harness: options.harness,
			cwd: options.cwd,
			home: options.env?.HOME,
		});
		this.app = new ClientApp()
			.onRequest("session/request_permission", ({ params: request, signal }) =>
				this.permission(request, signal),
			)
			.onRequest("elicitation/create", ({ params: request, signal }) =>
				this.elicitation(request, signal),
			)
			.onNotification("session/update", ({ params: { sessionId, update } }) => {
				if (this.stopping) return;
				if (!this.ready) {
					// Agents may publish their catalog before the setup response.
					if (
						this.setupUpdates.length < 200 &&
						(update.sessionUpdate === "available_commands_update" ||
							update.sessionUpdate === "config_option_update" ||
							update.sessionUpdate === "current_mode_update" ||
							update.sessionUpdate === "subagent_update" ||
							update.sessionUpdate === "session_message" ||
							update.sessionUpdate === "session_message_chunk" ||
							update.sessionUpdate === "agent_message_chunk" ||
							update.sessionUpdate === "agent_thought_chunk" ||
							update.sessionUpdate === "user_message_chunk" ||
							update.sessionUpdate === "tool_call" ||
							update.sessionUpdate === "tool_call_update")
					) {
						const bytes = Buffer.byteLength(JSON.stringify(update));
						if (
							this.setupNotificationBytes + bytes <=
							MAX_SETUP_NOTIFICATION_BYTES
						) {
							this.setupNotificationBytes += bytes;
							this.setupUpdates.push({ sessionId, update });
						}
					}
					return;
				}
				if (this.childUpdate(sessionId, update)) return;
				if (sessionId === this.sessionId) this.sessionUpdate(update);
			});
		this.daemon.on("control", (data) => {
			const { requestId, ...request } = data as {
				requestId: string;
				kind?: string;
				line?: string;
				mode?: string;
			};
			void this.control(request).then(
				(result) => this.notify("control_result", { requestId, ...result }),
				(error) =>
					this.notify("control_result", {
						requestId,
						result: "failed",
						detail: String(error),
					}),
			);
		});
		this.daemon.on("push", (data) => {
			const { message, text } = data as {
				message?: { id?: string; priority?: string };
				text?: string;
			};
			const messageId = message?.id;
			if (typeof messageId !== "string" || typeof text !== "string") return;
			// FYI messages belong to the inbox and must never start a provider turn.
			if (message?.priority === "fyi") return;
			if (this.received.has(messageId)) return;
			if (this.receipts.has(messageId)) {
				void this.flushReceipt(messageId);
				return;
			}
			this.enqueue({
				text,
				messageId,
				...(message?.priority === "urgent" ? { urgent: true } : {}),
			});
		});
		this.daemon.on("interrupt", (data) => {
			const { requestId, childSessionId } = data as {
				requestId: string;
				childSessionId?: string;
			};
			void this.cancel(childSessionId).then(
				(result) => this.notify("interrupt_result", { requestId, result }),
				(error) =>
					this.notify("interrupt_result", {
						requestId,
						result: "unsupported",
						detail: String(error),
					}),
			);
		});
		this.daemon.onClose(() => this.reconnectLater());
	}

	async start(stream: Stream, pid: number, stopSignal: AbortSignal) {
		const connection = this.app.connect(stream);
		this.connection = connection;
		const startup = {
			cancellationSignal: AbortSignal.any([
				stopSignal,
				AbortSignal.timeout(SETUP_TIMEOUT_MS),
			]),
			stopWaitingOnCancel: true,
		};
		const initialized = await connection.agent.request(
			"initialize",
			{
				protocolVersion: ACP_PROTOCOL_VERSION,
				clientCapabilities: { elicitation: { form: {} }, subagents: {} },
				clientInfo: { name: "pulsar", version: VERSION },
			},
			startup,
		);
		if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
			throw new Error(
				`Unsupported ACP protocol version ${initialized.protocolVersion}`,
			);
		this.capabilities = initialized.agentCapabilities;
		this.canSteer = supportsHostOwnedSteering(initialized);
		const mcp: McpServerStdio = {
			name: "pulsar",
			command: process.execPath,
			args: [resolve(process.argv[1] ?? "pulsar"), "mcp"],
			env: [
				{ name: ACP_IDENTITY_ENV, value: this.identityPath },
				{ name: "PULSAR_HOME", value: resolve(stateDir()) },
			],
		};
		const session = { cwd: this.options.cwd, mcpServers: [mcp] };
		const requestedId = this.options.sessionId;
		const canResume = this.capabilities?.sessionCapabilities?.resume != null;
		const canLoad = this.capabilities?.loadSession === true;
		startup.cancellationSignal.throwIfAborted();
		let state: LoadSessionResponse | undefined;
		if (!requestedId) {
			const opened = await connection.agent.request<NewSessionResponse>(
				"session/new",
				session,
				startup,
			);
			this.sessionId = opened.sessionId;
			state = opened;
		} else {
			if (!canResume && !canLoad)
				throw new Error(
					`${this.options.harness} does not advertise ACP session resume or load`,
				);
			state = await connection.agent.request<LoadSessionResponse>(
				canResume ? "session/resume" : "session/load",
				{ ...session, sessionId: requestedId },
				startup,
			);
			if (state && "sessionId" in state && state.sessionId !== requestedId)
				throw new Error(
					`${this.options.harness} returned a different session ID while reopening the conversation`,
				);
			this.sessionId = requestedId;
		}
		if (
			!this.sessionId ||
			this.sessionId.length > 200 ||
			// The registry escapes "/" as "%2F" in its local agent id.
			// Do not let an already escaped id alias another provider session.
			this.sessionId.includes("%2F") ||
			/\p{Cc}/u.test(this.sessionId)
		)
			throw new Error("ACP returned an invalid session ID");

		this.controls.install(state);
		const path = acpTranscriptPath(this.options.harness, this.sessionId);
		await ensureDir(dirname(path));
		stopSignal.throwIfAborted();
		this.transcript = openSync(path, "a", 0o600);
		this.children = new AcpChildren(
			this.options.harness,
			this.sessionId,
			() => {
				if (!this.ready || this.stopping) return;
				this.refreshCapabilities();
				this.notify("acp.children", {});
			},
			await readAcpChildren(this.options.harness, this.sessionId),
		);
		const usageSession = {
			harness: this.options.harness,
			sessionId: this.sessionId,
		};
		const previousUsage = await loadAcpUsage(usageSession);
		this.usageObserved = !!(previousUsage?.context || previousUsage?.cost);
		this.usageWriter = new AcpUsageWriter(usageSession, () => {
			if (this.usageObserved || this.stopping) return;
			this.usageObserved = true;
			this.refreshCapabilities();
		});
		const git = await gitInfoAsync(this.options.cwd, { lane: "user" });
		this.registration = {
			harness: this.options.harness,
			sessionId: this.sessionId,
			pid,
			cwd: this.options.cwd,
			project: git.project,
			branch: git.branch,
			tags: [...autoTags(this.options.harness, git), ...envTags()],
			...(this.options.name ? { name: this.options.name } : {}),
			role: "extension",
			model: this.controls.model,
			meta: {
				acp: "1",
				acpResume: canResume || canLoad ? "1" : "0",
				acpQuestions: "1",
				acpSteer: this.canSteer ? "1" : "0",
				...this.runtimeMeta(),
			},
		};
		stopSignal.throwIfAborted();
		await this.connectDaemon();
		stopSignal.throwIfAborted();
		const pendingPath = `${this.identityPath}.tmp`;
		await writeFile(pendingPath, JSON.stringify(this.registration), {
			mode: 0o600,
		});
		await rename(pendingPath, this.identityPath);
		this.ready = true;
		this.children.persist();
		this.applySetupUpdates(this.sessionId);
		this.refreshCapabilities();
		void this.commands.refresh().then(() => this.refreshCapabilities());
		this.drainQueue();
		return { sessionId: this.sessionId, connection };
	}

	private async connectDaemon() {
		await this.daemon.connect(true);
		if (this.stopping) {
			this.daemon.close();
			return;
		}
		try {
			await this.daemon.call("hello", {
				protocol: PROTOCOL_VERSION,
				version: VERSION,
				registration: this.registration,
			});
			await this.daemon.call("set_status", {
				status: this.turn || this.steering ? "busy" : "idle",
			});
			await Promise.all(
				[...this.receipts.keys()].map((id) => this.flushReceipt(id)),
			);
		} catch (error) {
			this.daemon.close();
			throw error;
		}
		this.retryMs = 500;
	}

	private reconnectLater() {
		if (this.stopping || this.reconnect || !this.registration) return;
		this.reconnect = setTimeout(() => {
			void this.connectDaemon()
				.catch(() => {
					this.retryMs = Math.min(this.retryMs * 2, 15_000);
				})
				.finally(() => {
					this.reconnect = undefined;
					if (!this.daemon.connected) this.reconnectLater();
				});
		}, this.retryMs);
	}

	private notify(method: string, params: unknown) {
		if (this.daemon.connected)
			void this.daemon.call(method, params).catch(() => {});
	}

	private receipt(
		messageId: string,
		accepted: boolean,
		reason?: string,
		steer = false,
	) {
		if (this.receipts.size >= MAX_RECEIPTS) {
			const oldest = this.receipts.keys().next().value;
			if (oldest) this.receipts.delete(oldest);
		}
		this.receipts.set(
			messageId,
			accepted
				? {
						method: "ack",
						params: { messageId, via: steer ? "acp-steer" : "acp" },
					}
				: {
						method: steer ? "msg.nack" : "nack",
						params: { messageId, reason },
					},
		);
		void this.flushReceipt(messageId);
	}

	private async flushReceipt(id: string) {
		const receipt = this.receipts.get(id);
		if (
			!receipt ||
			!this.daemon.connected ||
			this.flushingReceipts.has(id) ||
			this.flushingReceipts.size >= MAX_RECEIPTS
		)
			return;
		this.flushingReceipts.add(id);
		try {
			await this.daemon.call(receipt.method, receipt.params, 4000);
			if (this.receipts.get(id) === receipt) this.receipts.delete(id);
		} catch {
			// A reconnect retries the receipt if the socket closed before the reply.
		} finally {
			this.flushingReceipts.delete(id);
			if (this.receipts.get(id) !== receipt) {
				const next = [...this.receipts.keys()].find(
					(key) => !this.flushingReceipts.has(key),
				);
				if (next) void this.flushReceipt(next);
			}
		}
	}

	enqueue(prompt: Prompt) {
		if (
			!prompt.text.trim() ||
			Buffer.byteLength(prompt.text) > MAX_PROMPT_BYTES ||
			this.stopping ||
			this.queue.length >= MAX_QUEUE
		) {
			if (prompt.messageId)
				this.receipt(
					prompt.messageId,
					false,
					"ACP prompt queue is unavailable",
				);
			else if (prompt.text.trim())
				console.error("ACP prompt queue is unavailable");
			return;
		}
		if (prompt.messageId) this.received.add(prompt.messageId);
		this.queue.push(prompt);
		this.drainQueue();
	}

	private drainQueue() {
		if (
			!this.ready ||
			this.stopping ||
			(this.turn && !this.turn.prompt) ||
			this.switchingConfig ||
			this.steering ||
			!this.queue.length
		)
			return;
		if (this.turn && !this.turn.cancelled && this.canSteer) {
			const index = this.queue.findIndex((prompt) => prompt.urgent);
			if (index >= 0) {
				this.steering = this.steer(index).finally(() => {
					this.steering = undefined;
					if (!this.turn && !this.queue.length)
						this.notify("set_status", { status: "idle" });
					this.drainQueue();
				});
				return;
			}
		}
		this.draining ??= this.drain().finally(() => {
			this.draining = undefined;
			this.drainQueue();
		});
	}

	private async steer(index: number) {
		const connection = this.connection;
		const sessionId = this.sessionId;
		const prompt = this.queue[index];
		if (!connection || !sessionId || !prompt?.messageId) return;
		const { messageId } = prompt;
		this.queue.splice(index, 1);
		let deferred = false;
		try {
			const result = await connection.agent.request<{
				outcome?: unknown;
				reason?: unknown;
			}>(
				"_session/steering",
				{
					sessionId,
					prompt: [{ type: "text", text: prompt.text }],
					_meta: { steering: { idleBehavior: "promptRequired" } },
				},
				{
					cancellationSignal: AbortSignal.timeout(SETUP_TIMEOUT_MS),
					stopWaitingOnCancel: true,
				},
			);
			if (result?.outcome === "injected") {
				if (this.turn) {
					this.confirmDelivery(this.turn);
					this.writeBlock(this.turn);
					this.turn.block = undefined;
				}
				this.recordPrompt(prompt);
				this.receipt(messageId, true, undefined, true);
			} else if (
				!this.stopping &&
				result?.outcome === "promptRequired" &&
				result.reason === "noRunningTurn"
			) {
				prompt.urgent = undefined;
				this.queue.splice(index, 0, prompt);
				deferred = true;
			} else {
				this.receipt(
					messageId,
					false,
					"ACP did not confirm in-turn delivery",
					true,
				);
			}
		} catch {
			// The request may already have been applied. Never replay it.
			this.receipt(
				messageId,
				false,
				"ACP did not confirm in-turn delivery",
				true,
			);
		} finally {
			if (!deferred) this.received.delete(messageId);
		}
	}

	private async drain() {
		const connection = this.connection;
		const sessionId = this.sessionId;
		if (!connection || !sessionId) return;
		while (!this.stopping && !this.steering) {
			const prompt = this.queue.shift();
			if (!prompt) return;
			const turn: Turn = {
				prompt,
				cancelled: false,
				delivered: false,
				printed: false,
				permissions: new Map(),
			};
			this.turn = turn;
			this.notify("set_status", { status: "busy" });
			try {
				if (!prompt.messageId) this.recordPrompt(prompt);
				const result = await connection.agent.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: prompt.providerText ?? prompt.text }],
				});
				this.confirmDelivery(turn);
				if (prompt.messageId) this.receipt(prompt.messageId, true);
				this.writeBlock(turn);
				if (result.stopReason === "cancelled") {
					this.record({
						role: "system",
						kind: "system",
						subtype: "interrupted",
						text: "Turn stopped",
					});
				}
			} catch (error) {
				this.writeBlock(turn);
				const detail = String(error).slice(0, MAX_TEXT);
				console.error(detail);
				this.record({ role: "system", kind: "system", text: detail });
				if (prompt.messageId)
					this.receipt(prompt.messageId, turn.delivered, detail);
			} finally {
				this.finishPermissions(turn);
				if (prompt.messageId) this.received.delete(prompt.messageId);
				this.turn = undefined;
				if (turn.printed) this.print("\n");
				if ((!this.queue.length && !this.steering) || this.stopping)
					this.notify("set_status", { status: "idle" });
			}
		}
	}

	private finishPermissions(turn: Turn) {
		for (const cancel of turn.permissions.values()) cancel();
	}

	async cancel(
		childSessionId?: string,
	): Promise<"not-running" | "interrupted"> {
		if (childSessionId !== undefined) {
			if (!this.connection || !this.children?.canCancel(childSessionId))
				return "not-running";
			this.cancelChildInteractions(childSessionId);
			await this.connection.agent.notify("session/cancel", {
				sessionId: childSessionId,
			});
			return "interrupted";
		}
		const turn = this.turn;
		if (!turn || !this.connection || !this.sessionId) return "not-running";
		turn.cancelled = true;
		this.finishPermissions(turn);
		await this.connection.agent.notify("session/cancel", {
			sessionId: this.sessionId,
		});
		if (!turn.prompt) this.finishDetached(turn);
		return "interrupted";
	}

	private async permission(
		request: RequestPermissionRequest,
		signal: AbortSignal,
	): Promise<RequestPermissionResponse> {
		const cancelled = { outcome: { outcome: "cancelled" } } as const;
		const ids = new Set(request.options.map((option) => option.optionId));
		if (signal.aborted || ids.size !== request.options.length) return cancelled;
		const allow = request.options.find(
			(option) => option.kind === "allow_once",
		);
		const deny = request.options.find(
			(option) => option.kind === "reject_once",
		);
		const select = (optionId: string): RequestPermissionResponse => ({
			outcome: { outcome: "selected", optionId },
		});
		const turn = this.turnForInteraction(request.sessionId);
		if (!turn) return cancelled;
		this.confirmDelivery(turn);
		if (
			this.options.harness === "antigravity" &&
			request.toolCall.toolCallId.startsWith("interaction_")
		) {
			const question = antigravityQuestion(request);
			if (!question) return cancelled;
			const answer = await this.interaction(turn, signal, {
				kind: "question",
				tool: "Antigravity question",
				prompt: question.prompt,
			});
			const selected =
				answer?.answer?.kind === "question"
					? question.answer(answer.answer.answers)
					: undefined;
			return selected ? select(selected) : cancelled;
		}
		const args = permissionArguments(request.toolCall);
		if (!allow || args == null) return deny ? select(deny.optionId) : cancelled;
		const result = await this.interaction(turn, signal, {
			kind: "permission",
			tool: request.toolCall.title ?? request.toolCall.kind ?? "ACP tool",
			input: { arguments: args, option: allow.name },
		});
		if (signal.aborted || turn.cancelled) return cancelled;
		if (result?.decision === "allow-once") return select(allow.optionId);
		return deny ? select(deny.optionId) : cancelled;
	}

	private async elicitation(
		request: CreateElicitationRequest,
		signal: AbortSignal,
	): Promise<CreateElicitationResponse> {
		if (!("sessionId" in request)) return { action: "cancel" };
		const form = elicitationQuestions(request);
		if (!form) return { action: "cancel" };
		const turn = this.turnForInteraction(request.sessionId);
		if (!turn) return { action: "cancel" };
		this.confirmDelivery(turn);
		const answer = await this.interaction(turn, signal, {
			kind: "question",
			tool: "ACP question",
			prompt: form.prompt,
		});
		if (answer?.answer?.kind === "cancel") return { action: "decline" };
		const content =
			answer?.answer?.kind === "question"
				? form.answer(answer.answer.answers)
				: undefined;
		return content ? { action: "accept", content } : { action: "cancel" };
	}

	private async interaction(
		turn: Turn,
		signal: AbortSignal,
		request: Pick<InteractionRequest, "kind" | "tool"> &
			Partial<Pick<InteractionRequest, "input" | "prompt">>,
	): Promise<InteractionResult | null> {
		if (
			signal.aborted ||
			!this.daemon.connected ||
			turn.permissions.size >= MAX_PERMISSION_REQUESTS ||
			(turn.childSessionId &&
				this.childPermissionCount() >= MAX_PERMISSION_REQUESTS)
		)
			return null;
		const ref = randomUUID();
		const scope = turn.childSessionId
			? { childSessionId: turn.childSessionId }
			: {};
		if (turn.childSessionId)
			this.childInteractions.set(turn.childSessionId, turn);
		const stopped = new Promise<null>((done) => {
			turn.permissions.set(ref, () => {
				this.notify("interaction.local", { ref, ...scope });
				done(null);
			});
		});
		const cancel = turn.permissions.get(ref)!;
		signal.addEventListener("abort", cancel, { once: true });
		try {
			if (turn.childSessionId) await this.children?.flush();
			if (signal.aborted || turn.cancelled || this.stopping) return null;
			const result = await Promise.race([
				stopped,
				this.daemon
					.call<{ result: InteractionResult | null }>(
						"interaction.ask",
						{
							ref,
							...scope,
							...request,
							timeoutMs: PERMISSION_TIMEOUT_MS,
						},
						PERMISSION_TIMEOUT_MS + 1000,
					)
					.catch(() => null),
			]);
			return turn.cancelled ? null : (result?.result ?? null);
		} finally {
			signal.removeEventListener("abort", cancel);
			turn.permissions.delete(ref);
			if (turn.childSessionId) {
				if (
					!turn.permissions.size &&
					this.childInteractions.get(turn.childSessionId) === turn
				)
					this.childInteractions.delete(turn.childSessionId);
			} else if (!turn.prompt && this.detachedSettled && !turn.permissions.size)
				setImmediate(() => {
					if (this.detachedSettled && !turn.permissions.size)
						this.finishDetached(turn);
				});
		}
	}

	private applySetupUpdates(sessionId: string) {
		this.setupNotificationBytes = 0;
		for (const pending of this.setupUpdates.splice(0)) {
			if (this.childUpdate(pending.sessionId, pending.update)) continue;
			if (pending.sessionId === sessionId) this.controls.update(pending.update);
		}
	}

	private childUpdate(sessionId: string, update: SessionUpdate): boolean {
		try {
			if (
				update.sessionUpdate === "subagent_update" &&
				update.state?.state === "idle" &&
				this.children?.ownedBy(update.sessionId, sessionId)
			)
				this.cancelChildInteractions(update.sessionId);
			return (
				this.children?.update(sessionId, update, (event) =>
					this.record(event),
				) ?? false
			);
		} catch (error) {
			console.error("ACP child update could not be recorded", error);
			return (
				sessionId !== this.sessionId ||
				update.sessionUpdate === "subagent_update"
			);
		}
	}

	private commandCatalog() {
		const advertised = this.controls.commands;
		const argumentChoices = this.controls.modelChoices;
		if (!argumentChoices.length) return this.commands.list(advertised);
		const native = advertised.find(({ name }) => name === "model");
		return this.commands.list([
			{
				...native,
				name: "model",
				source: "agent",
				args: "<model>",
				argumentChoices,
				description: native
					? "Switch to an advertised model, or run /model alone for the provider command."
					: "Switch to an advertised model.",
			},
			...advertised.filter(({ name }) => name !== "model"),
		]);
	}

	private runtimeMeta() {
		const commands = this.commandCatalog();
		return {
			acpModes: this.controls.selection?.modes.length ? "1" : "0",
			acpCommands: commands.size ? "1" : "0",
			acpSubagents: this.children?.observed ? "1" : "0",
			acpSkills: [...commands.values()].some(({ entry }) => entry.skill)
				? "1"
				: "0",
			acpUsage: this.usageObserved ? "1" : "0",
		};
	}

	private refreshCapabilities() {
		const registration = this.registration;
		if (!registration || this.stopping) return;
		const next = this.runtimeMeta();
		if (
			registration.model === this.controls.model &&
			Object.entries(next).every(
				([key, value]) => registration.meta?.[key] === value,
			)
		)
			return;
		registration.model = this.controls.model;
		registration.meta = { ...registration.meta, ...next };
		// A repeated hello on this socket refreshes the public session without
		// creating a second extension registration.
		this.notify("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration,
		});
	}

	private sessionUpdate(update: SessionUpdate) {
		if (this.controls.update(update)) {
			this.refreshCapabilities();
		} else if (update.sessionUpdate === "usage_update") {
			this.usageWriter?.add(update);
			if (this.turn && !this.turn.prompt) this.settleDetached(this.turn);
		} else if (this.turn) {
			if (!this.turn.prompt && !this.turn.cancelled)
				this.refreshDetached(this.turn);
			this.update(this.turn, update);
		} else if (this.options.harness === "antigravity") {
			if (
				update.sessionUpdate === "agent_message_chunk" ||
				update.sessionUpdate === "agent_thought_chunk"
			) {
				if (update.content.type === "text" && update.content.text)
					this.update(this.detachedTurn(), update);
			} else if (
				update.sessionUpdate === "tool_call" ||
				(update.sessionUpdate === "tool_call_update" &&
					this.tools.has(update.toolCallId))
			) {
				this.updateTool(update);
			}
		}
	}

	private turnForInteraction(sessionId: unknown): Turn | undefined {
		if (!this.ready || this.stopping) return;
		if (typeof sessionId === "string" && this.children?.announced(sessionId)) {
			let turn = this.childInteractions.get(sessionId);
			if (!turn && this.childInteractions.size < MAX_PERMISSION_REQUESTS) {
				turn = {
					childSessionId: sessionId,
					cancelled: false,
					delivered: true,
					printed: false,
					permissions: new Map(),
				};
			}
			return turn?.cancelled ? undefined : turn;
		}
		if (
			!this.ready ||
			this.stopping ||
			sessionId !== this.sessionId ||
			this.turn?.cancelled
		)
			return;
		return (
			this.turn ??
			(this.options.harness === "antigravity" ? this.detachedTurn() : undefined)
		);
	}

	private childPermissionCount() {
		return [...this.childInteractions.values()].reduce(
			(count, turn) => count + turn.permissions.size,
			0,
		);
	}

	private cancelChildInteractions(sessionId: string) {
		const turn = this.childInteractions.get(sessionId);
		if (!turn) return;
		turn.cancelled = true;
		this.finishPermissions(turn);
	}

	private detachedTurn(): Turn {
		const turn: Turn = {
			cancelled: false,
			delivered: true,
			printed: false,
			permissions: new Map(),
		};
		this.turn = turn;
		this.notify("set_status", { status: "busy" });
		this.refreshDetached(turn);
		return turn;
	}

	private refreshDetached(turn: Turn) {
		this.detachedSettled = false;
		clearTimeout(this.detachedTimeout);
		this.detachedTimeout = setTimeout(
			() => this.settleDetached(turn),
			DETACHED_QUIET_MS,
		);
		this.detachedTimeout.unref();
	}

	private settleDetached(turn: Turn) {
		if (turn !== this.turn) return;
		this.detachedSettled = true;
		if (!turn.permissions.size) this.finishDetached(turn);
	}

	private finishDetached(turn: Turn) {
		if (turn !== this.turn) return;
		clearTimeout(this.detachedTimeout);
		this.writeBlock(turn);
		if (turn.printed) this.print("\n");
		this.turn = undefined;
		this.notify("set_status", { status: "idle" });
		this.drainQueue();
	}

	private async control(request: {
		kind?: string;
		line?: string;
		mode?: string;
	}) {
		if (!this.ready || !this.connection || !this.sessionId || this.stopping)
			return {
				result: "unsupported",
				detail: "The ACP session is unavailable.",
			};
		if (request.kind === "commands" || request.kind === "command") {
			await this.commands.refresh();
			if (this.stopping)
				return {
					result: "unsupported",
					detail: "The ACP session is unavailable.",
				};
			this.refreshCapabilities();
		}
		const modes = this.controls.selection;
		const busy =
			!!this.turn ||
			!!this.steering ||
			this.switchingConfig ||
			this.queue.length > 0;
		if (request.kind === "mode.get") {
			return {
				result: "ok",
				mode: modes?.current ?? null,
				modes: modes?.modes ?? [],
				canSwitch: !busy && !!modes?.modes.length,
				...(busy
					? { detail: "Wait for the current ACP operation to finish." }
					: {}),
			};
		}
		if (request.kind === "commands") {
			const entries = [...this.commandCatalog().values()];
			return {
				result: "ok",
				commands: entries.map(({ entry }) => entry),
				runnable: !busy && entries.length > 0,
				...(busy
					? { detail: "Wait for the current ACP operation to finish." }
					: {}),
			};
		}
		if (busy)
			return {
				result: "busy",
				detail: "Wait for the current ACP operation to finish.",
			};
		if (request.kind === "mode.set" && typeof request.mode === "string")
			return this.selectConfig(request.mode, "mode");

		if (request.kind === "command" && typeof request.line === "string") {
			const line = request.line;
			const name = /^\/([A-Za-z0-9][A-Za-z0-9:_.-]{0,127})(?: |$)/.exec(
				line,
			)?.[1];
			if (!name || line.length > 4000 || /\p{Cc}/u.test(line))
				return { result: "unsupported", detail: "Invalid ACP command." };
			const args = line.slice(name.length + 1).trim();
			if (name === "model" && this.controls.modelChoices.length) {
				if (args) return this.selectConfig(args, "model");
				if (!this.controls.commands.some(({ name }) => name === "model"))
					return { result: "unsupported", detail: this.controls.modelHelp() };
			}

			const command = this.commandCatalog().get(name);
			if (command) {
				this.enqueue({
					text: line,
					command: true,
					...(command.skillPath
						? {
								providerText: antigravitySkillPrompt(command.skillPath, args),
							}
						: {}),
				});
				return { result: "ok" };
			}
			return {
				result: "unsupported",
				detail: "The session does not have this ACP command or skill.",
			};
		}
		return { result: "unsupported", detail: "Unknown ACP control request." };
	}

	private async selectConfig(target: string, kind: "mode" | "model") {
		if (!this.connection || !this.sessionId) return { result: "unsupported" };
		this.switchingConfig = true;
		try {
			return await this.controls.select(
				this.connection.agent,
				this.sessionId,
				target,
				kind,
			);
		} finally {
			this.switchingConfig = false;
			this.refreshCapabilities();
			this.drainQueue();
		}
	}

	private confirmDelivery(turn: Turn) {
		if (turn.delivered) return;
		turn.delivered = true;
		if (turn.prompt?.messageId) this.recordPrompt(turn.prompt);
	}

	stopTerminalOutput() {
		this.terminalOutput = false;
	}

	private print(text: string) {
		if (
			this.terminalOutput &&
			process.stdout.writableLength < MAX_OUTPUT_BACKLOG
		)
			process.stdout.write(text.slice(0, MAX_TEXT));
	}

	private recordPrompt(prompt: Prompt) {
		const parsed = prompt.messageId ? parsePush(prompt.text) : null;
		if (parsed) {
			const { sender, from, body, messageId, machine, attempt } = parsed;
			this.record({
				role: sender === "operator" ? "user" : "peer",
				kind: sender === "operator" ? "text" : "peer",
				text: body,
				from,
				pulsar: { sender, messageId, machine, attempt },
			});
		} else {
			this.record({
				role: "user",
				kind: "text",
				text: prompt.text,
				...(prompt.command ? { subtype: "command" } : {}),
			});
		}
	}

	private update(turn: Turn, update: SessionUpdate) {
		const type = update.sessionUpdate;
		if (type === "agent_message_chunk" || type === "agent_thought_chunk") {
			this.confirmDelivery(turn);
			if (update.content.type !== "text") return;
			const kind = type === "agent_message_chunk" ? "text" : "thinking";
			if (kind === "text") turn.printed = true;
			if (
				turn.block?.kind !== kind ||
				turn.block.messageId !== update.messageId
			) {
				this.writeBlock(turn);
				turn.block = undefined;
			}
			// Keep streaming replacements bounded while retaining the whole reply.
			// A JSON character may need six bytes when escaped in the transcript.
			const limit = MAX_TEXT / 2;
			let offset = 0;
			while (offset < update.content.text.length) {
				turn.block ??= {
					id: randomUUID(),
					kind,
					messageId: update.messageId,
					text: "",
					lastWrite: 0,
					written: 0,
				};
				const block = turn.block;
				let end = Math.min(
					update.content.text.length,
					offset + limit - block.text.length,
				);
				if (
					end < update.content.text.length &&
					/[\uD800-\uDBFF]/.test(update.content.text[end - 1] ?? "")
				)
					end--;
				const part = update.content.text.slice(offset, end);
				if (kind === "text") this.print(part);
				block.text += part;
				offset = end;
				if (
					offset < update.content.text.length ||
					block.text.length === limit
				) {
					this.writeBlock(turn);
					turn.block = undefined;
				} else if (Date.now() - block.lastWrite >= TRANSCRIPT_UPDATE_MS) {
					this.writeBlock(turn);
				}
			}
			return;
		}
		if (type !== "tool_call" && type !== "tool_call_update") return;
		this.confirmDelivery(turn);
		if (type === "tool_call") {
			this.writeBlock(turn);
			turn.block = undefined;
		}
		this.updateTool(update);
	}

	private updateTool(
		update: Extract<
			SessionUpdate,
			{ sessionUpdate: "tool_call" | "tool_call_update" }
		>,
	) {
		if (update.sessionUpdate === "tool_call") {
			const { title, toolCallId, rawInput, status } = update;
			this.record({
				role: "tool",
				kind: "tool_call",
				text: title,
				tool: {
					name: (update.name ?? title).slice(0, 200),
					callId: toolCallId.slice(0, 500),
					input: rawInput,
					done: status === "completed" || status === "failed",
				},
			});
		}
		const result = this.tools.apply(update);
		if (result) this.record(result);
	}

	private writeBlock(turn: Turn) {
		const block = turn.block;
		if (!block || block.written === block.text.length) return;
		this.record({
			role: "assistant",
			kind: block.kind,
			text: block.text,
			id: block.id,
		});
		block.written = block.text.length;
		block.lastWrite = Date.now();
	}

	private record(event: Omit<TranscriptEvent, "id" | "ts"> & { id?: string }) {
		if (this.transcript === undefined) return;
		try {
			const { text, ...rest } = event;
			const row = {
				id: randomUUID(),
				ts: Date.now(),
				...rest,
				text: text.slice(0, MAX_TEXT),
			};
			let line = JSON.stringify(row);
			if (Buffer.byteLength(line) > MAX_TEXT * 4) {
				row.text = row.text.slice(0, MAX_TEXT / 4);
				if (row.tool)
					row.tool = { ...row.tool, input: undefined, truncated: true };
				line = JSON.stringify(row);
			}
			if (Buffer.byteLength(line) <= MAX_TEXT * 4)
				writeSync(this.transcript, `${line}\n`);
		} catch (error) {
			console.error("ACP transcript write failed", error);
		}
	}

	async close() {
		this.stopping = true;
		for (const id of this.childInteractions.keys())
			this.cancelChildInteractions(id);
		clearTimeout(this.reconnect);
		clearTimeout(this.detachedTimeout);
		for (const prompt of this.queue) {
			if (prompt.messageId)
				this.receipt(
					prompt.messageId,
					false,
					"ACP session closed before delivery",
				);
		}
		if (this.turn) {
			this.turn.cancelled = true;
			this.finishPermissions(this.turn);
			if (!this.turn.prompt) this.writeBlock(this.turn);
		}
		const connection = this.connection;
		if (connection && !connection.signal.aborted && this.sessionId) {
			if (this.capabilities?.sessionCapabilities?.close != null) {
				await connection.agent
					.request(
						"session/close",
						{ sessionId: this.sessionId },
						{
							cancellationSignal: AbortSignal.timeout(1000),
							stopWaitingOnCancel: true,
						},
					)
					.catch(() => {});
			} else if (this.turn) {
				void this.cancel().catch(() => {});
			}
		}
		connection?.close();
		await this.draining;
		await this.children?.flush();
		await this.steering;
		await this.usageWriter?.finish();
		this.daemon.close();
		if (this.transcript !== undefined) closeSync(this.transcript);
	}
}

export async function runAcpBridge(options: AcpBridgeOptions): Promise<void> {
	const [binary, ...args] = options.command;
	if (!binary) throw new Error("An ACP command is required");
	const cwd = resolve(options.cwd);
	const identityDir = await mkdtemp(join(tmpdir(), "pulsar-acp-"));
	const identityPath = join(identityDir, "session.json");
	const child = spawn(binary, args, {
		cwd,
		env: { ...process.env, ...options.env, [ACP_IDENTITY_ENV]: identityPath },
		stdio: ["pipe", "pipe", "inherit"],
	});
	const ended = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((done) => child.once("exit", (code, signal) => done({ code, signal })));
	const bridge = new Bridge({ ...options, cwd }, identityPath);
	const stopController = new AbortController();
	let stopInput: (() => void) | undefined;
	const stopOutput = () => bridge.stopTerminalOutput();
	process.stdout.on("error", stopOutput);
	let stop: () => void = () => {};
	const stopped = new Promise<void>((done) => {
		stop = () => {
			stopController.abort();
			done();
		};
	});
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	process.once("SIGHUP", stop);
	const spawnError = new Promise<never>((_resolve, reject) =>
		child.once("error", reject),
	);
	try {
		await Promise.race([
			spawnError,
			new Promise<void>((done) => child.once("spawn", done)),
		]);
		stopController.signal.throwIfAborted();
		if (!child.pid) throw new Error("ACP agent did not start");
		const { connection, sessionId } = await bridge.start(
			ndJsonStream(
				Writable.toWeb(child.stdin),
				Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
				{ maxMessageBytes: 8 * 1024 * 1024 },
			),
			child.pid,
			stopController.signal,
		);
		if (connection.signal.aborted)
			throw new Error("ACP connection closed during startup");
		console.error(`ACP session ${sessionId}`);
		if (options.initialPrompt) bridge.enqueue({ text: options.initialPrompt });
		stopInput = readPromptLines((text) => bridge.enqueue({ text }));
		await Promise.race([
			stopped,
			spawnError,
			ended.then(({ code, signal }) => {
				throw new Error(`ACP agent exited (${signal ?? code})`);
			}),
			connection.closed.then(() => {
				throw new Error("ACP connection closed");
			}),
		]);
	} catch (error) {
		if (stopController.signal.aborted) return;
		if (
			error instanceof Error &&
			"code" in error &&
			error.code === -32000 &&
			/auth|missing api key/i.test(error.message)
		)
			throw new Error(
				`${options.harness} requires authentication. ${options.harness === "antigravity" ? "Run agy acp --login" : "Sign in with its CLI"}, then start the ACP session again.`,
				{ cause: error },
			);
		throw error;
	} finally {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGHUP", stop);
		stopInput?.();
		try {
			await bridge.close();
		} finally {
			child.kill();
			const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
			try {
				if (child.pid) await ended;
			} finally {
				clearTimeout(kill);
				await rm(identityDir, { recursive: true, force: true });
				if (process.stdout.writableLength === 0)
					process.stdout.off("error", stopOutput);
			}
		}
	}
}

/** Keep only a bounded partial line even when stdin is a pipe. */
function readPromptLines(line: (text: string) => void): () => void {
	let fragments: Buffer[] = [];
	let bytes = 0;
	let oversized = false;
	const finish = () => {
		if (oversized) console.error("ACP prompt exceeds the size limit");
		else if (bytes)
			line(Buffer.concat(fragments, bytes).toString("utf8").replace(/\r$/, ""));
		fragments = [];
		bytes = 0;
		oversized = false;
	};
	const read = (chunk: Buffer) => {
		let start = 0;
		while (start < chunk.length) {
			const newline = chunk.indexOf(10, start);
			const end = newline === -1 ? chunk.length : newline;
			const length = end - start;
			if (!oversized && bytes + length <= MAX_PROMPT_BYTES) {
				if (length) fragments.push(Buffer.from(chunk.subarray(start, end)));
				bytes += length;
			} else {
				oversized = true;
				fragments = [];
			}
			if (newline === -1) break;
			finish();
			start = newline + 1;
		}
	};
	process.stdin.on("data", read);
	process.stdin.on("end", finish);
	return () => {
		process.stdin.off("data", read);
		process.stdin.off("end", finish);
		process.stdin.pause();
	};
}
