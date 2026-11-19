import type {
	Approval,
	ApprovalDecision,
	ChangesMode,
	NeedsYou,
	SubagentCounts,
	TurnKind,
	UsagePeriod,
	Wake,
} from "../http/wire.ts";
import type { Message, PublicAgent, Receipt, ReceiptState } from "../types.ts";

/**
 * The federation protocol between pulsar nodes (`/fed/v1`). See
 * docs/federation.md for ordering and failure behavior.
 *
 * Down (GET, Server-Sent Events): `/fed/v1/stream` sends this node's own
 * agents as a `snapshot`, then `delta`s, each with `(bootId, seq)`.
 * `/fed/v1/transcript` streams one agent's live transcript, `/fed/v1/changes`
 * one agent's worktree summary (`changes` events) while it is watched.
 * Up (POST): `/fed/v1/frames` takes a batch of frames and answers one result
 * per frame, in order. A frame type this node does not know gets
 * `{ok: false, code: "unsupported"}`.
 */

/**
 * A string from a peer, safe to show and print: C0/C1 control characters
 * (terminal escapes), zero-width and bidi controls removed, then cut.
 */
export function clean(v: string, max: number): string {
	return v
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
			/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
			"",
		)
		.slice(0, max);
}

/** Federation protocol versions this build speaks. */
export const FED_PROTOCOL: [number, number] = [1, 1];

/** Header with the protocol version a request speaks. */
export const FED_HEADER = "x-pulsar-fed";

/** Header with the port the calling node serves on (where to call it back). */
export const FED_PORT_HEADER = "x-pulsar-fed-port";

/** The app and federation port when a node sets none (`PULSAR_HTTP_PORT`). */
export const DEFAULT_FED_PORT = 7337;

/** `GET /fed/v1/hello`: who this node is. */
export interface FedHello {
	fedProtocol: [number, number];
	features: string[];
	pulsarVersion: string;
	machineId: string;
	/** This node's machine name ("studio"). */
	name: string;
	/** The port this node serves `/fed/v1` and the app on. */
	port?: number;
}

function validPort(v: unknown): number | undefined {
	return Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536
		? (v as number)
		: undefined;
}

/** A hello from a peer, checked; null when malformed. */
export function parseHello(
	raw: unknown,
	fallbackName: string,
): FedHello | null {
	if (!raw || typeof raw !== "object") return null;
	const h = raw as Record<string, unknown>;
	const range = protocolRange(h.fedProtocol);
	if (
		!range ||
		typeof h.machineId !== "string" ||
		!/^[\w.-]{1,100}$/.test(h.machineId) ||
		typeof h.name !== "string"
	)
		return null;
	const port = validPort(h.port);
	return {
		fedProtocol: range,
		features: Array.isArray(h.features) ? h.features.map(String) : [],
		pulsarVersion: clean(String(h.pulsarVersion ?? ""), 40),
		machineId: h.machineId,
		name: clean(h.name, 100) || fallbackName,
		...(port ? { port } : {}),
	};
}

/** A port number from a header or a query, or undefined. */
export function portOf(v: string | null | undefined): number | undefined {
	return v ? validPort(Number(v)) : undefined;
}

/** What each node gossips with its heartbeat: enough to tell a peer its copy is stale. */
export interface Digest {
	machineId: string;
	/** Random per daemon start; a new one means every earlier seq is void. */
	bootId: string;
	/** Bumps on every change to this node's agent list. */
	seq: number;
	agentCount: number;
}

/** One agent as its home node shares it: public fields plus what views need. */
export interface FedAgent
	extends Omit<PublicAgent, "pid" | "sessionId" | "cwd"> {
	needsYou: NeedsYou | null;
	/** When `status` last changed, on the home node's clock (absent from older nodes). */
	statusSince?: number;
	/** What a normal message would do (the home node's `Views.wakeOf`). */
	wake: Wake;
	hasTranscript: boolean;
	/** The home node can interrupt it (`stop`). */
	canStop?: boolean;
	/** Its subagents, counted, once found (absent from older nodes). */
	subagents?: SubagentCounts;
	/**
	 * Its permission prompts: pending ones, and ones decided in the last
	 * two minutes (so other nodes show the outcome). Home-node ids.
	 */
	approvals?: Approval[];
	/**
	 * Its last ended turn as the home node decided it (src/service/turns.ts):
	 * a newer `at` is a new finish or failure (absent from older nodes).
	 */
	turn?: { kind: TurnKind; at: number };
}

/** Down frames on `/fed/v1/stream`. */
export type DownFrame =
	| { type: "snapshot"; bootId: string; seq: number; agents: FedAgent[] }
	| {
			type: "delta";
			bootId: string;
			seq: number;
			upserts: FedAgent[];
			removes: string[];
	  }
	| { type: "ping"; digest: Digest };

/** Who sent a delivered message, as its home node vouches. */
export type FedSender =
	| {
			kind: "agent";
			id: string;
			name: string;
			harness: string;
			project: string | null;
	  }
	/**
	 * The human operator in the app on the sending node; the receiver
	 * re-checks the login. Never "verified": no frame confers the operator's
	 * authority, so the home node frames it "not verified as your operator".
	 * Wire value `user` (older peers); a `human` principal maps to it.
	 */
	| { kind: "user"; login: string; node: string };

/** One recipient's receipt as its home node reports it (its local id). */
export interface FedReceipt {
	agentId: string;
	agentName: string;
	state: ReceiptState;
	via: string | null;
	detail: string | null;
	updatedAt: number;
	/** Delivery attempt (peers with `receipts2`). */
	attempt?: number;
	/** `done`'s result or `nack`'s reason (peers with `receipts2`). */
	result?: string | null;
}

/** Hello feature: the peer understands acked/done/nacked/expired/dead and attempts. */
export const RECEIPTS2 = "receipts2";

/** This node's hello features. */
export const FED_FEATURES = [
	"registry",
	"deliver",
	"receipts",
	"transcripts",
	"stop",
	RECEIPTS2,
];

/** A new receipt state as a peer without `receipts2` understands it. */
const MAP_DOWN: Partial<Record<ReceiptState, ReceiptState>> = {
	acked: "read",
	done: "replied",
	nacked: "failed",
	expired: "failed",
	dead: "failed",
};

/** A receipt for the wire; new states map down for a peer without `receipts2`. */
export function fedReceipt(r: Receipt, receipts2: boolean): FedReceipt {
	const base = {
		agentId: r.agentId,
		agentName: r.agentName,
		via: r.via,
		detail: r.detail,
		updatedAt: r.updatedAt,
	};
	if (!receipts2) return { ...base, state: MAP_DOWN[r.state] ?? r.state };
	return {
		...base,
		state: r.state,
		attempt: r.attempt ?? 1,
		result: r.result ?? null,
	};
}

/** A user action on an agent, forwarded to the agent's home node. */
export type FedAction =
	| { op: "transcript.page"; agent: string; cursor: string | null }
	| { op: "transcript.image"; agent: string; imageId: string }
	/** The agent's subagents (newer nodes; older ones answer bad_request). */
	| { op: "subagents.list"; agent: string }
	/** The agent's worktree changes, and one file's diff (the diff viewer). */
	| { op: "changes.summary"; agent: string; mode: ChangesMode }
	| { op: "changes.file"; agent: string; mode: ChangesMode; path: string }
	/** Ask about the receiver's own agents (`service.ask.local`). */
	| { op: "ask"; question: string; selector?: string }
	/*
	 * The relayed WebAuthn ceremonies. The home node issues the challenge
	 * (bound to the purpose), allows only credentials it enrolled itself, and
	 * verifies the browser's assertion, which the forwarding node passes
	 * through as opaque JSON, against the exact origin of the forwarding node
	 * (its MagicDNS name and bound port), never one a frame names.
	 */
	| {
			op: "approval.options";
			id: string;
			decision: ApprovalDecision;
			/** The deny note, so the signed challenge covers it. */
			note?: string;
			/** `decision: "answer"`: the interaction's answer (signed too). */
			answer?: unknown;
	  }
	| {
			op: "approval.decide";
			id: string;
			decision: ApprovalDecision;
			note: string | null;
			assertion: unknown;
			answer?: unknown;
	  }
	/*
	 * Attachments (src/service/attachments.ts): one file's bytes at `offset`
	 * (base64) into an upload the home node opened after its own passkey
	 * check; the frame grants nothing else. And the composer's `@` files.
	 */
	| {
			op: "attachments.chunk";
			agent: string;
			upload: string;
			index: number;
			offset: number;
			data: string;
	  }
	| { op: "files.search"; agent: string; q: string }
	| { op: "stop.options"; agent: string }
	| { op: "stop"; agent: string; assertion: unknown }
	/*
	 * Acting ops (src/service/acting.ts), the same ceremony for every one:
	 * `name` is the op (`git.commit`, ...), `agent` the receiver's local
	 * agent id (null: the machine itself), `params` the op's own JSON. The
	 * challenge covers name, agent and a digest of params. Features add a
	 * handler, never a frame.
	 */
	| {
			op: "acting.options";
			name: string;
			agent: string | null;
			params: unknown;
	  }
	| {
			op: "acting.run";
			name: string;
			agent: string | null;
			params: unknown;
			assertion: unknown;
	  }
	/** The receiver's own token usage (unpriced), and one of its agents'. */
	| { op: "usage.rows"; period: UsagePeriod; tz: number }
	| { op: "usage.agent"; agent: string }
	/** Launch reads on the receiver itself (src/service/launch.ts). */
	| { op: "launch.status"; id: string }
	| { op: "launch.options" }
	| { op: "launch.refs"; cwd: string };

/** Up frames, batched in `POST /fed/v1/frames`. */
export type UpFrame =
	/** A heartbeat: the sender's digest; answered with the receiver's. */
	| { type: "digest"; digest: Digest }
	/** One message for some of the receiver's agents (by local id). */
	| {
			type: "deliver";
			message: Message;
			targets: string[];
			from: FedSender;
	  }
	/** Receipts for a message the receiver sent. */
	| { type: "receipts"; messageId: string; receipts: FedReceipt[] }
	/** A forwarded user action; the receiver re-authorizes `as`. */
	| { type: "act"; as: FedOrigin; action: FedAction };

/**
 * Who started a forwarded action, as the forwarding node knows it: the pool
 * owner (from the app), an agent, or the person at that node's terminal. The
 * home node authorizes the action as that kind; only nodes of the owner's
 * own login may forward anything at all.
 */
export interface FedOrigin {
	/** Wire values, kept for older peers: `user` is a `human` principal, `operator` a `terminal`. */
	kind: "user" | "agent" | "operator";
	/** The user's login (kind `user`). */
	login?: string;
	/** The node it came from (the user's device, or the forwarding node). */
	node: string;
}

export type FrameResult =
	| ({ ok: true } & Record<string, unknown>)
	| { ok: false; code: string; message: string };

/** The highest version both ranges share, or null when they don't overlap. */
export function negotiate(
	ours: [number, number],
	theirs: [number, number],
): number | null {
	const hi = Math.min(ours[1], theirs[1]);
	const lo = Math.max(ours[0], theirs[0]);
	return hi >= lo ? hi : null;
}

/** A `[min, max]` protocol range, or null for anything else. */
export function protocolRange(v: unknown): [number, number] | null {
	if (!Array.isArray(v) || v.length !== 2) return null;
	const [a, b] = v;
	return Number.isInteger(a) && Number.isInteger(b) && a <= b
		? [a as number, b as number]
		: null;
}
