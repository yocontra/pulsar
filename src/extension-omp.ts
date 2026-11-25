/** Pulsar connections and tools for OMP's individually bound child sessions. */
import { basename, isAbsolute } from "node:path";
import { DaemonClient } from "./client.ts";
import {
	type InputSchema,
	type Prop,
	type ToolResult,
	validateToolInput,
} from "./mcp-server.ts";
import {
	PULSAR_TOOL_INSTRUCTIONS,
	type PulsarToolSession,
	registerPulsarTools,
} from "./mcp-tools.ts";
import { RpcError } from "./rpc.ts";
import type { DeliveredMessage, PublicAgent, Registration } from "./types.ts";
import { PROTOCOL_VERSION } from "./types.ts";
import { VERSION } from "./version.ts";

export interface OmpChildContext {
	agent?: { kind?: string };
	cwd?: string;
	sessionManager?: { getSessionFile?(): string | undefined };
}

export interface OmpChildTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	promptGuidelines: string[];
	loadMode: "essential";
	approval: "read" | "write";
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: unknown,
		context: OmpChildContext,
	) => Promise<ToolResult & { details: null }>;
}

export interface OmpChildApi {
	registerTool?(tool: OmpChildTool): void;
	typebox?: { Type?: TypeBox };
	getAllTools?(): Array<{ name: string; mcpServerName?: string }>;
	sendMessage(
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options: { triggerTurn: boolean; deliverAs: string },
	): unknown;
}

type Client = Pick<
	DaemonClient,
	"connected" | "call" | "on" | "onClose" | "close"
> & {
	connect(autoStart?: boolean): Promise<unknown>;
};

interface TypeBox {
	Object(properties: Record<string, unknown>): unknown;
	String(options?: Record<string, unknown>): unknown;
	Integer(options?: Record<string, unknown>): unknown;
	Boolean(options?: Record<string, unknown>): unknown;
	Array(item: unknown, options?: Record<string, unknown>): unknown;
	Literal(value: string): unknown;
	Union(members: unknown[], options?: Record<string, unknown>): unknown;
	Optional(member: unknown): unknown;
}

function extensionSchema(t: TypeBox, schema: InputSchema) {
	const required = new Set(schema.required);
	function convert(prop: Prop) {
		const { type, enum: values, items: _items, ...options } = prop;
		switch (type) {
			case "string":
				return values
					? t.Union(
							values.map((value) => t.Literal(value)),
							options,
						)
					: t.String(options);
			case "integer":
				return t.Integer(options);
			case "boolean":
				return t.Boolean(options);
			case "array":
				return t.Array(t.String(), options);
		}
	}
	return t.Object(
		Object.fromEntries(
			Object.entries(schema.properties).map(([key, prop]) => {
				const parameter = convert(prop);
				return [key, required.has(key) ? parameter : t.Optional(parameter)];
			}),
		),
	);
}

interface Route {
	file: string;
	key: string;
}

function childRoute(ctx: OmpChildContext | undefined): Route | null {
	try {
		if (ctx?.agent?.kind !== "sub") return null;
		const file = ctx.sessionManager?.getSessionFile?.();
		if (!file || !isAbsolute(file) || !file.endsWith(".jsonl")) return null;
		const key = basename(file, ".jsonl");
		if (!/^[A-Za-z0-9._-]{1,100}$/.test(key)) return null;
		return { file, key };
	} catch {
		return null;
	}
}

export function isOmpChild(ctx: OmpChildContext | undefined): boolean {
	try {
		return ctx?.agent?.kind === "sub";
	} catch {
		return false;
	}
}

export function ompChildMessaging(
	api: OmpChildApi,
	client: Client = new DaemonClient(),
) {
	let route: Route | null = null;
	let current: OmpChildContext | undefined;
	let ready = false;
	const session: PulsarToolSession = {
		me: null,
		async call(method, params, timeoutMs) {
			await connect();
			if (stopped) throw new RpcError("closed", "OMP child session ended.");
			if (!ready || !client.connected)
				throw new Error("Pulsar child connection is unavailable.");
			return client.call(method, params, timeoutMs);
		},
	};
	let stopped = false;
	let unsupported = false;
	let connecting: Promise<void> | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let retryMs = 500;
	const buffered: unknown[] = [];
	const pendingAcks = new Set<string>();

	async function ack(messageId: string) {
		try {
			await client.call("ack", { messageId, via: "extension" });
			pendingAcks.delete(messageId);
		} catch (e) {
			// Only disconnection/timeouts can benefit from a retry.
			if (e instanceof RpcError) pendingAcks.delete(messageId);
		}
	}

	function schedule() {
		if (stopped || unsupported || ready || !route || retry) return;
		retry = setTimeout(() => {
			retry = null;
			void connect();
		}, retryMs);
		retry.unref?.();
		retryMs = Math.min(retryMs * 2, 15_000);
	}

	async function bind(target: Route) {
		await client.connect(false);
		if (stopped) return client.close();
		const hello = await client.call<{ ompChildMessaging?: boolean }>("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
		});
		if (stopped) return client.close();
		if (hello.ompChildMessaging !== true) {
			unsupported = true;
			return client.close();
		}
		const registration: Registration = {
			harness: "omp",
			pid: process.pid,
			sessionId: null,
			cwd: current?.cwd ?? null,
			project: null,
			branch: null,
			tags: [],
			role: "extension",
			...(api.registerTool && api.typebox?.Type
				? { capabilities: ["acks"] }
				: {}),
			subagent: target,
		};
		const reply = await client.call<{ agent?: PublicAgent }>("hello", {
			protocol: PROTOCOL_VERSION,
			version: VERSION,
			registration,
		});
		if (stopped) return client.close();
		if (!reply.agent?.id?.endsWith(`/sub:${target.key}`)) {
			unsupported = true;
			throw new Error("Pulsar did not bind the OMP child connection");
		}
		session.me = reply.agent;
		ready = true;
		retryMs = 500;
		for (const id of pendingAcks) void ack(id);
		for (const data of buffered.splice(0)) void push(data);
	}

	function connect() {
		if (stopped || unsupported || ready || !route) return Promise.resolve();
		connecting ??= bind(route)
			.catch(() => {
				buffered.length = 0;
				client.close();
			})
			.finally(() => {
				connecting = null;
				schedule();
			});
		return connecting;
	}

	async function push(data: unknown) {
		const { message, text } = (data ?? {}) as {
			message?: DeliveredMessage;
			text?: string;
		};
		if (!message?.id || typeof text !== "string" || stopped || !ready) return;
		if (pendingAcks.has(message.id)) return ack(message.id);
		try {
			if (childRoute(current)?.file !== route?.file)
				throw new Error("OMP child session changed");
			await api.sendMessage(
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
		} catch (e) {
			await client
				.call("nack", { messageId: message.id, reason: (e as Error).message })
				.catch(() => {});
			return;
		}
		if (pendingAcks.size >= 256) {
			const oldest = pendingAcks.values().next().value;
			if (oldest) pendingAcks.delete(oldest);
		}
		pendingAcks.add(message.id);
		await ack(message.id);
	}

	client.on("push", (data) => {
		if (ready) void push(data);
		else if (connecting && !stopped && buffered.length < 128)
			buffered.push(data);
	});
	client.onClose(() => {
		ready = false;
		buffered.length = 0;
		if (!connecting) schedule();
	});

	const error = (text: string): ToolResult & { details: null } => ({
		content: [{ type: "text", text }],
		isError: true,
		details: null,
	});
	const registerTools = () => {
		const t = api.typebox?.Type;
		if (!t || !api.registerTool) return;
		registerPulsarTools(
			(tool) => {
				if (tool.hidden) return;
				// A reply footer supplies the message ID and normal reply is the default.
				const respond = tool.name === "respond";
				const schema = respond
					? { ...tool.inputSchema, required: ["message_id"] }
					: tool.inputSchema;
				api.registerTool?.({
					name: `pulsar_${tool.name}`,
					label: tool.title,
					description: tool.description,
					parameters: extensionSchema(t, schema),
					loadMode: "essential",
					approval: tool.annotations?.readOnlyHint ? "read" : "write",
					promptGuidelines: respond
						? [
								PULSAR_TOOL_INSTRUCTIONS.replace(
									"Tools: list_agents, send, respond, wait, inbox, set_identity.",
									"Use the local pulsar_ tools to speak as this child.",
								),
							]
						: [],
					async execute(_id, input, signal, _update, context) {
						if (stopped || !route || childRoute(context)?.file !== route.file)
							return error("Pulsar requires the matching OMP child session.");
						if (signal?.aborted) return error("Pulsar tool cancelled.");
						const args = respond ? { state: "reply", ...input } : input;
						const problem = validateToolInput(tool.inputSchema, args);
						if (problem) return error(problem);
						const answer = await tool.handler(args as never, undefined);
						return { ...answer, details: null };
					},
				});
			},
			async () => session,
		);
	};

	return {
		start(ctx: OmpChildContext | undefined) {
			current = ctx;
			const next = childRoute(ctx);
			if (!next) return;
			if (!route) {
				route = next;
				registerTools();
			}
			return connect();
		},
		observe(ctx: OmpChildContext | undefined) {
			if (isOmpChild(ctx)) current = ctx;
		},
		stop() {
			stopped = true;
			ready = false;
			buffered.length = 0;
			if (retry) clearTimeout(retry);
			retry = null;
			client.close();
		},
		blockParentMcp(event: unknown, ctx: OmpChildContext | undefined) {
			if (!isOmpChild(ctx)) return;
			const call = event as { toolName?: unknown; input?: { path?: unknown } };
			const name = call?.toolName;
			if (typeof name !== "string") return;
			const readInbox =
				name === "read" &&
				typeof call.input?.path === "string" &&
				/(?:mcp:\/\/)?pulsar:\/\/inbox\b/i.test(call.input.path);
			if (
				readInbox ||
				/^mcp__pulsar_/i.test(name) ||
				api
					.getAllTools?.()
					.some(
						(tool) =>
							tool.name === name &&
							tool.mcpServerName?.toLowerCase() === "pulsar",
					)
			)
				return {
					block: true,
					reason: "Use the local pulsar_ tools from this OMP child session.",
				};
		},
	};
}
