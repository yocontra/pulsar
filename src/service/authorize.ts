import { RpcError } from "../rpc.ts";
import type { Principal } from "./caller.ts";

/** Every operation the socket RPC serves (its method names). */
export const OPS = [
	"hello",
	"status",
	"whoami",
	"list",
	"send",
	"reply",
	"inbox",
	"set_identity",
	"set_status",
	"ack",
	"nack",
	"msg.ack",
	"msg.done",
	"msg.nack",
	"resume_key",
	/** The pi/omp extension reporting its host's session name. */
	"harness_name",
	"wait",
	"history",
	"tail",
	"transcript.read",
	/** Interrupt an agent's current turn. */
	"stop",
	/** Ask without waking anyone: who works on a file, PR, branch, project. */
	"lookup",
	/** An extension answering a `interrupt` push. */
	"interrupt_result",
	"shutdown",
	/** A harness hook asks the user about a permission prompt (blocks until decided). */
	"approval.request",
	/** The pi/omp extension relays a host dialog (blocks until answered), or says it was answered locally. */
	"interaction.ask",
	"interaction.local",
	/**
	 * Passkeys: list, and remove (from the socket after a presence check; from
	 * the app with a passkey session).
	 */
	"passkeys.list",
	"passkeys.remove",
	/** Pool membership (`pulsar mesh`): anyone on the machine, after a presence check. */
	"pool.list",
	"pool.change",
	/** The last-resort typed word for a presence check (a terminal only). */
	"presence.word",
] as const;

/**
 * Acting ops: the operator changes something on an agent's machine (files,
 * processes, git). Only the human operator, with a passkey session on this
 * node; on a remote agent the home node verifies its own passkey assertion
 * for the exact action (src/service/acting.ts). Each run is audited.
 */
export const ACTING_OPS = [
	"attachments.upload",
	"agents.launch",
	"git.commit",
	"git.push",
	"git.pr",
] as const;

/**
 * Operations only the HTTP transport serves (the app's pool views). They are
 * not socket methods: `isOp` rejects them, so `handle` never runs them.
 */
export const HTTP_OPS = [
	"tree",
	"agents",
	"facets",
	"search",
	"attention",
	"recent",
	"receipts",
	"subscribe",
	/** Deciding a permission prompt; needs a passkey assertion as well. */
	"approve",
	/** Registering this browser's passkey. */
	"passkeys.register",
	/** Web Push: the VAPID key, subscribing and unsubscribing this browser. */
	"push.subscribe",
	/** Request options for an acting op on a remote agent (its home node's challenge). */
	"acting.options",
	...ACTING_OPS,
	/** Token usage and model prices (reading, and editing a price). */
	"usage",
] as const;

/**
 * Operations only the federation transport (`/fed/v1`) serves, for a linked
 * pulsar node. A forwarded user action (`fed.act`) carries the original user
 * principal, which the home node authorizes again for the action itself.
 */
export const FED_OPS = [
	"fed.hello",
	"fed.digest",
	"fed.subscribe",
	"fed.deliver",
	"fed.receipts",
	"fed.act",
] as const;

export type SocketOp = (typeof OPS)[number];
export type HttpOp = (typeof HTTP_OPS)[number];
export type FedOp = (typeof FED_OPS)[number];
export type Op = SocketOp | HttpOp | FedOp;

/** Every op, for the authorize matrix. */
export const ALL_OPS: readonly Op[] = [...OPS, ...HTTP_OPS, ...FED_OPS];

const FED: ReadonlySet<Op> = new Set<Op>(FED_OPS);

/** Operations that act on the caller's own agent: an agent principal only. */
const AGENT_ONLY: ReadonlySet<Op> = new Set<Op>([
	"approval.request",
	"interaction.ask",
	"interaction.local",
	"whoami",
	"set_identity",
	"set_status",
	"ack",
	"nack",
	"msg.ack",
	"msg.done",
	"msg.nack",
	"resume_key",
	"harness_name",
	"interrupt_result",
]);

/**
 * Agents never register passkeys or subscribe to pushes: both are the app's,
 * with WebAuthn. (Pool changes and passkey removal are open to agents: the
 * daemon asks the person itself, src/service/presence.ts.)
 */
const PASSKEY_OPS: ReadonlySet<Op> = new Set<Op>([
	"push.subscribe",
	"passkeys.register",
]);

/**
 * What the human operator may do from the app. Approving also needs a passkey
 * assertion, checked by the approvals service. Never stop the daemon.
 */
const USER_OPS: ReadonlySet<Op> = new Set<Op>([
	"approve",
	"passkeys.register",
	"passkeys.list",
	"passkeys.remove",
	"push.subscribe",
	"hello",
	"status",
	"list",
	"send",
	"tree",
	"agents",
	"facets",
	"search",
	"attention",
	"recent",
	"receipts",
	"subscribe",
	"transcript.read",
	"stop",
	"lookup",
	"acting.options",
	...ACTING_OPS,
	"usage",
]);

/** What the human operator may do only with a passkey session (`verified`, Prove Human). */
const SESSION_OPS: ReadonlySet<Op> = new Set<Op>([
	"stop",
	"passkeys.remove",
	...ACTING_OPS,
]);

const ACTING_SET: ReadonlySet<Op> = new Set<Op>(ACTING_OPS);

export type ActingOp = (typeof ACTING_OPS)[number];

/** True for an acting op name (a federation frame names one as a string). */
export function isActingOp(op: unknown): op is ActingOp {
	return typeof op === "string" && ACTING_SET.has(op as Op);
}

/** True for a socket RPC method name. */
export function isOp(method: string): method is SocketOp {
	return (OPS as readonly string[]).includes(method);
}

/**
 * Throws when `principal` may not perform `op` on `target` (an agent id).
 * Local agents and the terminal may do everything else, except that only an
 * agent acts as itself and an agent reads only its own transcript
 * (`transcript.read` without a target is refused). The human operator may read
 * the pool, read any transcript, send, register a passkey and approve (with a
 * passkey assertion), but not act as an agent. Agents never approve, register
 * a passkey or subscribe to pushes; pool changes and passkey removal from the
 * socket are gated by a presence check in the service, not here. A linked peer may do exactly the federation ops, and nobody
 * else may; a forwarded decision is verified by the approvals service itself
 * (`verifyDecision`).
 */
export function authorize(principal: Principal, op: Op, target?: string) {
	if (FED.has(op) !== (principal.kind === "peer"))
		throw new RpcError(
			"forbidden",
			principal.kind === "peer"
				? `a linked node may not call ${op}`
				: `${op} is for linked Pulsar nodes only`,
		);
	if (
		(ACTING_SET.has(op) || op === "acting.options") &&
		principal.kind !== "human"
	)
		throw new RpcError(
			"forbidden",
			`only the human operator may call ${op}, from the app after Prove Human`,
		);
	if (op === "approve" && principal.kind !== "human")
		throw new RpcError(
			"forbidden",
			principal.kind === "agent"
				? "agents can never approve"
				: "only the human operator approves, from the app after Prove Human (Face ID / Touch ID)",
		);
	switch (principal.kind) {
		case "agent":
			// An agent may stop itself, never another agent.
			if (op === "stop" && target !== principal.agentId)
				throw new RpcError("forbidden", "an agent may not stop other agents");
			if (op === "transcript.read" && target !== principal.agentId)
				throw new RpcError(
					"forbidden",
					"an agent may read only its own transcript",
				);
			// The last-resort word is typed by a person at a terminal.
			if (op === "presence.word")
				throw new RpcError("forbidden", "the word is typed at a terminal");
			if (PASSKEY_OPS.has(op))
				throw new RpcError(
					"forbidden",
					"agents can't register passkeys or subscribe to notifications",
				);
			// Stopping the daemon frees its port for any process to take.
			if (op === "shutdown")
				throw new RpcError(
					"forbidden",
					"an agent can't stop the daemon; run `pulsar stop` in a terminal",
				);
			return;
		case "terminal":
			if (AGENT_ONLY.has(op))
				throw new RpcError(
					"not_registered",
					"this connection has not said hello",
				);
			if (op === "passkeys.register")
				throw new RpcError(
					"forbidden",
					"proving you're human happens in the app, with Face ID / Touch ID",
				);
			return;
		case "human":
			if (!USER_OPS.has(op))
				throw new RpcError(
					"forbidden",
					`the human operator may not call ${op} here`,
				);
			if (SESSION_OPS.has(op) && !principal.verified)
				throw new RpcError(
					"session_required",
					"prove you're human first (Prove Human, Face ID / Touch ID)",
				);
			return;
		case "peer":
			// A peer may do exactly the federation ops (checked above); a user
			// action it forwards is authorized as that user (authorizeForwarded).
			return;
	}
}

/**
 * Federation hook: a linked peer forwarding an action its human operator took.
 * The action is authorized as that user; the peer itself adds no rights.
 * Only user-initiated ops may be forwarded.
 */
export function authorizeForwarded(
	peer: Principal,
	user: Principal,
	op: Op,
	target?: string,
) {
	if (peer.kind !== "peer")
		throw new RpcError("forbidden", "only a linked peer forwards actions");
	if (user.kind !== "human")
		throw new RpcError("forbidden", "a peer forwards only its user's actions");
	authorize(user, op, target);
}
