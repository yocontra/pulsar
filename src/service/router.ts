import { randomUUID } from "node:crypto";
import { pushFor } from "../harnesses/index.ts";
import { neutralizeHumanTag } from "../human-tag.ts";
import { daemonLog } from "../log.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent, Message, Receipt } from "../types.ts";
import type { Caller } from "./caller.ts";
import { LIMITS } from "./limits.ts";
import { isLocalSubagentId, isRemote } from "./pool.ts";
import type { Registry } from "./registry.ts";
import type { Sessions } from "./sessions.ts";
import {
	delivered,
	formatPush,
	type PushMessage,
	writeReceipt,
} from "./util.ts";
import type { Waiters } from "./waiters.ts";

/** Stored per recipient because Send now promotes only that recipient's delivery. */
export const URGENT_HANDOFF = "sent with urgent priority";
export const NEXT_TURN = "pulsar-next-turn";

/**
 * Local delivery: inbound policy, inbox cap, waiting `ask`/`wait` calls, live
 * connections, and the push path (extension connection or harness driver).
 */
export class Router {
	private readonly store: Store;
	private readonly registry: Registry;
	private readonly sessions: Sessions;
	private readonly waiters: Waiters;
	private readonly resolveSubagent: (id: string) => Promise<Agent | undefined>;
	/** Set by the service: a tracked message reached a session. */
	onHandoff: (message: Message, agent: Agent, receipt: Receipt) => void =
		() => {};
	onUncertain: (receipt: Receipt) => void = () => {};

	private readonly reportedExtensionStatus = new WeakMap<
		Caller,
		{ agentId: string; status: "busy" | "idle" }
	>();
	private readonly releasingNextTurn = new Set<string>();
	private readonly pushing = new Map<string, Promise<Receipt>>();
	private readonly waking = new Map<string, Promise<Receipt>>();
	private readonly wakeRequests = new Map<
		string,
		{ caller: Caller; finish: (ok: boolean) => void }
	>();

	/** Replies belong to the specific relay connection that received the request. */
	wakeResult(caller: Caller, params: Record<string, unknown>) {
		const request = this.wakeRequests.get(String(params.requestId));
		if (!request || request.caller !== caller) return { ok: false };
		request.finish(params.ok === true);
		return { ok: true };
	}

	private wake(
		caller: Caller,
		target: Agent,
		message: PushMessage,
		text: string,
	) {
		const key = JSON.stringify([target.id, message.id]);
		const pending = this.waking.get(key);
		if (pending) return pending;
		const requestId = randomUUID();
		const result = new Promise<Receipt>((resolve) => {
			const finish = (ok: boolean) => {
				clearTimeout(timeout);
				caller.closed.removeEventListener("abort", cancel);
				this.wakeRequests.delete(requestId);
				resolve(
					this.receipt(
						message.id,
						target,
						ok ? "delivered" : "queued",
						"native-wake",
						ok
							? message.priority === "urgent"
								? URGENT_HANDOFF
								: null
							: "The native conversation could not take the message.",
					),
				);
			};
			const cancel = () => finish(false);
			const timeout = setTimeout(cancel, 15_000);
			this.wakeRequests.set(requestId, { caller, finish });
			caller.closed.addEventListener("abort", cancel, { once: true });
			if (caller.closed.aborted) cancel();
			else
				caller.emit("wake", {
					requestId,
					messageId: message.id,
					attempt: message.attempt ?? 1,
					sessionId: target.sessionId,
					text,
				});
		}).finally(() => this.waking.delete(key));
		this.waking.set(key, result);
		return result;
	}

	constructor(deps: {
		store: Store;
		registry: Registry;
		sessions: Sessions;
		waiters: Waiters;
		resolveSubagent?: (id: string) => Promise<Agent | undefined>;
	}) {
		this.store = deps.store;
		this.registry = deps.registry;
		this.sessions = deps.sessions;
		this.waiters = deps.waiters;
		this.resolveSubagent = deps.resolveSubagent ?? (async () => undefined);
	}

	private receipt(
		messageId: string,
		agent: Agent,
		state: Receipt["state"],
		via: string | null,
		detail: string | null,
	) {
		return writeReceipt(this.store, messageId, agent, state, via, detail);
	}

	async deliver(
		message: Message,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		const current = isLocalSubagentId(target.id)
			? await this.resolveSubagent(target.id)
			: target;
		if (!current) return this.unavailableSubagent(message.id, target);
		const r = await this.route(message, sender, current);
		return this.handedOff(message, current, r);
	}

	private unavailableSubagent(messageId: string, target: Agent) {
		return this.receipt(
			messageId,
			target,
			"refused",
			null,
			"subagent is no longer available for direct messages",
		);
	}

	private async route(
		message: Message,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		// Remember now whether the user sent this with a passkey session: a
		// held or queued copy is pushed later, when the sender object differs.
		this.registry.noteMessageFraming(message.id, sender);
		if (isRemote(target))
			throw new RpcError("internal", `${target.id} is not on this machine`);
		if (target.inbound === "refuse")
			return this.receipt(
				message.id,
				target,
				"refused",
				null,
				"recipient refuses messages",
			);
		if (target.inbound === "hold")
			return this.receipt(
				message.id,
				target,
				"held",
				null,
				"recipient holds messages",
			);
		if (this.store.unreadCount(target.id) >= LIMITS.inboxCap) {
			return this.receipt(
				message.id,
				target,
				"refused",
				null,
				`recipient inbox is full (${LIMITS.inboxCap} unread)`,
			);
		}
		this.receipt(message.id, target, "queued", null, null);
		const msg = delivered(message, sender);

		// A reply that an `ask` is blocked on goes to that call only. Pushing it
		// too would start a second prompt in the asker's session and interrupt it.
		if (this.waiters.takeReply(target.id, msg)) {
			this.store.markRead(target.id, [message.id], Date.now());
			return this.receipt(message.id, target, "read", "ask", null);
		}

		// Live pulsar connections hear about every message (MCP notifications, waiters).
		for (const c of this.sessions.forAgent(target.id)) c.emit("message", msg);
		if (this.waiters.takeMessage(target.id, msg)) {
			this.store.markRead(target.id, [message.id], Date.now());
			return this.receipt(message.id, target, "read", "wait", null);
		}
		if (message.priority === "fyi")
			return this.receipt(
				message.id,
				target,
				"queued",
				null,
				"fyi: waits in the inbox",
			);
		return this.pushCurrent(message, sender, target);
	}

	private handedOff(message: Message, target: Agent, r: Receipt): Receipt {
		if (message.tracked) this.onHandoff(message, target, r);
		return r;
	}

	/**
	 * Hands a message for agents on other machines to the pool's outbox, one
	 * batch per home machine. Each target gets a `queued` receipt now; its
	 * home node's receipts replace it as they arrive.
	 */
	deliverRemote(message: Message, sender: Agent, targets: Agent[]): Receipt[] {
		if (targets.length === 0) return [];
		const pool = this.registry.pool;
		if (!pool)
			throw new RpcError("unsupported", "this daemon has no pool links");
		const byMachine = new Map<string, Agent[]>();
		for (const t of targets) {
			const id = t.meta.machineId!;
			const list = byMachine.get(id);
			if (list) list.push(t);
			else byMachine.set(id, [t]);
		}
		// Any user sender (verified or not) goes as the user; the frame says which.
		const fromUser = this.registry.userFraming(sender) !== null;
		const receipts: Receipt[] = [];
		for (const [machineId, list] of byMachine) {
			const r = pool.enqueue(machineId, message, sender, fromUser, list);
			for (const t of list)
				receipts.push(this.receipt(message.id, t, r.state, r.via, r.detail));
		}
		return receipts;
	}

	async push(
		message: PushMessage,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		const current = isLocalSubagentId(target.id)
			? await this.resolveSubagent(target.id)
			: target;
		return current
			? this.pushCurrent(message, sender, current)
			: this.unavailableSubagent(message.id, target);
	}

	activeHandoff(agentId: string, messageId: string) {
		return this.pushing.has(JSON.stringify([agentId, messageId]));
	}

	private async pushCurrent(
		message: PushMessage,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		const key = JSON.stringify([target.id, message.id]);
		const pending = this.pushing.get(key);
		if (pending) return pending;
		if (
			message.priority === "normal" &&
			!isLocalSubagentId(target.id) &&
			this.registry.canSteer(target) &&
			(target.status === "busy" || !this.extensionReadyForTurn(target))
		) {
			return this.receipt(
				message.id,
				target,
				"queued",
				NEXT_TURN,
				"Waiting for the current turn to finish",
			);
		}
		const handoff = Promise.resolve().then(() =>
			this.handoff(message, sender, target),
		);
		this.pushing.set(key, handoff);
		try {
			return await handoff;
		} finally {
			this.pushing.delete(key);
		}
	}

	private extensionReadyForTurn(agent: Agent): boolean {
		const extension = this.sessions.extensionFor(agent.id);
		if (!extension) return this.canPush(agent);
		if (agent.meta.acp !== "1" && !this.sessions.supports(extension, "steer"))
			return true;
		const report = this.reportedExtensionStatus.get(extension);
		return report?.agentId === agent.id && report.status === "idle";
	}

	reportStatus(caller: Caller, agent: Agent, status: "busy" | "idle") {
		if (caller !== this.sessions.extensionFor(agent.id)) return;
		this.reportedExtensionStatus.set(caller, { agentId: agent.id, status });
		if (status === "idle") void this.releaseNextTurn(agent);
	}

	/** Deliver only the messages Pulsar retained for this turn boundary. */
	async releaseNextTurn(agent: Agent) {
		const agentId = agent.id;
		if (this.releasingNextTurn.has(agentId)) return;
		this.releasingNextTurn.add(agentId);
		try {
			if (this.registry.closed) return;
			for (const queued of this.store.unread(agentId, LIMITS.inboxCap)) {
				const current = this.registry.get(agentId);
				if (
					this.registry.closed ||
					!current ||
					!this.extensionReadyForTurn(current) ||
					current.inbound !== "accept" ||
					(current.status !== "idle" && current.status !== "unknown")
				)
					break;
				const receipt = this.store.receipt(queued.id, agentId);
				if (
					receipt?.state !== "queued" ||
					receipt.via !== NEXT_TURN ||
					this.activeHandoff(agentId, queued.id)
				)
					continue;
				const message = this.store.getMessage(queued.id);
				if (!message) continue;
				const attempt = receipt.attempt ?? 1;
				const push = attempt > 1 ? { ...message, attempt } : message;
				const result = await this.push(
					push,
					this.registry.senderOf(message),
					current,
				);
				this.handedOff(message, current, result);
				// This connection will report the end of the new turn.
				if (current.meta.acp === "1" && result.state === "sent") break;
			}
		} catch (error) {
			if (!this.registry.closed)
				daemonLog(`next-turn delivery failed: ${error}`);
		} finally {
			this.releasingNextTurn.delete(agentId);
		}
	}

	private frame(message: PushMessage, sender: Agent) {
		const framing = this.registry.messageFraming(message.id, sender);
		return formatPush(
			message,
			sender,
			framing === "verified"
				? { kind: "human", name: this.registry.operatorNameOf(sender) }
				: framing === "unverified"
					? { kind: "unverified" }
					: { kind: "agent" },
		);
	}

	/** Handoff only unread input. A claim prevents a concurrent inbox read or push from duplicating it. */
	takeForHook(
		caller: Caller,
		target: Agent,
		first: boolean,
	): Array<{ id: string; text: string }> {
		if (target.inbound !== "accept" || caller.closed.aborted) return [];
		const messages: Array<{ id: string; text: string; attempt: number }> = [];
		for (const m of this.store.unread(target.id, LIMITS.inboxCap)) {
			if (
				m.priority === "fyi" ||
				(m.priority === "normal" && !first) ||
				this.activeHandoff(target.id, m.id)
			)
				continue;
			const sender = this.registry.from(m.fromId, m.fromName);
			if (!sender) continue;
			const attempt = this.store.receipt(m.id, target.id)?.attempt ?? 1;
			const text = this.frame(
				{ ...m, attempt },
				{ ...sender, name: m.fromName },
			);
			const receipt = this.receipt(
				m.id,
				target,
				"sent",
				"native-hook",
				"Submitted to the session hook",
			);
			this.handedOff(m, target, receipt);
			messages.push({ id: m.id, text, attempt });
			if (messages.length === 8) break;
		}
		if (messages.length)
			caller.closed.addEventListener(
				"abort",
				() => {
					for (const m of messages) {
						const current = this.store.receipt(m.id, target.id);
						if (
							current?.state !== "sent" ||
							current.via !== "native-hook" ||
							current.attempt !== m.attempt
						)
							continue;
						this.onUncertain(
							this.receipt(
								m.id,
								target,
								"nacked",
								"native-hook",
								"Delivery unknown: the native hook closed before it confirmed submission.",
							),
						);
					}
				},
				{ once: true },
			);
		return messages;
	}

	private async handoff(
		message: PushMessage,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		const text = this.frame(message, sender);
		const detail = message.priority === "urgent" ? URGENT_HANDOFF : null;
		const ext = this.sessions.extensionFor(target.id);
		if (ext) {
			ext.emit("push", {
				message: { ...delivered(message, sender), ...attemptOf(message) },
				text,
			});
			// The extension acks once the message is in the conversation.
			return this.receipt(message.id, target, "sent", "extension", detail);
		}
		const relay = this.registry.wakeRelay(target);
		if (relay) return this.wake(relay, target, message, text);
		if (
			target.meta.subagentPull === "1" ||
			target.meta.subagentPull === "native-hook"
		)
			return this.receipt(
				message.id,
				target,
				"queued",
				null,
				"waiting for this subagent's next supported hook",
			);
		if (target.meta.subagentPull === "inbox")
			return this.receipt(
				message.id,
				target,
				"queued",
				null,
				"waiting in this subagent's own inbox",
			);
		if (isLocalSubagentId(target.id) && target.meta.subagentNative !== "1")
			return this.receipt(
				message.id,
				target,
				"refused",
				null,
				"subagent is no longer connected",
			);
		const adapter = pushFor(target);
		if (!adapter)
			return this.receipt(
				message.id,
				target,
				"queued",
				null,
				"no push path: waits in the inbox",
			);
		const result = await adapter.deliver(
			target,
			text,
			message.priority,
			neutralizeHumanTag(sender.name),
		);
		if (result.uncertain) {
			const receipt = this.receipt(
				message.id,
				target,
				"nacked",
				result.via,
				`Delivery unknown: ${result.detail ?? "the session did not confirm the handoff."}`,
			);
			this.onUncertain(receipt);
			return receipt;
		}
		return result.ok
			? this.receipt(message.id, target, "sent", result.via, detail)
			: this.receipt(
					message.id,
					target,
					"queued",
					result.via,
					`push failed, waits in the inbox: ${result.detail ?? "unknown"}`,
				);
	}

	/** True when a message can be pushed into the agent's session now (extension or harness driver). */
	canPush(target: Agent): boolean {
		return this.registry.reachOf(target) === "push";
	}

	/** Pushes what arrived while the session had no pulsar connection. */
	async flushQueued(agent: Agent, maxAttempts?: number) {
		for (const queued of this.store.unread(agent.id)) {
			if (this.registry.closed) break;
			const msg = this.store.getMessage(queued.id);
			if (!msg) continue;
			const receipt = this.store.receipt(msg.id, agent.id);
			if (
				msg.priority === "fyi" ||
				receipt?.state !== "queued" ||
				receipt.via === NEXT_TURN
			)
				continue;
			const sender = this.registry.senderOf(msg);
			// A redelivery that waited in the inbox keeps its attempt number.
			const attempt = receipt.attempt ?? 1;
			const push: PushMessage =
				attempt > 1 && maxAttempts ? { ...msg, attempt, maxAttempts } : msg;
			this.handedOff(msg, agent, await this.push(push, sender, agent));
		}
		if (!this.registry.closed) await this.releaseNextTurn(agent);
	}

	/** Releases held messages once the agent accepts again. */
	async releaseHeld(agent: Agent) {
		for (const msg of this.store.held(agent.id)) {
			const sender = this.registry.senderOf(msg);
			const queued = this.receipt(msg.id, agent, "queued", null, null);
			this.handedOff(
				msg,
				agent,
				msg.priority !== "fyi" ? await this.push(msg, sender, agent) : queued,
			);
		}
	}
}

/** The attempt fields a redelivery's push carries. */
function attemptOf(m: PushMessage) {
	return m.attempt && m.attempt > 1
		? { attempt: m.attempt, maxAttempts: m.maxAttempts }
		: {};
}
