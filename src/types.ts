/** Wire protocol version. Bump on any breaking change to daemon RPC. */
export const PROTOCOL_VERSION = 1;

export const HARNESSES = [
	"claude",
	"codex",
	"opencode",
	"omp",
	"pi",
	"cursor",
	"gemini",
	"vscode",
	"cli",
	"unknown",
] as const;
export type Harness = (typeof HARNESSES)[number];

export type AgentStatus = "busy" | "idle" | "unknown" | "gone";
export type InboundPolicy = "accept" | "hold" | "refuse";
export type Priority = "urgent" | "normal" | "fyi";

/** How a message can reach the agent without it asking. */
export type Reach = "push" | "pull";

export interface Agent {
	/** Stable id: `<harness>:<session id>` when known, else `<harness>:pid:<pid>`. */
	id: string;
	name: string;
	harness: Harness;
	sessionId: string | null;
	pid: number | null;
	cwd: string | null;
	project: string | null;
	branch: string | null;
	/** `key:value` or bare tags. Auto-tags plus self-tags. */
	tags: string[];
	status: AgentStatus;
	/** The model the session runs, e.g. `claude-fable-5-2` or `gpt-5.5`. */
	model: string | null;
	/** What the agent says it is doing, e.g. "reviewing PR #1402". */
	summary: string | null;
	inbound: InboundPolicy;
	/** true when the agent runs the pulsar MCP server or extension. */
	registered: boolean;
	reach: Reach;
	lastSeen: number;
	createdAt: number;
	/** Adapter data, e.g. the Claude socket path. Never returned to agents. */
	meta: Record<string, string>;
}

export type PublicAgent = Omit<Agent, "meta">;

export interface Message {
	id: string;
	threadId: string;
	fromId: string;
	fromName: string;
	/** The `to` the sender used: a name, id, selector or `*`. */
	to: string;
	body: string;
	priority: Priority;
	replyTo: string | null;
	expectReply: boolean;
	createdAt: number;
}

export type ReceiptState =
	| "queued"
	/** Handed to the harness (socket, CLI, API). The harness may still hold it. */
	| "sent"
	/** The receiving session confirmed it injected the message. */
	| "delivered"
	| "read"
	| "replied"
	| "held"
	| "refused"
	| "failed";

export interface Receipt {
	messageId: string;
	agentId: string;
	agentName: string;
	state: ReceiptState;
	via: string | null;
	detail: string | null;
	updatedAt: number;
}

/** What the daemon learns about a session when it registers. */
export interface Registration {
	harness: Harness;
	sessionId: string | null;
	pid: number | null;
	cwd: string | null;
	project: string | null;
	branch: string | null;
	tags: string[];
	name?: string;
	model?: string | null;
	/** Adapter hints, e.g. claude socket path. */
	meta?: Record<string, string>;
	/** "mcp" | "extension" | "cli". An extension can push into its own session. */
	role: "mcp" | "extension" | "cli";
}

export interface DeliveredMessage extends Message {
	from: {
		id: string;
		name: string;
		harness: Harness;
		project: string | null;
	};
}
