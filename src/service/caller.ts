import type { Registration } from "../types.ts";

/**
 * Who a request comes from. Identity is decided by the transport, never by
 * anything inside the request.
 */
export type Principal =
	/** A local agent session (MCP server, extension, or a CLI run from its shell). */
	| { kind: "agent"; agentId: string }
	/**
	 * A plain CLI connection: the person at a local terminal, or any local
	 * process that skips `hello`. Never the `[human operator]` tag.
	 */
	| { kind: "terminal" }
	/** The human operator over the tailnet, in the app (the HTTP transport). */
	| {
			kind: "human";
			login: string;
			node: string;
			/** The whois node id (`StableID`) of the requesting device, when known. */
			nodeId?: string;
			/** The operator's name from Tailscale (display name, else login). */
			name?: string;
			/** The requesting device's OS from Tailscale whois (`iOS`, `macOS`, …). */
			os?: string;
			/**
			 * The request carried a passkey session (Prove Human on this node).
			 * Without it the login is the operator's but the caller may be any
			 * program on a node of theirs: sends get no `[human operator]` tag and
			 * `stop` / passkey removal are refused.
			 */
			verified?: boolean;
	  }
	/** A linked pulsar node (reserved for federation). */
	| { kind: "peer"; machineId: string; node: string };

/** How audit rows name a principal: `human:me@example.com@phone`, `agent:<id>`, ... */
export function principalLabel(p: Principal): string {
	switch (p.kind) {
		case "agent":
			return `agent:${p.agentId}`;
		case "terminal":
			return "terminal";
		case "human":
			return `human:${p.login}@${p.node}`;
		case "peer":
			return `peer:${p.machineId}`;
	}
}

/**
 * One connection or request stream into the service. Waiters and
 * subscriptions attach to it; aborting `closed` drops them.
 */
export interface Caller {
	/** Starts as the transport's default; the socket transport upgrades it on `hello`. */
	principal: Principal;
	readonly closed: AbortSignal;
	/** Pushes an event to this caller (a socket frame today). */
	emit(event: string, data: unknown): void;
	/** Ends this connection from the daemon's side, saying why. */
	close?(reason: string): void;
}

/** How a socket connection serves its agent; a `cli` connection never owns presence. */
export type Role = Registration["role"];

/** The operator's agent id: the human at the terminal. */
export const OPERATOR_ID = "cli:operator";

export function agentIdOf(principal: Principal): string | null {
	return principal.kind === "agent" ? principal.agentId : null;
}

/** Whose passkey challenge bucket a local request counts in: its whois node. */
export function requesterOf(p: Principal): string {
	return p.kind === "human" ? `node:${p.nodeId ?? p.node}` : p.kind;
}
