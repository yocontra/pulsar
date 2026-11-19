/**
 * A minimal MCP server over stdio: newline-delimited JSON-RPC 2.0 with the
 * methods pulsar serves (tools, one resource, logging, ping).
 *
 * One of these runs per agent session, so it stays small on purpose: no SDK,
 * no schema library. Tool inputs are described with plain JSON Schema (the
 * subset `schema` below builds) and checked by `validate`.
 */

const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = [
	LATEST_PROTOCOL_VERSION,
	"2025-06-18",
	"2025-03-26",
	"2024-11-05",
	"2024-10-07",
];

const LOG_LEVELS = [
	"debug",
	"info",
	"notice",
	"warning",
	"error",
	"critical",
	"alert",
	"emergency",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A JSON Schema property: the subset pulsar's tools use. */
export interface Prop {
	type: "string" | "boolean" | "integer" | "array";
	description?: string;
	minLength?: number;
	minimum?: number;
	maximum?: number;
	enum?: readonly string[];
	items?: { type: "string" };
}

export interface InputSchema {
	type: "object";
	properties: Record<string, Prop>;
	required?: string[];
}

/** Builds input schemas: `schema.str({ min: 1 })`, then `object({...}, ["to"])`. */
export const schema = {
	str(o: { min?: number; description?: string } = {}): Prop {
		return {
			type: "string",
			...(o.min !== undefined ? { minLength: o.min } : {}),
			...(o.description ? { description: o.description } : {}),
		};
	},
	bool(description?: string): Prop {
		return { type: "boolean", ...(description ? { description } : {}) };
	},
	int(o: { min?: number; max?: number; description?: string } = {}): Prop {
		return {
			type: "integer",
			...(o.min !== undefined ? { minimum: o.min } : {}),
			...(o.max !== undefined ? { maximum: o.max } : {}),
			...(o.description ? { description: o.description } : {}),
		};
	},
	oneOf(values: readonly string[], description?: string): Prop {
		return {
			type: "string",
			enum: values,
			...(description ? { description } : {}),
		};
	},
	strings(description?: string): Prop {
		return {
			type: "array",
			items: { type: "string" },
			...(description ? { description } : {}),
		};
	},
	object(properties: Record<string, Prop>, required: string[] = []) {
		return {
			type: "object" as const,
			properties,
			...(required.length ? { required } : {}),
		};
	},
};

function typeName(v: unknown): string {
	if (v === undefined) return "undefined";
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

/**
 * Every problem with `args` against `s`, one per line in property order
 * (as zod reported them), or null when they fit. `args` must be an object.
 */
function validate(
	s: InputSchema,
	args: Record<string, unknown>,
): string | null {
	const problems: string[] = [];
	const required = new Set(s.required ?? []);
	for (const [key, p] of Object.entries(s.properties)) {
		const v = args[key];
		if (v === undefined) {
			if (required.has(key))
				problems.push(
					`Invalid input: expected ${p.type === "integer" ? "number" : p.type}, received undefined at ${key}`,
				);
			continue;
		}
		const problem = check(p, v);
		if (problem) problems.push(`${problem.text} at ${key}${problem.at ?? ""}`);
	}
	return problems.length ? problems.join("\n") : null;
}

function check(p: Prop, v: unknown): { text: string; at?: string } | null {
	const bad = (text: string, at?: string) => ({ text, ...(at ? { at } : {}) });
	switch (p.type) {
		case "string":
			// An enum refuses any other value, string or not, with one message.
			if (p.enum && !p.enum.includes(v as string))
				return bad(
					`Invalid option: expected one of ${p.enum.map((e) => JSON.stringify(e)).join("|")}`,
				);
			if (typeof v !== "string")
				return bad(`Invalid input: expected string, received ${typeName(v)}`);
			if (p.enum && !p.enum.includes(v))
				return bad(
					`Invalid option: expected one of ${p.enum.map((e) => JSON.stringify(e)).join("|")}`,
				);
			if (p.minLength !== undefined && v.length < p.minLength)
				return bad(
					`Too small: expected string to have >=${p.minLength} characters`,
				);
			return null;
		case "boolean":
			return typeof v === "boolean"
				? null
				: bad(`Invalid input: expected boolean, received ${typeName(v)}`);
		case "integer":
			if (typeof v !== "number" || Number.isNaN(v))
				return bad(`Invalid input: expected number, received ${typeName(v)}`);
			if (!Number.isInteger(v))
				return bad("Invalid input: expected int, received number");
			if (p.minimum !== undefined && v < p.minimum)
				return bad(`Too small: expected number to be >=${p.minimum}`);
			if (p.maximum !== undefined && v > p.maximum)
				return bad(`Too big: expected number to be <=${p.maximum}`);
			return null;
		case "array":
			if (!Array.isArray(v))
				return bad(`Invalid input: expected array, received ${typeName(v)}`);
			for (const [n, item] of v.entries())
				if (typeof item !== "string")
					return bad(
						`Invalid input: expected string, received ${typeName(item)}`,
						`[${n}]`,
					);
			return null;
	}
}

export interface ToolResult {
	content: { type: "text"; text: string }[];
	isError?: boolean;
}

export interface Tool {
	name: string;
	title: string;
	description: string;
	inputSchema: InputSchema;
	annotations?: { readOnlyHint?: boolean };
	/** Callable but left out of tools/list (an old name kept for cached tool lists). */
	hidden?: boolean;
	/** Runs with arguments already checked against inputSchema. */
	handler: (
		args: never,
		meta: Record<string, unknown> | undefined,
	) => Promise<ToolResult>;
}

export interface Resource {
	uri: string;
	name: string;
	title: string;
	description: string;
	mimeType: string;
	read: () => Promise<string>;
}

type Id = string | number;
interface Request {
	jsonrpc?: string;
	id?: Id | null;
	method?: string;
	params?: Record<string, unknown>;
}

class RpcFailure extends Error {
	readonly code: number;
	constructor(code: number, message: string) {
		super(message);
		this.code = code;
	}
}

/** A bad `params` field, as the SDK's zod schema reported it (-32603). */
function paramsError(field: string, expected: string, v: unknown) {
	return new RpcFailure(
		-32603,
		JSON.stringify(
			[
				{
					expected,
					code: "invalid_type",
					path: ["params", field],
					message: `Invalid input: expected ${expected}, received ${typeName(v)}`,
				},
			],
			null,
			2,
		),
	);
}

/** Lines longer than this are dropped (the SDK's stdio limit was 10 MB too). */
const MAX_LINE = 10 * 1024 * 1024;

export class McpStdioServer {
	private readonly tools = new Map<string, Tool>();
	private readonly resources = new Map<string, Resource>();
	private logLevel: LogLevel | null = null;
	private readonly info: { name: string; version: string };
	private readonly instructions: string;

	constructor(info: { name: string; version: string }, instructions: string) {
		this.info = info;
		this.instructions = instructions;
	}

	tool(t: Tool) {
		this.tools.set(t.name, t);
	}

	resource(r: Resource) {
		this.resources.set(r.uri, r);
	}

	/** Reads requests from stdin and answers on stdout until stdin ends. */
	listen(input: NodeJS.ReadableStream = process.stdin) {
		// Only each new chunk is searched for newlines; a line over MAX_LINE is
		// dropped whole.
		let parts: string[] = [];
		let pending = 0;
		let overflow = false;
		input.setEncoding("utf8");
		input.on("data", (chunk: string) => {
			let start = 0;
			let nl = chunk.indexOf("\n");
			while (nl !== -1) {
				const tail = chunk.slice(start, nl);
				if (!overflow && pending + tail.length <= MAX_LINE) {
					const line = parts.length ? parts.join("") + tail : tail;
					if (line.trim()) this.onLine(line);
				}
				parts = [];
				pending = 0;
				overflow = false;
				start = nl + 1;
				nl = chunk.indexOf("\n", start);
			}
			if (start < chunk.length && !overflow) {
				pending += chunk.length - start;
				if (pending > MAX_LINE) {
					overflow = true;
					parts = [];
				} else parts.push(start ? chunk.slice(start) : chunk);
			}
		});
	}

	private send(message: unknown) {
		process.stdout.write(`${JSON.stringify(message)}\n`);
	}

	notify(method: string, params: Record<string, unknown>) {
		this.send({ jsonrpc: "2.0", method, params });
	}

	sendResourceUpdated(uri: string) {
		this.notify("notifications/resources/updated", { uri });
	}

	sendLog(level: LogLevel, logger: string, data: string) {
		if (
			this.logLevel &&
			LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.logLevel)
		)
			return;
		this.notify("notifications/message", { level, logger, data });
	}

	/** Requests in flight; a cancelled one gets no response (as the spec asks). */
	private readonly inFlight = new Map<Id, { cancelled: boolean }>();

	private onLine(line: string) {
		let msg: Request;
		try {
			msg = JSON.parse(line) as Request;
		} catch {
			return;
		}
		// Like the SDK: only JSON-RPC 2.0 objects (no batches); responses and
		// junk are ignored, since this server sends no requests.
		if (
			!msg ||
			typeof msg !== "object" ||
			Array.isArray(msg) ||
			msg.jsonrpc !== "2.0" ||
			typeof msg.method !== "string"
		)
			return;
		const id = msg.id;
		if (id === undefined) {
			if (msg.method === "notifications/cancelled") {
				const target = this.inFlight.get(msg.params?.requestId as Id);
				if (target) target.cancelled = true;
			}
			return;
		}
		if (typeof id !== "string" && typeof id !== "number") return;
		const state = { cancelled: false };
		this.inFlight.set(id, state);
		const reply = (body: { result: unknown } | { error: unknown }) => {
			if (this.inFlight.get(id) === state) this.inFlight.delete(id);
			if (!state.cancelled) this.send({ jsonrpc: "2.0", id, ...body });
		};
		this.handle(msg.method, msg.params ?? {}).then(
			(result) => reply({ result }),
			(e: unknown) =>
				reply({
					error: {
						code: e instanceof RpcFailure ? e.code : -32603,
						message: (e as Error).message,
					},
				}),
		);
	}

	private async handle(
		method: string,
		params: Record<string, unknown>,
	): Promise<unknown> {
		switch (method) {
			case "initialize": {
				const asked = params.protocolVersion;
				return {
					protocolVersion:
						typeof asked === "string" &&
						SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
							? asked
							: LATEST_PROTOCOL_VERSION,
					capabilities: {
						resources: { subscribe: true, listChanged: true },
						logging: {},
						tools: { listChanged: true },
					},
					serverInfo: this.info,
					instructions: this.instructions,
				};
			}
			case "ping":
				return {};
			case "tools/list":
				return {
					tools: [...this.tools.values()]
						.filter((t) => !t.hidden)
						.map((t) => ({
							name: t.name,
							title: t.title,
							description: t.description,
							inputSchema: {
								$schema: "http://json-schema.org/draft-07/schema#",
								...t.inputSchema,
							},
							...(t.annotations ? { annotations: t.annotations } : {}),
							execution: { taskSupport: "forbidden" },
						})),
				};
			case "tools/call":
				return this.callTool(params);
			case "resources/list":
				return {
					resources: [...this.resources.values()].map((r) => ({
						uri: r.uri,
						name: r.name,
						title: r.title,
						description: r.description,
						mimeType: r.mimeType,
					})),
				};
			case "resources/templates/list":
				return { resourceTemplates: [] };
			case "resources/read": {
				const uri = String(params.uri);
				const r = this.resources.get(uri);
				if (!r)
					throw new RpcFailure(
						-32602,
						`MCP error -32602: Resource ${uri} not found`,
					);
				return { contents: [{ uri, text: await r.read() }] };
			}
			// Updates go out for every resource anyway; nothing to record.
			case "resources/subscribe":
			case "resources/unsubscribe":
				return {};
			case "logging/setLevel": {
				const level = params.level as LogLevel;
				if (!LOG_LEVELS.includes(level))
					throw new RpcFailure(-32602, `Invalid log level: ${String(level)}`);
				this.logLevel = level;
				return {};
			}
			default:
				throw new RpcFailure(-32601, "Method not found");
		}
	}

	private async callTool(params: Record<string, unknown>): Promise<ToolResult> {
		// Malformed params are a JSON-RPC error, worded as the SDK's zod check was.
		if (typeof params.name !== "string")
			throw paramsError("name", "string", params.name);
		const raw = params.arguments;
		if (
			raw !== undefined &&
			(typeof raw !== "object" || raw === null || Array.isArray(raw))
		)
			throw paramsError("arguments", "record", raw);
		const name = params.name;
		const tool = this.tools.get(name);
		const fail = (text: string): ToolResult => ({
			content: [{ type: "text", text: `MCP error -32602: ${text}` }],
			isError: true,
		});
		if (!tool) return fail(`Tool ${name} not found`);
		const args = (raw ?? {}) as Record<string, unknown>;
		const problem = validate(tool.inputSchema, args);
		if (problem)
			return fail(
				`Input validation error: Invalid arguments for tool ${name}: ${problem}`,
			);
		const meta = params._meta as Record<string, unknown> | undefined;
		try {
			return await tool.handler(args as never, meta);
		} catch (e) {
			return {
				content: [{ type: "text", text: (e as Error).message }],
				isError: true,
			};
		}
	}
}
