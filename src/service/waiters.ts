import type { Agent, DeliveredMessage } from "../types.ts";
import type { Caller } from "./caller.ts";
import { isLocalSubagentId, splitSubagentId } from "./pool.ts";
import { toPublic } from "./util.ts";

export type WaitKind = "message" | "idle" | "reply";

interface Waiter {
	/** The caller blocked on this wait; its waiters are dropped when it closes. */
	caller: Caller;
	agentId: string;
	kind: WaitKind;
	target?: string;
	resolve: (value: unknown) => void;
	timer: NodeJS.Timeout;
	onClose: () => void;
}

/** Blocked `wait` calls: for the next message, an agent going idle, or a reply. */
export class Waiters {
	private waiters = new Set<Waiter>();

	/**
	 * Blocks until a matching event, the timeout (`{event:"timeout"}`), or the
	 * caller closing (`{event:"closed"}`).
	 */
	add(
		caller: Caller,
		agentId: string,
		kind: WaitKind,
		target: string | undefined,
		timeoutMs: number,
	): Promise<unknown> {
		if (caller.closed.aborted) return Promise.resolve({ event: "closed" });
		return new Promise((resolve) => {
			const waiter: Waiter = {
				caller,
				agentId,
				kind,
				...(target ? { target } : {}),
				resolve,
				timer: setTimeout(
					() => this.settle(waiter, { event: "timeout" }),
					timeoutMs,
				),
				// Nobody is left to hear a pending wait; drop it so it cannot take a later message.
				onClose: () => this.settle(waiter, { event: "closed" }),
			};
			caller.closed.addEventListener("abort", waiter.onClose, { once: true });
			this.waiters.add(waiter);
		});
	}

	/** Explicit child waits still observe their own parent with background discovery off. */
	childParents(): Set<string> {
		const parents = new Set<string>();
		for (const w of this.waiters)
			if (w.kind === "idle" && w.target && isLocalSubagentId(w.target))
				parents.add(splitSubagentId(w.target)!.parentId);
		return parents;
	}

	/** Moves waits by or on one agent to another (a session its process left). */
	reassign(fromId: string, toId: string) {
		for (const w of this.waiters) {
			if (w.agentId === fromId) w.agentId = toId;
			if (w.target === fromId) w.target = toId;
		}
	}

	/** Wakes anyone waiting for this agent to finish its turn. */
	resolveIdle(agent: Agent) {
		for (const w of [...this.waiters])
			if (w.kind === "idle" && w.target === agent.id)
				this.settle(w, { event: "idle", agent: toPublic(agent) });
	}

	/** Ends the idle waits on an agent whose session ended (`{event:"gone"}`). */
	resolveGone(agent: Agent) {
		for (const w of [...this.waiters])
			if (w.kind === "idle" && w.target === agent.id)
				this.settle(w, { event: "gone", agent: toPublic(agent) });
	}

	/** Wakes every `wait reply:<parentId>`. */
	resolveReplies(parentId: string, message: DeliveredMessage) {
		for (const w of [...this.waiters])
			if (w.kind === "reply" && w.target === parentId)
				this.settle(w, { event: "reply", message });
	}

	/** Settles every `wait reply:<parentId>` with `value` (a dead or declined message). */
	resolveReplyWaiters(parentId: string, value: unknown) {
		for (const w of [...this.waiters])
			if (w.kind === "reply" && w.target === parentId) this.settle(w, value);
	}

	/** Hands a reply to the live `ask` this agent is blocked on, if any. */
	takeReply(agentId: string, message: DeliveredMessage): boolean {
		if (!message.replyTo) return false;
		for (const w of this.waiters) {
			if (
				w.kind === "reply" &&
				w.agentId === agentId &&
				!w.caller.closed.aborted &&
				w.target === message.replyTo
			) {
				this.settle(w, { event: "reply", message });
				return true;
			}
		}
		return false;
	}

	/** Hands a message to the first live `wait` for this agent's next message. */
	takeMessage(agentId: string, message: DeliveredMessage): boolean {
		for (const w of this.waiters) {
			if (
				w.kind === "message" &&
				w.agentId === agentId &&
				!w.caller.closed.aborted
			) {
				this.settle(w, { event: "message", message });
				return true;
			}
		}
		return false;
	}

	/** Pending waits held by one caller. */
	countFor(caller: Caller): number {
		let n = 0;
		for (const w of this.waiters) if (w.caller === caller) n++;
		return n;
	}

	get size() {
		return this.waiters.size;
	}

	/** Drops every wait without answering it (the daemon is stopping). */
	clear() {
		for (const w of this.waiters) {
			clearTimeout(w.timer);
			w.caller.closed.removeEventListener("abort", w.onClose);
		}
		this.waiters.clear();
	}

	private settle(w: Waiter, value: unknown) {
		if (!this.waiters.delete(w)) return;
		clearTimeout(w.timer);
		w.caller.closed.removeEventListener("abort", w.onClose);
		w.resolve(value);
	}
}
