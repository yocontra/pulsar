import { RpcError } from "../rpc.ts";
import type { PendingDelivery, Store } from "../store.ts";
import type { Agent, Message, Receipt, ReceiptState } from "../types.ts";
import { FINAL_STATES } from "../types.ts";
import type { EventBus } from "./events.ts";
import { isRemote } from "./pool.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import { newId } from "./util.ts";
import type { Waiters } from "./waiters.ts";

/** Redelivery timers (docs/delivery.md, "Schedule and limits"). */
export interface DeliveryConfig {
	/** How often the scheduler looks for due receipts. */
	tickMs: number;
	/** An acks-capable, idle recipient that has not acked by then gets it again. */
	ackTimeoutMs: number;
	/** An acked message with no `done`/`reply` by then gets delivered again. */
	leaseMs: number;
	/** Base delay before a retry the agent asked for (`nack retry`). */
	backoffMs: number;
	maxAttempts: number;
	/** A tracked message not done by then expires. */
	ttlMs: number;
}

const DELIVERY_DEFAULTS: DeliveryConfig = {
	tickMs: 5000,
	ackTimeoutMs: 10 * 60_000,
	leaseMs: 30 * 60_000,
	backoffMs: 30_000,
	maxAttempts: 5,
	ttlMs: 24 * 3600_000,
};

/** The sender of dead-letter notices. */
const NOTICE_SENDER_ID = "system:pulsar";

/** States in which the message reached the recipient's session. */
const HANDED: ReadonlySet<ReceiptState> = new Set([
	"sent",
	"delivered",
	"read",
	"acked",
]);

/**
 * Which session of an agent a message reached: its process, or the client
 * process's nonce (`meta.gen`) when the harness gives no pid (OpenCode). With
 * neither, a return is never taken for a restart.
 */
export function generationOf(agent: Agent): string | null {
	if (agent.pid) return `pid:${agent.pid}`;
	return agent.meta.gen ? `gen:${agent.meta.gen}` : null;
}

/** True when the agent's client has the `ack`/`done`/`nack` tools. */
export function canAck(agent: Agent): boolean {
	return agent.meta.acks === "1";
}

/**
 * How a new message is tracked: a single-recipient ask fully (2), a group
 * ask for restarts only (1), anything else not at all (0).
 */
export function trackLevel(
	expectReply: boolean,
	recipients: number,
	broadcast: boolean,
): 0 | 1 | 2 {
	if (!expectReply) return 0;
	return recipients === 1 && !broadcast ? 2 : 1;
}

/**
 * At-least-once delivery for tracked messages: redelivery after a session
 * restart, ack timeouts, leases, retries the agent asked for, dead letters,
 * and the agent-level `ack`/`done`/`nack`.
 */
export class Deliveries {
	readonly config: DeliveryConfig;
	private readonly store: Store;
	private readonly registry: Registry;
	private readonly router: Router;
	private readonly waiters: Waiters;
	private readonly events: EventBus;
	/** Messages being pushed again right now (no second concurrent push). */
	private inFlight = new Set<string>();

	constructor(deps: {
		store: Store;
		registry: Registry;
		router: Router;
		waiters: Waiters;
		events: EventBus;
		config?: Partial<DeliveryConfig>;
	}) {
		this.store = deps.store;
		this.registry = deps.registry;
		this.router = deps.router;
		this.waiters = deps.waiters;
		this.events = deps.events;
		this.config = { ...DELIVERY_DEFAULTS, ...deps.config };
	}

	private backoff(attempt: number): number {
		const base = this.config.backoffMs * 2 ** Math.max(0, attempt - 2);
		const capped = Math.min(base, 10 * 60_000);
		return Math.round(capped * (0.8 + Math.random() * 0.4));
	}

	/** The first deadline after a hand-off. */
	private dueAfterHandoff(
		tracked: 1 | 2,
		createdAt: number,
		agent: Agent,
		now: number,
	): number | null {
		if (tracked !== 2) return null;
		if (canAck(agent)) return now + this.config.ackTimeoutMs;
		return createdAt + this.config.ttlMs;
	}

	/**
	 * Records that a tracked message reached `agent`'s session (a push, an
	 * `ask`/`wait`, an inbox read): which session, and the next deadline.
	 */
	handedOff(message: Message, agent: Agent, receipt: Receipt) {
		if (!message.tracked) return;
		if (!HANDED.has(receipt.state)) {
			// Not in a session yet (inbox, held, push failed): it still expires.
			if (
				message.tracked === 2 &&
				(receipt.state === "queued" || receipt.state === "held")
			)
				this.store.setDelivery(message.id, agent.id, {
					dueAt: message.createdAt + this.config.ttlMs,
				});
			return;
		}
		const now = Date.now();
		this.store.setDelivery(message.id, agent.id, {
			deliveredGen: generationOf(agent) ?? "",
			resumeKey: agent.meta.resumeKey ?? null,
			dueAt: this.dueAfterHandoff(
				message.tracked,
				message.createdAt,
				agent,
				now,
			),
		});
	}

	/** Called when inbox reads hand tracked messages to an agent. */
	readFromInbox(agent: Agent, messages: Message[]) {
		for (const m of messages) {
			if (!m.tracked) continue;
			const r = this.store.receipt(m.id, agent.id);
			if (r) this.handedOff(m, agent, r);
		}
	}

	/** The agent's session ended: its handed-off tracked messages wait for it. */
	gone(agent: Agent) {
		// The daemon is stopping: every connection closes, no session ended.
		if (this.registry.closed || isRemote(agent)) return;
		for (const p of this.store.pendingFor(agent.id)) {
			if (!HANDED.has(p.receipt.state)) continue;
			this.store.setReceipt({
				...p.receipt,
				detail: `waiting for ${agent.name} to come back (attempt ${p.receipt.attempt ?? 1} reached it before it stopped)`,
				updatedAt: Date.now(),
			});
			this.store.setDelivery(p.receipt.messageId, agent.id, {
				dueAt: p.tracked === 2 ? p.createdAt + this.config.ttlMs : null,
			});
		}
	}

	/**
	 * An agent registered or was scanned (new to this daemon, or back from
	 * gone). Tracked messages a previous session of it got (same id, or the
	 * same resume key under a new pid) are delivered again; a reconnect of
	 * the same process changes nothing.
	 */
	async back(agent: Agent) {
		if (this.registry.closed || isRemote(agent)) return;
		const key = agent.meta.resumeKey;
		if (key) {
			for (const p of this.store.pendingByResumeKey(key)) {
				const from = p.receipt.agentId;
				if (from === agent.id) continue;
				const old = this.registry.get(from);
				if (old && old.status !== "gone") continue;
				this.store.moveReceipt(p.receipt.messageId, from, agent.id, agent.name);
			}
		}
		const gen = generationOf(agent);
		for (const listed of this.store.pendingFor(agent.id)) {
			const p = this.fresh(listed);
			if (!p || !HANDED.has(p.receipt.state) || p.deliveredGen === null)
				continue;
			// The same process (a reconnect, a daemon restart): it still has the message.
			if (gen === null || p.deliveredGen === gen) this.restore(p, agent);
			else await this.redeliver(p, agent, `${agent.name} restarted`, true);
		}
	}

	/** The receipt as stored now, or null once it is final or gone. */
	private fresh(p: PendingDelivery): PendingDelivery | null {
		const r = this.store.receipt(p.receipt.messageId, p.receipt.agentId);
		if (!r || FINAL_STATES.has(r.state)) return null;
		return { ...p, receipt: r };
	}

	/** A session that kept the message came back: its timers run again. */
	private restore(p: PendingDelivery, agent: Agent) {
		const { messageId } = p.receipt;
		if (p.receipt.detail?.includes("to come back"))
			this.store.setReceipt({
				...p.receipt,
				detail: null,
				updatedAt: Date.now(),
			});
		const now = Date.now();
		// Only a single-recipient ask (level 2) has a lease.
		const dueAt =
			p.receipt.state !== "acked"
				? this.dueAfterHandoff(p.tracked, p.createdAt, agent, now)
				: p.tracked === 2
					? (p.ackedAt ?? now) + this.config.leaseMs
					: null;
		this.store.setDelivery(messageId, agent.id, { dueAt });
	}

	/** Starts the next attempt now (`immediate`) or after a backoff; past the last one, gives up. */
	private async redeliver(
		p: PendingDelivery,
		agent: Agent,
		why: string,
		immediate: boolean,
	) {
		const { messageId } = p.receipt;
		// Act only on the receipt as it is now: a reply may have landed while
		// an earlier push in the same pass was awaited.
		const now = this.store.receipt(messageId, agent.id);
		if (
			!now ||
			FINAL_STATES.has(now.state) ||
			(now.attempt ?? 1) !== (p.receipt.attempt ?? 1)
		)
			return;
		const attempt = (p.receipt.attempt ?? 1) + 1;
		const max = this.config.maxAttempts;
		if (attempt > max) {
			if (p.tracked === 2)
				this.finish(
					messageId,
					agent,
					"dead",
					`gave up after ${max} attempts: ${why}`,
				);
			else this.store.setDelivery(messageId, agent.id, { dueAt: null });
			return;
		}
		this.store.setReceipt({
			...p.receipt,
			state: "queued",
			attempt,
			via: null,
			detail: `redelivering after ${why}, attempt ${attempt} of ${max}`,
			updatedAt: Date.now(),
		});
		this.store.setDelivery(messageId, agent.id, {
			ackedAt: null,
			dueAt: immediate ? null : Date.now() + this.backoff(attempt),
		});
		if (immediate) await this.pushAttempt(messageId, agent, attempt, why);
	}

	/** Pushes one attempt of a tracked message. */
	private async pushAttempt(
		messageId: string,
		agent: Agent,
		attempt: number,
		why: string,
	) {
		const key = `${messageId}\u0000${agent.id}`;
		if (this.inFlight.has(key) || this.registry.closed) return;
		const message = this.store.getMessage(messageId);
		if (!message) return;
		this.inFlight.add(key);
		try {
			const sender = this.registry.senderOf(message);
			const r = await this.router.push(
				{
					...message,
					attempt,
					maxAttempts: this.config.maxAttempts,
					redeliveryReason: why,
				},
				sender,
				agent,
			);
			if (HANDED.has(r.state)) this.handedOff(message, agent, r);
			else
				this.store.setDelivery(messageId, agent.id, {
					// A push path that failed is tried again; otherwise it waits in the inbox.
					dueAt: r.detail?.startsWith("push failed")
						? Date.now() + this.backoff(attempt)
						: message.tracked === 2
							? message.createdAt + this.config.ttlMs
							: null,
				});
		} finally {
			this.inFlight.delete(key);
		}
	}

	/** One scheduler pass: timeouts, leases, retries after backoff, expiry. */
	async tick(now = Date.now()) {
		for (const listed of this.store.dueDeliveries(now)) {
			if (this.registry.closed) return;
			const p = this.fresh(listed);
			if (!p) continue;
			const { messageId, agentId } = p.receipt;
			const agent = this.registry.get(agentId);
			const live = !!agent && agent.status !== "gone";
			if (p.tracked === 2 && now >= p.createdAt + this.config.ttlMs) {
				this.finish(
					messageId,
					agent ?? { id: agentId, name: p.receipt.agentName },
					"expired",
					live
						? "not done in time"
						: `${p.receipt.agentName} did not come back in time`,
				);
				continue;
			}
			const ttlDue = p.tracked === 2 ? p.createdAt + this.config.ttlMs : null;
			if (!agent || !live) {
				this.store.setDelivery(messageId, agentId, { dueAt: ttlDue });
				continue;
			}
			const state = p.receipt.state;
			if (state === "queued") {
				if ((p.receipt.attempt ?? 1) > 1)
					await this.pushAttempt(
						messageId,
						agent,
						p.receipt.attempt ?? 2,
						"a retry",
					);
				else this.store.setDelivery(messageId, agentId, { dueAt: ttlDue });
			} else if (state === "acked" && p.tracked === 2) {
				const leaseEnd = (p.ackedAt ?? now) + this.config.leaseMs;
				if (now >= leaseEnd)
					await this.redeliver(
						p,
						agent,
						`no done or reply within ${Math.round(this.config.leaseMs / 1000)}s of the ack`,
						true,
					);
				else this.store.setDelivery(messageId, agentId, { dueAt: leaseEnd });
			} else if (HANDED.has(state) && p.tracked === 2 && canAck(agent)) {
				if (agent.status === "busy")
					this.store.setDelivery(messageId, agentId, {
						dueAt: now + this.config.ackTimeoutMs,
					});
				else await this.redeliver(p, agent, "no ack", true);
			} else this.store.setDelivery(messageId, agentId, { dueAt: ttlDue });
		}
		this.store.clearFinalDue();
	}

	/** Moves a receipt to a final state and settles whoever waits on it. */
	private finish(
		messageId: string,
		agent: Pick<Agent, "id" | "name">,
		state: "dead" | "expired" | "nacked",
		detail: string,
		result: string | null = null,
	) {
		const current = this.store.receipt(messageId, agent.id);
		const r: Receipt = {
			messageId,
			agentId: agent.id,
			agentName: agent.name,
			state,
			via: null,
			detail,
			updatedAt: Date.now(),
			attempt: current?.attempt ?? 1,
			result,
		};
		this.store.setReceipt(r);
		this.store.setDelivery(messageId, agent.id, { dueAt: null });
		this.settle(messageId, r);
	}

	/**
	 * A tracked message ended without an answer (`nacked`, `dead`,
	 * `expired`): the sender's `ask` stops waiting, and on a dead letter the
	 * sender gets a notice. Also runs for receipts a peer sends back.
	 */
	settle(messageId: string, receipt: Receipt) {
		if (!["nacked", "dead", "expired"].includes(receipt.state)) return;
		const message = this.store.getMessage(messageId);
		if (message?.tracked !== 2) return;
		// A copy a peer delivered: the receipt goes back; the origin settles.
		if (this.store.originOf(messageId)) return;
		this.waiters.resolveReplyWaiters(messageId, {
			event: receipt.state === "nacked" ? "nacked" : "dead",
			receipt,
		});
		if (receipt.state === "nacked") return;
		const sender = this.registry.get(message.fromId);
		if (!sender || sender.status === "gone" || isRemote(sender)) return;
		void this.notice(message, receipt, sender);
	}

	private async notice(message: Message, receipt: Receipt, sender: Agent) {
		const note: Message = {
			id: newId("m"),
			threadId: message.threadId,
			fromId: NOTICE_SENDER_ID,
			fromName: "pulsar",
			to: sender.id,
			body: `Your message ${message.id} to ${receipt.agentName} was not done: ${receipt.state === "dead" ? "gave up" : "expired"} (${receipt.detail ?? "no reason"}). It said: ${message.body.slice(0, 200)}`,
			priority: "fyi",
			replyTo: null,
			expectReply: false,
			createdAt: Date.now(),
		};
		this.store.addMessage(note);
		this.events.emit("message", { message: note, recipients: [sender.name] });
		const from: Agent = {
			...this.registry.operator(),
			id: NOTICE_SENDER_ID,
			name: "pulsar",
			harness: "pulsar",
			activity: null,
		};
		await this.router.deliver(note, from, sender);
	}

	/** The receipt of `me` for a message, or not_found. */
	private mine(me: Agent, messageId: string): Receipt {
		const r = this.store.receipt(messageId, me.id);
		if (!r) throw new RpcError("not_found", `no message ${messageId} for you`);
		return r;
	}

	/** `ack`: the agent took the message on; starts or renews its lease. */
	ack(me: Agent, messageId: string) {
		const r = this.mine(me, messageId);
		if (FINAL_STATES.has(r.state)) return { ok: true, state: r.state };
		const now = Date.now();
		this.store.setReceipt({
			...r,
			state: "acked",
			via: "agent",
			detail: null,
			updatedAt: now,
		});
		const m = this.store.getMessage(messageId);
		this.store.setDelivery(messageId, me.id, {
			ackedAt: now,
			deliveredGen: r.state === "queued" ? (generationOf(me) ?? "") : undefined,
			// A lease only for a single-recipient ask (level 2); see docs/delivery.md.
			dueAt: m?.tracked === 2 ? now + this.config.leaseMs : null,
		});
		return { ok: true, state: "acked" as const };
	}

	/** `done`: finished. A result is sent to the sender as the reply. */
	markDone(me: Agent, messageId: string) {
		const r = this.mine(me, messageId);
		if (r.state === "done") return { ok: true, state: r.state };
		this.store.forceReceipt({
			...r,
			state: "done",
			via: "agent",
			detail: null,
			updatedAt: Date.now(),
		});
		this.store.setDelivery(messageId, me.id, { dueAt: null });
		return { ok: true, state: "done" as const };
	}

	/** `nack`: declined; with `retry`, delivered again after a backoff. */
	async nack(me: Agent, messageId: string, reason: string, retry: boolean) {
		const r = this.mine(me, messageId);
		if (FINAL_STATES.has(r.state)) return { ok: true, state: r.state };
		const message = this.store.getMessage(messageId);
		if (retry) {
			const attempt = (r.attempt ?? 1) + 1;
			if (attempt > this.config.maxAttempts) {
				if (message?.tracked === 2)
					this.finish(
						messageId,
						me,
						"dead",
						`gave up after ${this.config.maxAttempts} attempts: ${reason}`,
					);
				return { ok: true, state: "dead" as const };
			}
			this.store.setReceipt({
				...r,
				state: "queued",
				attempt,
				via: "agent",
				detail: `declined for now (${reason}); retry ${attempt} of ${this.config.maxAttempts}`,
				updatedAt: Date.now(),
			});
			this.store.setDelivery(messageId, me.id, {
				ackedAt: null,
				dueAt: Date.now() + this.backoff(attempt),
			});
			// An untracked message still gets its retry: track it for restarts.
			if (message && !message.tracked) this.store.setTracked(messageId, 1);
			return { ok: true, state: "queued" as const };
		}
		this.finish(messageId, me, "nacked", `declined: ${reason}`, reason);
		return { ok: true, state: "nacked" as const };
	}
}
