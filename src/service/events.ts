import type { Approval, SecurityNotice, SubagentCounts } from "../http/wire.ts";
import type { Message, PublicAgent } from "../types.ts";
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
			if ((e as ServiceEvent) === event) fn(data as ServiceEvents[K]);
		});
	}

	emit<K extends ServiceEvent>(event: K, data: ServiceEvents[K]) {
		for (const fn of [...this.handlers]) fn(event, data);
	}

	get size() {
		return this.handlers.size;
	}
}
