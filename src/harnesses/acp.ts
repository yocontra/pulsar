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
import type { InteractionResult } from "../service/approvals.ts";
import { autoTags, envTags } from "../tags.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import { PROTOCOL_VERSION, type Registration } from "../types.ts";
import { AcpUsageWriter, loadAcpUsage } from "../usage/acp.ts";
import { VERSION } from "../version.ts";
import { AcpSessionControls } from "./acp-controls.ts";
import { ACP_IDENTITY_ENV } from "./acp-identity.ts";
import { AcpToolResults } from "./acp-tool-results.ts";
import { acpTranscriptPath } from "./acp-transcript.ts";

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
const MAX_PERMISSION_REQUESTS = 16;
const MAX_TEXT = 64 * 1024;
const TRANSCRIPT_UPDATE_MS = 250;

type Prompt = { text: string; messageId?: string; command?: true };

type Turn = {
	prompt: Prompt;
	cancelled: boolean;
	delivered: boolean;
	printed: boolean;
	permissions: Map<string, () => void>;
	tools: AcpToolResults;
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
	private readonly setupUpdates: Array<{
		sessionId: string;
		update: SessionUpdate;
	}> = [];
	private switchingMode = false;
	private usageObserved = false;
	private usageWriter?: AcpUsageWriter;
	private readonly options: AcpBridgeOptions;
	private readonly identityPath: string;
	private readonly queue: Prompt[] = [];
	private readonly received = new Set<string>();
	private readonly receipts = new Map<
		string,
		{ method: "ack" | "nack"; params: unknown }
	>();
	private readonly app: ClientApp;
	private readonly flushingReceipts = new Set<string>();
	private terminalOutput = true;
	private connection?: ClientConnection;
	private sessionId?: string;
	private transcript?: number;
	private turn?: Turn;
	private draining?: Promise<void>;
	private reconnect?: ReturnType<typeof setTimeout>;
	private retryMs = 500;
	private stopping = false;
	private ready = false;
	private capabilities?: AgentCapabilities;
	private registration?: Registration;

	constructor(options: AcpBridgeOptions, identityPath: string) {
		this.options = options;
		this.identityPath = identityPath;
		this.app = new ClientApp()
			.onRequest("session/request_permission", ({ params: request }) =>
				this.permission(request),
			)
			.onNotification("session/update", ({ params: { sessionId, update } }) => {
				if (this.stopping) return;
				if (!this.ready) {
					// Agents may publish their catalog before the setup response.
					if (
						this.setupUpdates.length < 24 &&
						(update.sessionUpdate === "available_commands_update" ||
							update.sessionUpdate === "config_option_update" ||
							update.sessionUpdate === "current_mode_update")
					)
						this.setupUpdates.push({ sessionId, update });
					return;
				}
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
			if (this.receipts.get(messageId)?.method === "ack") {
				void this.flushReceipt(messageId);
				return;
			}
			this.enqueue({ text, messageId });
		});
		this.daemon.on("interrupt", (data) => {
			const { requestId } = data as { requestId: string };
			void this.cancel().then(
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
				clientCapabilities: {},
				clientInfo: { name: "pulsar", version: VERSION },
			},
			startup,
		);
		if (initialized.protocolVersion !== ACP_PROTOCOL_VERSION)
			throw new Error(
				`Unsupported ACP protocol version ${initialized.protocolVersion}`,
			);
		this.capabilities = initialized.agentCapabilities;
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
		} else if (canResume) {
			state = await connection.agent.request<LoadSessionResponse>(
				"session/resume",
				{ ...session, sessionId: requestedId },
				startup,
			);
			this.sessionId = requestedId;
		} else if (canLoad) {
			state = await connection.agent.request<LoadSessionResponse>(
				"session/load",
				{ ...session, sessionId: requestedId },
				startup,
			);
			this.sessionId = requestedId;
		} else {
			throw new Error(
				`${this.options.harness} does not advertise ACP session resume or load`,
			);
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
		this.applySetupUpdates(this.sessionId);
		const path = acpTranscriptPath(this.options.harness, this.sessionId);
		await ensureDir(dirname(path));
		stopSignal.throwIfAborted();
		this.transcript = openSync(path, "a", 0o600);
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
			meta: {
				acp: "1",
				acpResume: canResume || canLoad ? "1" : "0",
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
		this.applySetupUpdates(this.sessionId);
		this.refreshCapabilities();
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
				status: this.turn ? "busy" : "idle",
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

	private receipt(messageId: string, accepted: boolean, reason?: string) {
		if (this.receipts.size >= MAX_RECEIPTS) {
			const oldest = this.receipts.keys().next().value;
			if (oldest) this.receipts.delete(oldest);
		}
		this.receipts.set(
			messageId,
			accepted
				? { method: "ack", params: { messageId, via: "acp" } }
				: { method: "nack", params: { messageId, reason } },
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
			this.switchingMode ||
			!this.queue.length
		)
			return;
		this.draining ??= this.drain().finally(() => {
			this.draining = undefined;
			this.drainQueue();
		});
	}

	private async drain() {
		const connection = this.connection;
		const sessionId = this.sessionId;
		if (!connection || !sessionId) return;
		while (!this.stopping) {
			const prompt = this.queue.shift();
			if (!prompt) return;
			const turn: Turn = {
				prompt,
				cancelled: false,
				delivered: false,
				printed: false,
				permissions: new Map(),
				tools: new AcpToolResults(MAX_TEXT),
			};
			this.turn = turn;
			this.notify("set_status", { status: "busy" });
			try {
				if (!prompt.messageId) this.recordPrompt(prompt);
				const result = await connection.agent.request("session/prompt", {
					sessionId,
					prompt: [{ type: "text", text: prompt.text }],
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
				if (!this.queue.length || this.stopping)
					this.notify("set_status", { status: "idle" });
			}
		}
	}

	private finishPermissions(turn: Turn) {
		for (const cancel of turn.permissions.values()) cancel();
	}

	async cancel(): Promise<"not-running" | "interrupted"> {
		const turn = this.turn;
		if (!turn || !this.connection || !this.sessionId) return "not-running";
		turn.cancelled = true;
		this.finishPermissions(turn);
		await this.connection.agent.notify("session/cancel", {
			sessionId: this.sessionId,
		});
		return "interrupted";
	}

	private async permission(
		request: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		const turn = this.turn;
		const cancelled = { outcome: { outcome: "cancelled" } } as const;
		if (!turn || turn.cancelled || request.sessionId !== this.sessionId)
			return cancelled;
		this.confirmDelivery(turn);
		const ids = new Set(request.options.map((option) => option.optionId));
		if (ids.size !== request.options.length) return cancelled;
		const allow = request.options.find(
			(option) => option.kind === "allow_once",
		);
		const deny = request.options.find(
			(option) => option.kind === "reject_once",
		);
		const select = (optionId: string): RequestPermissionResponse => ({
			outcome: { outcome: "selected", optionId },
		});
		if (
			!allow ||
			!this.daemon.connected ||
			request.toolCall.rawInput == null ||
			turn.permissions.size >= MAX_PERMISSION_REQUESTS
		)
			return deny ? select(deny.optionId) : cancelled;

		const ref = randomUUID();
		const stopped = new Promise<null>((done) => {
			turn.permissions.set(ref, () => {
				this.notify("interaction.local", { ref });
				done(null);
			});
		});
		try {
			const result = await Promise.race([
				stopped,
				this.daemon
					.call<{ result: InteractionResult | null }>(
						"interaction.ask",
						{
							ref,
							kind: "permission",
							tool:
								request.toolCall.title ?? request.toolCall.kind ?? "ACP tool",
							input: {
								arguments: request.toolCall.rawInput,
								option: allow.name,
							},
							timeoutMs: PERMISSION_TIMEOUT_MS,
						},
						PERMISSION_TIMEOUT_MS + 1000,
					)
					.catch(() => null),
			]);
			if (turn.cancelled) return cancelled;
			if (result?.result?.decision === "allow-once")
				return select(allow.optionId);
			return deny ? select(deny.optionId) : cancelled;
		} finally {
			turn.permissions.delete(ref);
		}
	}

	private applySetupUpdates(sessionId: string) {
		for (const pending of this.setupUpdates.splice(0)) {
			if (pending.sessionId === sessionId) this.controls.update(pending.update);
		}
	}

	private runtimeMeta() {
		return {
			acpModes: this.controls.selection?.modes.length ? "1" : "0",
			acpCommands: this.controls.commands.length ? "1" : "0",
			acpUsage: this.usageObserved ? "1" : "0",
		};
	}

	private refreshCapabilities() {
		const registration = this.registration;
		if (!registration) return;
		const next = this.runtimeMeta();
		if (
			Object.entries(next).every(
				([key, value]) => registration.meta?.[key] === value,
			)
		)
			return;
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
		} else if (this.turn) {
			this.update(this.turn, update);
		}
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
		const modes = this.controls.selection;
		const busy = !!this.turn || this.switchingMode || this.queue.length > 0;
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
		if (request.kind === "commands")
			return {
				result: "ok",
				commands: this.controls.commands,
				runnable: !busy && this.controls.commands.length > 0,
				...(busy
					? { detail: "Wait for the current ACP operation to finish." }
					: {}),
			};
		if (busy)
			return {
				result: "busy",
				detail: "Wait for the current ACP operation to finish.",
			};
		if (request.kind === "mode.set" && typeof request.mode === "string") {
			this.switchingMode = true;
			try {
				return await this.controls.select(
					this.connection.agent,
					this.sessionId,
					request.mode,
				);
			} finally {
				this.switchingMode = false;
				this.refreshCapabilities();
				this.drainQueue();
			}
		}
		if (request.kind === "command" && typeof request.line === "string") {
			const line = request.line;
			const name = /^\/([A-Za-z0-9][A-Za-z0-9:_.-]{0,127})(?: |$)/.exec(
				line,
			)?.[1];
			if (
				line.length <= 4000 &&
				!/\p{Cc}/u.test(line) &&
				this.controls.commands.some((entry) => entry.name === name)
			) {
				this.enqueue({ text: line, command: true });
				return { result: "ok" };
			}
			return {
				result: "unsupported",
				detail: "The agent did not advertise this ACP command.",
			};
		}
		return { result: "unsupported", detail: "Unknown ACP control request." };
	}

	private confirmDelivery(turn: Turn) {
		if (turn.delivered) return;
		turn.delivered = true;
		if (turn.prompt.messageId) this.recordPrompt(turn.prompt);
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
		const result = turn.tools.apply(update);
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
		clearTimeout(this.reconnect);
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
