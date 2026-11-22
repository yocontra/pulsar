import type {
	QueueActResult,
	QueueItem,
	QueueList,
	QueueState,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent, Message, Receipt } from "../types.ts";
import type { Acting } from "./acting.ts";
import { authorize } from "./authorize.ts";
import { type Principal, principalLabel } from "./caller.ts";
import type { Deliveries } from "./delivery.ts";
import type { EventBus } from "./events.ts";
import { LIMITS } from "./limits.ts";
import { isRemote, type RemoteQueueAct, splitAddress } from "./pool.ts";
import type { Registry } from "./registry.ts";
import type { Router } from "./router.ts";
import type { PushMessage } from "./util.ts";

export type QueueAction = RemoteQueueAct["action"];

/** Receipt states a message can still be withdrawn or edited in. */
const WAITING = new Set(["queued", "held"]);

const WHY = {
	handed:
		"It's with the session already and lands when the current turn ends. Stop the turn to have it land now.",
	notMine: "Only your own messages can be edited",
	noPush: "This agent can't take it now; it reads its inbox at its next turn",
	gone: "The agent is offline",
	offline: "Its machine is offline; it goes when the machine is back",
	elsewhere: "It already reached another recipient",
} as const;

/**
 * The queue strip: messages to one agent that are not in its conversation
 * yet, from the operator and from other agents, and what the operator can
 * do about each one before it lands.
 *
 * - Withdraw: a message still waiting (inbox, held, a retry, this node's
 *   outbox) gets the final receipt `withdrawn`; a sender blocked on an
 *   `ask` stops waiting and gets a notice. Never once the harness has it.
 * - Send now: pushed at once as urgent (a held one too); for the outbox, the
 *   machine is tried now.
 * - Edit: the operator's own message, while no recipient has it yet.
 *
 * The operator's own messages follow the rule for sending (the app's user,
 * no proof needed). Anyone else's need Prove Human: the acting ops
 * `queue.withdraw` / `queue.promote`, so for a remote agent its home node
 * verifies the passkey itself.
 */
export class Queue {
	private readonly store: Store;
	private readonly registry: Registry;
	private readonly router: Router;
	private readonly deliveries: Deliveries;
	private readonly acting: Acting;
	/** When each local agent's current busy stretch began (from `agent:status`). */
	private busySince = new Map<string, number>();
	/** Before the first status change seen, a busy agent counts as busy since this. */
	private readonly started = Date.now();

	constructor(deps: {
		store: Store;
		registry: Registry;
		router: Router;
		deliveries: Deliveries;
		events: EventBus;
		acting: Acting;
	}) {
		this.store = deps.store;
		this.registry = deps.registry;
		this.router = deps.router;
		this.deliveries = deps.deliveries;
		this.acting = deps.acting;
		deps.events.on("agent:status", ({ agentId, to, at }) => {
			if (to === "busy") this.busySince.set(agentId, at);
			else this.busySince.delete(agentId);
		});
		for (const action of ["withdraw", "promote"] as const)
			this.acting.register(`queue.${action}`, async ({ user, agent, params }) =>
				this.apply(user, agent!, messageIdOf(params), action, {
					verified: true,
				}),
			);
	}

	/** `GET /agents/:id/queue`: what waits for an agent, here and on its home node. */
	async list(p: Principal, agentId: string): Promise<QueueList> {
		authorize(p, "transcript.read", agentId);
		const agent = this.registry.find(agentId);
		if (!agent) throw new RpcError("not_found", `no agent ${agentId}`);
		if (!isRemote(agent))
			return { agentId: agent.id, items: this.local(p, agent) };
		const items = this.outbox(p, agent);
		const remote = this.registry.pool?.queue;
		if (!remote)
			return { agentId: agent.id, items, partial: "no pool links here" };
		try {
			const home = await remote.list(agent.id, p);
			return { agentId: agent.id, items: sortItems([...items, ...home]) };
		} catch (e) {
			return {
				agentId: agent.id,
				items,
				partial: `${agent.machine ?? "its machine"} did not answer: ${(e as Error).message}`,
			};
		}
	}

	/**
	 * Withdraw, send now or edit one message waiting for `agentId`. The
	 * operator's own: as a send. Anyone else's: Prove Human (here, or the
	 * home node's check with `assertion`). Edit: own messages only.
	 */
	async act(
		p: Principal,
		agentId: string,
		messageId: string,
		action: QueueAction,
		opts: { body?: string; assertion?: unknown } = {},
	): Promise<QueueActResult> {
		const agent = this.registry.find(agentId);
		if (!agent) throw new RpcError("not_found", `no agent ${agentId}`);
		if (action === "edit") checkBody(opts.body);
		// This node's outbox: the message has not left for the agent's machine.
		const parts = isRemote(agent) ? splitAddress(agent.id) : null;
		if (parts && this.inOutbox(parts.machineId, messageId, parts.localId)) {
			const message = this.message(messageId);
			if (isMine(p, message)) authorize(p, "send");
			else if (action === "edit") throw new RpcError("forbidden", WHY.notMine);
			// Someone else's message waiting here: Prove Human on this node.
			else authorize(p, `queue.${action}`, agent.id);
			return {
				ok: true,
				receipt: this.applyOutbox(p, agent, message, action, opts.body),
			};
		}
		if (!parts) {
			const message = this.message(messageId);
			if (isMine(p, message)) {
				authorize(p, "send");
				return {
					ok: true,
					receipt: await this.apply(p, agent.id, messageId, action, {
						body: opts.body,
						verified: p.kind === "human" && p.verified === true,
					}),
				};
			}
			if (action === "edit") throw new RpcError("forbidden", WHY.notMine);
			const receipt = (await this.acting.run(
				p,
				`queue.${action}`,
				{ agent: agent.id },
				{ messageId },
				opts.assertion,
			)) as Receipt | null;
			return { ok: true, receipt };
		}
		// On the agent's machine. The operator's own: forwarded as a send is;
		// that node checks the message is theirs.
		if (opts.assertion === undefined) {
			authorize(p, "send");
			const remote = this.registry.pool?.queue;
			if (!remote)
				throw new RpcError("unsupported", "this daemon has no pool links");
			const receipt = await remote.act(
				agent.id,
				{
					messageId,
					action,
					...(opts.body !== undefined ? { body: opts.body } : {}),
				},
				p,
			);
			// Keep this node's copy of an edited send in step.
			if (action === "edit" && this.store.getMessage(messageId))
				this.store.setMessageBody(messageId, opts.body!.trim());
			return { ok: true, receipt };
		}
		if (action === "edit") throw new RpcError("forbidden", WHY.notMine);
		const receipt = (await this.acting.run(
			p,
			`queue.${action}`,
			{ agent: agent.id },
			{ messageId },
			opts.assertion,
		)) as Receipt | null;
		return { ok: true, receipt };
	}

	/**
	 * Home node, for a peer: a queue action on one of the operator's own
	 * messages, forwarded like a send (`act: queue.act`). Anyone else's
	 * message needs the acting ops and their passkey check instead.
	 */
	async relayed(
		user: Principal,
		agentId: string,
		req: RemoteQueueAct,
	): Promise<Receipt | null> {
		if (!this.registry.get(agentId))
			throw new RpcError("not_found", `no agent ${agentId}`);
		const message = this.message(req.messageId);
		if (!isMine(user, message))
			throw new RpcError(
				"forbidden",
				"someone else's message: prove you're human for this action",
			);
		if (req.action === "edit") checkBody(req.body);
		authorize(user, "send");
		// A forwarded edit carries no proof: the message goes out unverified.
		return this.apply(user, agentId, req.messageId, req.action, {
			body: req.body,
			verified: false,
		});
	}

	/** One local agent's queue, as `p` sees it. */
	local(p: Principal, agent: Agent): QueueItem[] {
		const items: QueueItem[] = [];
		const pushable = agent.status !== "gone" && this.router.canPush(agent);
		for (const { message, receipt, dueAt } of this.store.queueFor(agent.id)) {
			const mine = isMine(p, message);
			let state: QueueState;
			if (receipt.state === "sent") {
				if (!this.waitsForIdle(agent, message, receipt)) continue;
				items.push(
					this.item(agent.id, message, receipt, mine, {
						state: "idle",
						where: "home",
						dueAt: null,
						withdraw: WHY.handed,
						promote: WHY.handed,
						edit: mine ? WHY.handed : WHY.notMine,
					}),
				);
				continue;
			}
			if (receipt.state === "held") state = "held";
			else if (isRetry(receipt, dueAt)) state = "retrying";
			else state = "next-turn";
			const editable = mine && this.editable(message);
			items.push(
				this.item(agent.id, message, receipt, mine, {
					state,
					where: "home",
					dueAt: state === "retrying" ? dueAt : null,
					...(pushable
						? {}
						: { promote: agent.status === "gone" ? WHY.gone : WHY.noPush }),
					...(editable ? {} : { edit: mine ? WHY.elsewhere : WHY.notMine }),
				}),
			);
		}
		return items;
	}

	/** What waits in this node's outbox for a remote agent. */
	outbox(p: Principal, agent: Agent): QueueItem[] {
		const parts = splitAddress(agent.id);
		if (!parts) return [];
		const link = this.registry.pool?.machine(parts.machineId)?.link;
		const items: QueueItem[] = [];
		for (const e of this.store.outboxFor(parts.machineId)) {
			if (!e.targetIds.includes(parts.localId)) continue;
			const message = this.store.getMessage(e.messageId);
			if (!message) continue;
			const receipt = this.store.receipt(message.id, agent.id) ?? {
				messageId: message.id,
				agentId: agent.id,
				agentName: agent.name,
				state: "queued" as const,
				via: "pool",
				detail: null,
				updatedAt: e.createdAt,
			};
			const mine = isMine(p, message);
			const online = link === "tailnet";
			items.push(
				this.item(agent.id, message, receipt, mine, {
					state: online ? "sending" : "offline",
					where: "outbox",
					dueAt: online ? e.nextAttemptAt : null,
					...(online ? {} : { promote: WHY.offline }),
					...(mine && this.editable(message)
						? {}
						: { edit: mine ? WHY.elsewhere : WHY.notMine }),
				}),
			);
		}
		return items;
	}

	/**
	 * Runs one action on a local agent's receipt. Callers authorized it.
	 * `verified`: the caller proved they're human (an edit keeps the
	 * message's operator tag only then).
	 */
	async apply(
		user: Principal,
		agentId: string,
		messageId: string,
		action: QueueAction,
		opts: { body?: string; verified: boolean },
	): Promise<Receipt | null> {
		const agent = this.registry.get(agentId);
		if (!agent) throw new RpcError("not_found", `no agent ${agentId}`);
		const message = this.message(messageId);
		const current = this.store.receipt(messageId, agent.id);
		if (!current || !WAITING.has(current.state))
			throw new RpcError(
				"conflict",
				current?.state === "sent"
					? WHY.handed
					: "It is no longer waiting for this agent",
			);
		this.audit(user, `queue.${action}`, agent.id, messageId);
		switch (action) {
			case "withdraw": {
				if (
					!this.store.withdrawReceipt(
						messageId,
						agent.id,
						`withdrawn by ${operatorName(user)}`,
						Date.now(),
					)
				)
					throw new RpcError("conflict", "It is no longer waiting");
				const r = this.store.receipt(messageId, agent.id);
				if (r) this.deliveries.settle(messageId, r);
				return r;
			}
			case "promote": {
				if (agent.status === "gone" || !this.router.canPush(agent))
					throw new RpcError(
						"unsupported",
						agent.status === "gone" ? WHY.gone : WHY.noPush,
					);
				const sender = this.registry.senderOf(message);
				const attempt = current.attempt ?? 1;
				const push: PushMessage = {
					...message,
					priority: "urgent",
					...(attempt > 1
						? {
								attempt,
								maxAttempts: this.deliveries.config.maxAttempts,
							}
						: {}),
				};
				const r = await this.router.push(push, sender, agent);
				if (message.tracked) this.deliveries.handedOff(message, agent, r);
				return r;
			}
			case "edit": {
				if (!isMine(user, message))
					throw new RpcError("forbidden", WHY.notMine);
				if (!this.editable(message))
					throw new RpcError("conflict", WHY.elsewhere);
				this.store.setMessageBody(messageId, opts.body!.trim());
				if (!opts.verified) this.registry.unverifyMessage(messageId);
				return this.store.receipt(messageId, agent.id);
			}
		}
	}

	/** An action on a message in this node's outbox for a remote agent. */
	private applyOutbox(
		user: Principal,
		agent: Agent,
		message: Message,
		action: QueueAction,
		body: string | undefined,
	): Receipt | null {
		const parts = splitAddress(agent.id)!;
		this.audit(user, `queue.${action}`, agent.id, message.id);
		switch (action) {
			case "withdraw": {
				if (
					!this.store.outboxDropTarget(
						parts.machineId,
						message.id,
						parts.localId,
					)
				)
					throw new RpcError("conflict", "It already left for that machine");
				const r: Receipt = {
					messageId: message.id,
					agentId: agent.id,
					agentName: agent.name,
					state: "withdrawn",
					via: "operator",
					detail: `withdrawn by ${operatorName(user)}`,
					updatedAt: Date.now(),
				};
				this.store.setReceipt(r);
				this.deliveries.settle(message.id, r);
				return this.store.receipt(message.id, agent.id);
			}
			case "promote": {
				const link = this.registry.pool?.machine(parts.machineId)?.link;
				if (link !== "tailnet") throw new RpcError("unreachable", WHY.offline);
				this.registry.pool?.queue?.wake(parts.machineId);
				return this.store.receipt(message.id, agent.id);
			}
			case "edit": {
				if (!this.editable(message))
					throw new RpcError("conflict", WHY.elsewhere);
				this.store.setMessageBody(message.id, body!.trim());
				if (!(user.kind === "human" && user.verified === true))
					this.registry.unverifyMessage(message.id);
				return this.store.receipt(message.id, agent.id);
			}
		}
	}

	/**
	 * True while a message the harness has waits for the current turn to
	 * end: it was handed over during this busy stretch and was not urgent
	 * (an urgent one lands between tool calls).
	 */
	private waitsForIdle(agent: Agent, message: Message, r: Receipt): boolean {
		if (message.priority === "urgent" || agent.status !== "busy") return false;
		const since = this.busySince.get(agent.id) ?? this.started;
		return r.updatedAt >= since;
	}

	/**
	 * True while no recipient has the message: every local receipt waits or
	 * is held, and every remote one is still in this node's outbox.
	 */
	private editable(message: Message): boolean {
		for (const r of this.store.receiptsFor(message.id)) {
			if (r.state === "withdrawn") continue;
			const parts = splitAddress(r.agentId);
			if (parts) {
				if (!this.inOutbox(parts.machineId, message.id, parts.localId))
					return false;
			} else if (!WAITING.has(r.state)) return false;
		}
		return true;
	}

	private inOutbox(machineId: string, messageId: string, localId: string) {
		return this.store
			.outboxFor(machineId)
			.some((e) => e.messageId === messageId && e.targetIds.includes(localId));
	}

	private message(messageId: string): Message {
		const m = this.store.getMessage(messageId);
		if (!m) throw new RpcError("not_found", `no message ${messageId}`);
		return m;
	}

	private item(
		agentId: string,
		message: Message,
		receipt: Receipt,
		mine: boolean,
		o: {
			state: QueueState;
			where: QueueItem["where"];
			dueAt: number | null;
			withdraw?: string;
			promote?: string;
			edit?: string;
		},
	): QueueItem {
		const why: QueueItem["why"] = {};
		if (o.withdraw) why.withdraw = o.withdraw;
		if (o.promote) why.promote = o.promote;
		if (o.edit) why.edit = o.edit;
		return {
			messageId: message.id,
			agentId,
			from: { id: message.fromId, name: mine ? "You" : message.fromName },
			mine,
			body: message.body,
			priority: message.priority,
			createdAt: message.createdAt,
			state: o.state,
			detail: receipt.detail,
			attempt: receipt.attempt ?? 1,
			dueAt: o.dueAt,
			where: o.where,
			canWithdraw: !o.withdraw,
			canPromote: !o.promote,
			canEdit: !o.edit,
			why,
		};
	}

	private audit(
		user: Principal,
		op: string,
		target: string,
		messageId: string,
	) {
		this.store.audit({
			at: Date.now(),
			principal: principalLabel(user),
			op,
			target,
			detail: JSON.stringify({ messageId }),
			ok: true,
		});
	}
}

/** The operator sent it from the app: `user:<login>` here, `<machine>/user:<login>` from a peer. */
export function isMine(p: Principal, m: Pick<Message, "fromId">): boolean {
	if (p.kind !== "human") return false;
	const id = `user:${p.login}`;
	return m.fromId === id || m.fromId.endsWith(`/${id}`);
}

/** A queued receipt that waits for a retry rather than for the agent's next turn. */
function isRetry(r: Receipt, dueAt: number | null): boolean {
	if ((r.attempt ?? 1) > 1 && dueAt !== null) return true;
	const d = r.detail ?? "";
	return d.startsWith("push failed") || d.startsWith("declined for now");
}

function sortItems(items: QueueItem[]): QueueItem[] {
	return items.sort((a, b) => a.createdAt - b.createdAt);
}

function messageIdOf(params: unknown): string {
	const id = (params as { messageId?: unknown } | null)?.messageId;
	if (typeof id !== "string" || !id)
		throw new RpcError("bad_request", "`messageId` is required");
	return id;
}

function checkBody(body: unknown): asserts body is string {
	if (typeof body !== "string" || !body.trim())
		throw new RpcError("bad_request", "`body` is empty");
	if (body.trim().length > LIMITS.maxBody)
		throw new RpcError(
			"too_large",
			`body is over ${LIMITS.maxBody} characters`,
		);
}

function operatorName(p: Principal): string {
	return p.kind === "human" ? (p.name ?? p.login) : "the operator";
}
