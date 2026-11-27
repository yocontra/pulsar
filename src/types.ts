/** Wire protocol version. Bump on any breaking change to daemon RPC. */
export const PROTOCOL_VERSION = 1;

/**
 * A harness id: one of the drivers in src/harnesses, or the pseudo-harnesses
 * "cli" (a plain terminal) and "unknown" (no harness found).
 */
export type Harness = string;

/** Longest an `ask` or `wait` call may block. Harness tool timeouts must exceed it. */
export const MAX_BLOCK_SECONDS = 1800;

export type AgentStatus = "busy" | "idle" | "unknown" | "gone";
export type InboundPolicy = "accept" | "hold" | "refuse";
export type Priority = "urgent" | "normal" | "fyi";

/** How a message can reach the agent without it asking. */
type Reach = "push" | "pull";

/**
 * The app's HTTP transport as the daemon reports it (`status`; doctor
 * shows it). Absent from older daemons.
 */
export type AppStatus =
	/** The agent mesh is off on this machine. */
	| { state: "off" }
	/** The first try (or a try after the addresses changed) is running. */
	| { state: "starting" }
	| { state: "serving"; url: string; hosts: string[] }
	| {
			state: "retrying";
			/** Why the last try failed. */
			error: string;
			/** Tailscale was not up yet (not running, logged out or unreachable). */
			tailscale: boolean;
			/** Failed tries so far. */
			attempt: number;
			/** When the first of these failures was (ms since the epoch). */
			since: number;
			/** When the next try runs (ms since the epoch). */
			retryAt: number;
	  };

export interface SessionCapabilities {
	surface: "attached" | "managed-acp";
	host?: string;
	inbox: boolean;
	wake: boolean;
	/** A connected native relay can wake this agent's own child conversations. */
	childWake?: boolean;
	steer?: boolean;
	stop: boolean;
	status: boolean;
	transcript: boolean;
	subagents: boolean;
	resume?: boolean;
	modes?: boolean;
	commands?: boolean;
	skills?: boolean;
	approvals?: boolean;
	questions?: boolean;
	/** Uploaded files can be referenced by path on the agent’s machine. */
	attachments?: boolean;
	usage?: boolean;
}

export interface Agent {
	/** Observed on the owning node. Older peers omit this field. */
	capabilities?: SessionCapabilities;
	/** Stable id: `<harness>:<session id>` when known, else `<harness>:pid:<pid>`. */
	id: string;
	name: string;
	harness: Harness;
	sessionId: string | null;
	pid: number | null;
	cwd: string | null;
	project: string | null;
	branch: string | null;
	/**
	 * The web page of the repo the agent pushes to (`https://host/owner/repo`,
	 * no credentials), from its git remote; null or absent when unknown.
	 * Absent from older daemons and peers.
	 */
	repoUrl?: string | null;
	/**
	 * The machine the agent runs on (MagicDNS short name, else the host name).
	 * The daemon always sets it; optional so records from 1.x daemons still fit.
	 */
	machine?: string;
	/** `key:value` or bare tags. Auto-tags plus self-tags. */
	tags: string[];
	status: AgentStatus;
	/** The model the session runs, e.g. `claude-fable-5-2` or `gpt-5.5`. */
	model: string | null;
	/** What the agent says it is doing, e.g. "reviewing PR #1402". */
	activity: string | null;
	inbound: InboundPolicy;
	/** true when the agent runs the pulsar MCP server or extension. */
	registered: boolean;
	reach: Reach;
	lastSeen: number;
	createdAt: number;
	/** Adapter data, e.g. the Claude socket path. Never returned to agents. */
	meta: Record<string, string>;
}

/**
 * A session the scanner only guessed (`meta.sessionFrom = "folder"`: the
 * latest session in an open OpenCode TUI's folder) that has not shown it is
 * in use by connecting to pulsar itself.
 */
export function isFolderGuess(agent: Agent): boolean {
	return agent.meta.sessionFrom === "folder" && !agent.registered;
}

export type PublicAgent = Omit<Agent, "meta"> & {
	/** Provider conversation title, for display only. */
	conversationTitle?: string;
	/**
	 * `folder`: not a session the harness named but a guess, the latest
	 * session in the folder of an open OpenCode TUI. Inbox only: sends never
	 * wake or resume it.
	 */
	sessionFrom?: "folder";
};

export interface Message {
	/** Opaque operator-uploaded image references at the recipient’s home node. */
	imageRefs?: string[];
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
	/**
	 * How Pulsar tracks it (docs/delivery.md): 0 not at all, 1 redelivered
	 * after a restart only (a group ask), 2 the full treatment (a
	 * single-recipient ask: ack timeout, lease, dead letter). Absent: 0.
	 */
	tracked?: 0 | 1 | 2;
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
	| "failed"
	/** The agent took it on (`ack`). */
	| "acked"
	/** The agent finished it (`done`). */
	| "done"
	/** The agent declined it for good (`nack` without retry). */
	| "nacked"
	/** Its time to live passed before it was done. */
	| "expired"
	/** Pulsar gave up after the last attempt. */
	| "dead"
	/** The operator withdrew it before it reached the session (the queue strip). */
	| "withdrawn";

/** Every receipt state, for validation (HTTP filters, peer receipts). */
export const RECEIPT_STATES: readonly ReceiptState[] = [
	"queued",
	"sent",
	"delivered",
	"read",
	"replied",
	"held",
	"refused",
	"failed",
	"acked",
	"done",
	"nacked",
	"expired",
	"dead",
	"withdrawn",
];

/** States after which a receipt never changes within its attempt. */
export const FINAL_STATES: ReadonlySet<ReceiptState> = new Set([
	"replied",
	"done",
	"nacked",
	"expired",
	"dead",
	"withdrawn",
]);

export interface Receipt {
	messageId: string;
	agentId: string;
	agentName: string;
	state: ReceiptState;
	via: string | null;
	detail: string | null;
	updatedAt: number;
	/** Which delivery attempt this is (1 unless redelivered). */
	attempt?: number;
	/** `done`'s result or `nack`'s reason. */
	result?: string | null;
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
	/** An extension controls its session. A wake relay only delivers prompts. */
	role: "mcp" | "extension" | "cli" | "wake";
	/**
	 * What the client can do. `acks`: its agent has the `ack`/`done`/`nack`
	 * tools, so an unacked tracked message may be redelivered on a timer.
	 */
	capabilities?: string[];
	/** Private nonce shared only by the native MCP host's per-conversation connections. */
	nativeHostToken?: string;
	/**
	 * A session id that survives a restart when the agent id does not (pi and
	 * omp ids are the pid). Tracked messages follow it to the new agent.
	 */
	resumeKey?: string;
	/** An OMP extension bound to a child session persisted by its own process. */
	subagent?: { file: string; key: string };
}

export interface DeliveredMessage extends Message {
	/** Set on a redelivery: this is attempt `attempt` of at most `maxAttempts`. */
	attempt?: number;
	maxAttempts?: number;
	from: {
		id: string;
		name: string;
		harness: Harness;
		project: string | null;
	};
}
