import type {
	Approval,
	LaunchState,
	LimitWarning,
	SecurityNotice,
	SubagentCounts,
	TurnKind,
} from "../http/wire.ts";
import type { AgentStatus, Message, PublicAgent } from "../types.ts";
import type { NeedsYou } from "./registry.ts";

/** Everything the service announces. Names and payloads are the socket `tail` frames. */
export interface ServiceEvents {
	agent: { action: "join" | "update" | "gone"; agent: PublicAgent };
	message: { message: Message; recipients: string[] };
	/** An agent started or stopped waiting on the user (not a socket `tail` frame). */
	attention: { agentId: string; needsYou: NeedsYou | null };
	/** A permission prompt appeared or ended (not a socket `tail` frame). */
	approval: { approval: Approval };
	/** A passkey change (not a socket `tail` frame). */
	security: SecurityNotice;
	/** A local agent's subagents changed (not a socket `tail` frame). */
	subagents: { agentId: string; counts: SubagentCounts | undefined };
	/** Remote agents or a machine's link changed (federation; not a `tail` frame). */
	pool: { machineId: string | null };
	/**
	 * A local agent's status changed, as shown: busy, idle, gone (not a
	 * `tail` frame). `unknown` shows as idle, so unknown <-> idle is no
	 * change, but `from`/`to` carry the raw values. An idle after busy comes
	 * only once it held for the settle time. A new agent's first status is
	 * not a change; a gone agent that comes back is (`from: "gone"`).
	 * `at`: when the change happened (ms), not when it was read.
	 */
	"agent:status": {
		agentId: string;
		from: AgentStatus;
		to: AgentStatus;
		at: number;
	};
	/**
	 * An agent's turn ended (not a `tail` frame): decided by its home node
	 * (src/service/turns.ts). A local id, or a pool address for an agent on
	 * another machine.
	 */
	"agent:turn": { agentId: string; kind: TurnKind; at: number };
	/**
	 * A turn the operator should hear about: `agent:turn` for an agent they
	 * recently started, messaged or opened (not a `tail` frame). The app's
	 * stream and Web Push follow it.
	 */
	notify: { kind: TurnKind; agentId: string; at: number };
	/** A plan usage limit passed a warning threshold or was reached (src/usage/limits.ts). */
	limit: LimitWarning;
	/** A launch from the app moved on (src/service/launch.ts; not a `tail` frame). */
	launch: LaunchState;
}

export type ServiceEvent = keyof ServiceEvents;

type AnyHandler = <K extends ServiceEvent>(
	event: K,
	data: ServiceEvents[K],
) => void;

/** A small typed event bus. Handlers run synchronously, in subscription order. */
export class EventBus {
	private handlers = new Set<AnyHandler>();

	/** Subscribes to every event; returns the unsubscribe function. */
	onAny(fn: AnyHandler): () => void {
		this.handlers.add(fn);
		return () => {
			this.handlers.delete(fn);
		};
	}

	/** Subscribes to one event; returns the unsubscribe function. */
	on<K extends ServiceEvent>(
		event: K,
		fn: (data: ServiceEvents[K]) => void,
	): () => void {
		return this.onAny((e, data) => {
			if ((e as ServiceEvent) === event)
				fn(data as unknown as ServiceEvents[K]);
		});
	}

	emit<K extends ServiceEvent>(event: K, data: ServiceEvents[K]) {
		for (const fn of [...this.handlers]) fn(event, data);
	}

	get size() {
		return this.handlers.size;
	}
}
