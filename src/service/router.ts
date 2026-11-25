import { pushFor } from "../harnesses/index.ts";
import { neutralizeHumanTag } from "../human-tag.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent, Message, Receipt } from "../types.ts";
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

	private async pushCurrent(
		message: PushMessage,
		sender: Agent,
		target: Agent,
	): Promise<Receipt> {
		const framing = this.registry.messageFraming(message.id, sender);
		const text = formatPush(
			message,
			sender,
			framing === "verified"
				? { kind: "human", name: this.registry.operatorNameOf(sender) }
				: framing === "unverified"
					? { kind: "unverified" }
					: { kind: "agent" },
		);
		const ext = this.sessions.extensionFor(target.id);
		if (ext) {
			ext.emit("push", {
				message: { ...delivered(message, sender), ...attemptOf(message) },
				text,
			});
			// The extension acks once the message is in the conversation.
			return this.receipt(message.id, target, "sent", "extension", null);
		}
		if (target.meta.subagentPull === "1")
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
		return result.ok
			? this.receipt(message.id, target, "sent", result.via, null)
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
		if (target.meta.subagentPull) return false;
		return (
			!!this.sessions.extensionFor(target.id) ||
			((!isLocalSubagentId(target.id) || target.meta.subagentNative === "1") &&
				!!pushFor(target))
		);
	}

	/** Pushes what arrived while the session had no pulsar connection. */
	async flushQueued(agent: Agent, maxAttempts?: number) {
		for (const msg of this.store.unread(agent.id)) {
			if (msg.priority === "fyi") continue;
			const sender = this.registry.senderOf(msg);
			// A redelivery that waited in the inbox keeps its attempt number.
			const attempt = this.store.receipt(msg.id, agent.id)?.attempt ?? 1;
			const push: PushMessage =
				attempt > 1 && maxAttempts ? { ...msg, attempt, maxAttempts } : msg;
			this.handedOff(msg, agent, await this.push(push, sender, agent));
		}
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
