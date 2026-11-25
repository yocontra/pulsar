import { neutralizeHumanTag } from "../human-tag.ts";
import { RpcError } from "../rpc.ts";
import { isBroadcast, matches, parseSelector } from "../selector.ts";
import type { Store } from "../store.ts";
import type { Agent, Message, Priority, Receipt } from "../types.ts";
import { type Caller, OPERATOR_ID } from "./caller.ts";
import { trackLevel } from "./delivery.ts";
import type { EventBus } from "./events.ts";
import { INTERVALS, LIMITS } from "./limits.ts";
import { isLocalSubagentId, isRemote, splitAddress } from "./pool.ts";
import { type Registry, USER_PREFIX } from "./registry.ts";
import type { Router } from "./router.ts";
import {
	clampInt,
	delivered,
	newId,
	normalPriority,
	toPublic,
	writeReceipt,
} from "./util.ts";
import type { Waiters, WaitKind } from "./waiters.ts";

export interface SendInput {
	to: string;
	body: string;
	priority: Priority;
	replyTo: string | null;
	expectReply: boolean;
}

/** Words that name the human operator in a send's `to`, besides their own names. */
const OPERATOR_WORDS = new Set([
	"operator",
	"human",
	"user",
	"human operator",
	"the operator",
	"the user",
	"my operator",
]);

/** A name as `to` aliases compare it: no case, `@` or surrounding quotes. */
function aliasKey(name: string): string {
	return name
		.trim()
		.replace(/^["'@]+|["']+$/g, "")
		.trim()
		.toLowerCase();
}

/** A message id (`m_...`): a history query that is one looks the message up. */
const MESSAGE_ID = /^m_[a-z0-9]+$/;

/** Past this many senders, a send first drops the ones with nothing recent. */
const SEND_LOG_SWEEP = 1000;

/**
 * Messages: send, reply, inbox, history, receipts and waits, with body and
 * rate limits. Delivery itself is the router's.
 */
export class Mailbox {
	private sendLog = new Map<string, number[]>();
	private readonly store: Store;
	private readonly registry: Registry;
	private readonly router: Router;
	private readonly waiters: Waiters;
	private readonly events: EventBus;
	private readonly resolveSubagent: (id: string) => Promise<Agent | undefined>;
	/** Set by the service: tracked messages an inbox read or `wait` handed over. */
	onRead: (agent: Agent, messages: Message[]) => void = () => {};

	constructor(deps: {
		store: Store;
		registry: Registry;
		router: Router;
		waiters: Waiters;
		events: EventBus;
		resolveSubagent?: (id: string) => Promise<Agent | undefined>;
	}) {
		this.store = deps.store;
		this.registry = deps.registry;
		this.router = deps.router;
		this.waiters = deps.waiters;
		this.events = deps.events;
		this.resolveSubagent = deps.resolveSubagent ?? (async () => undefined);
	}

	/** The trimmed body, or an error when it is empty or too large. */
	private checkBody(raw: string): string {
		const body = raw.trim();
		if (!body) throw new RpcError("bad_request", "`body` is empty");
		if (body.length > LIMITS.maxBody)
			throw new RpcError(
				"too_large",
				`body is over ${LIMITS.maxBody} characters`,
			);
		return body;
	}

	/**
	 * The sender's recent send times; prunes entries outside the window.
	 * Keys with nothing recent are dropped, so senders that left (every agent
	 * id and pid ever seen) don't stay in memory.
	 */
	private sendTimes(senderId: string, broadcast: boolean): number[] {
		const now = Date.now();
		if (this.sendLog.size > SEND_LOG_SWEEP) this.sweepSendLog(now);
		const key = broadcast ? `${senderId}#*` : senderId;
		const log = (this.sendLog.get(key) ?? []).filter(
			(t) => now - t < INTERVALS.rateWindowMs,
		);
		if (log.length) this.sendLog.set(key, log);
		else this.sendLog.delete(key);
		return log;
	}

	private sweepSendLog(now: number) {
		for (const [key, log] of this.sendLog)
			if (!log.some((t) => now - t < INTERVALS.rateWindowMs))
				this.sendLog.delete(key);
	}

	/**
	 * Who a send counts against: the sender, its process (a new session id
	 * from the same process is not a fresh budget), and, for agents, every
	 * agent together (minting identities cannot escape it).
	 */
	private rateKeys(sender: Agent): Array<{ key: string; scale: number }> {
		const keys = [{ key: sender.id, scale: 1 }];
		if (sender.pid) keys.push({ key: `pid:${sender.pid}`, scale: 1 });
		if (sender.id !== OPERATOR_ID && !sender.id.startsWith(USER_PREFIX))
			keys.push({ key: "agents:*", scale: LIMITS.allAgentsFactor });
		return keys;
	}

	/** Throws when the sender is at a per-minute cap. Records nothing. */
	private checkRate(sender: Agent, broadcast: boolean) {
		const cap = broadcast ? LIMITS.broadcastsPerMinute : LIMITS.sendsPerMinute;
		for (const { key, scale } of this.rateKeys(sender))
			if (this.sendTimes(key, broadcast).length >= cap * scale)
				throw new RpcError(
					"rate_limited",
					broadcast
						? `at most ${LIMITS.broadcastsPerMinute} broadcasts a minute`
						: `at most ${LIMITS.sendsPerMinute} messages a minute`,
				);
	}

	/** Counts an accepted send against the sender's per-minute caps. */
	private recordSend(sender: Agent, broadcast: boolean) {
		for (const { key } of this.rateKeys(sender)) {
			const log = this.sendTimes(key, broadcast);
			log.push(Date.now());
			this.sendLog.set(broadcast ? `${key}#*` : key, log);
		}
	}

	/**
	 * Sends to the live agents `input.to` selects, or to `resolved` when the
	 * caller resolved them already (the app's explicit id list, a dry run's
	 * token). `to` is then only the label stored with the message.
	 */
	async send(
		sender: Agent,
		input: SendInput,
		resolved?: Agent[],
	): Promise<{ message: Message; receipts: Receipt[] }> {
		if (!input.to.trim())
			throw new RpcError(
				"bad_request",
				"`to` is required: a name, a selector like project=x, or *",
			);
		const body = this.checkBody(input.body);
		const priority = normalPriority(input.priority);
		const selector = parseSelector(input.to);
		const broadcast = isBroadcast(selector);
		const targets = resolved
			? [...new Map(resolved.map((target) => [target.id, target])).values()]
			: this.registry.resolvePool(input.to, sender);
		if (!resolved && !targets.length && selector.kind !== "all") {
			const exact =
				selector.kind === "name"
					? selector.value
					: selector.terms.find(
							(term) => term.key === "id" && !/[*|]/.test(term.value),
						)?.value;
			const address = exact ? splitAddress(exact) : null;
			const local =
				address?.machineId === this.store.machineId() ? address.localId : exact;
			if (local && local !== sender.id) {
				const child = isLocalSubagentId(local)
					? await this.resolveSubagent(local)
					: this.registry.legacySubagentTarget(local);
				if (
					child &&
					child.id !== sender.id &&
					(selector.kind === "name" ||
						matches(this.registry.view(child), {
							...selector,
							terms: selector.terms.map((term) =>
								term.key === "id" && term.value === exact
									? { ...term, value: child.id }
									: term,
							),
						}))
				)
					targets.push(child);
			}
		}
		if (targets.length === 0) {
			if (!resolved && !this.registry.human(sender.id))
				return await this.toOperator(sender, input);
			throw new RpcError(
				"no_recipients",
				`no live agent matches "${input.to}". Call list_agents to see who is online.`,
			);
		}
		this.checkRate(sender, broadcast);
		this.recordSend(sender, broadcast);

		const parent = input.replyTo ? this.store.getMessage(input.replyTo) : null;
		if (parent) this.checkChildReply(sender, parent);
		// The same reply again (a redelivered ask answered twice): the first one stands.
		if (parent) {
			const same = this.sameReply(sender, parent.id, body);
			if (same) return same;
		}
		const tracked = trackLevel(input.expectReply, targets.length, broadcast);
		const message: Message = {
			id: newId("m"),
			threadId: parent?.threadId ?? newId("t"),
			fromId: sender.id,
			fromName: sender.name,
			to: broadcast ? "*" : input.to,
			body,
			priority,
			replyTo: parent?.id ?? null,
			expectReply: input.expectReply,
			createdAt: Date.now(),
			...(tracked ? { tracked } : {}),
		};
		this.store.addMessage(message);
		if (parent) this.store.markReplied(sender.id, parent.id, Date.now());
		this.events.emit("message", {
			message,
			recipients: targets.map((t) => t.name),
		});

		const local = targets.filter((t) => !isRemote(t));
		const remote = targets.filter(isRemote);
		const receipts = [
			...(await Promise.all(
				local.map((t) => this.router.deliver(message, sender, t)),
			)),
			...this.router.deliverRemote(message, sender, remote),
		];
		if (parent)
			this.waiters.resolveReplies(parent.id, delivered(message, sender));
		return { message, receipts };
	}

	/**
	 * A send from an agent that matched no live agent. When `to` names the
	 * human operator ("operator", "user", their login or name, the device
	 * they sent from), it goes to them as a reply to their latest message to
	 * this agent: the same path, and the same rules, as `respond ... reply`.
	 * Otherwise the error says how to answer the operator.
	 */
	private async toOperator(
		sender: Agent,
		input: SendInput,
	): Promise<{ message: Message; receipts: Receipt[] }> {
		const recent = this.store.fromHumansTo(sender.id, 5);
		const want = aliasKey(input.to);
		const ids = recent.map((m) => m.id).join(", ");
		if (this.operatorAliases(recent).has(want)) {
			const latest = recent[0];
			if (!latest)
				throw new RpcError(
					"no_recipients",
					`"${input.to}" is your human operator, not an agent, and no message from them has reached you. To answer the operator, use respond <message id> state=reply text=<answer>, with the id from the "reply: respond m_..." line at the end of their message.`,
				);
			return this.reply(sender, latest.id, input.body, input.priority);
		}
		throw new RpcError(
			"no_recipients",
			`no live agent matches "${input.to}". Call list_agents to see who is online.${
				ids
					? ` To answer your human operator, use respond <message id> state=reply text=<answer> (their latest messages to you: ${ids}), or send to "operator".`
					: ""
			}`,
		);
	}

	/** Every way an agent may name the operator who sent `messages`, as `aliasKey`s. */
	private operatorAliases(messages: Message[]): Set<string> {
		const names = new Set(OPERATOR_WORDS);
		for (const m of messages) {
			const login = m.fromId.slice(
				m.fromId.indexOf(USER_PREFIX) + USER_PREFIX.length,
			);
			const human = this.registry.from(m.fromId, m.fromName);
			for (const n of [
				m.fromName,
				login,
				login.split("@")[0],
				human?.machine,
				human?.meta.operatorName,
			])
				if (n) names.add(aliasKey(n));
		}
		names.delete("");
		return names;
	}

	/** An earlier reply from `sender` to `parentId` with this exact body, with its receipts. */
	private sameReply(
		sender: Agent,
		parentId: string,
		body: string,
	): { message: Message; receipts: Receipt[] } | null {
		const earlier = this.store
			.repliesTo(parentId)
			.find((m) => m.fromId === sender.id && m.body === body);
		return earlier
			? { message: earlier, receipts: this.store.receiptsFor(earlier.id) }
			: null;
	}

	private checkChildReply(sender: Agent, original: Message) {
		if (
			isLocalSubagentId(sender.id) &&
			sender.id !== original.fromId &&
			!this.store.receipt(original.id, sender.id)
		)
			throw new RpcError(
				"forbidden",
				"that message does not belong to this subagent",
			);
	}

	reply(sender: Agent, messageId: string, body: string, priority: Priority) {
		const original = this.store.getMessage(messageId);
		if (!original) throw new RpcError("not_found", `no message ${messageId}`);
		this.checkChildReply(sender, original);
		const same = this.sameReply(sender, original.id, body.trim());
		if (same) return same;
		// A copy a peer delivered: the reply goes back to the sender's machine,
		// whoever sent it (an agent, the user, one that is offline now).
		if (this.store.originOf(original.id)) {
			const sender_ = this.registry.from(original.fromId, original.fromName);
			if (!sender_ || !isRemote(sender_))
				throw new RpcError(
					"gone",
					`${original.fromName} is no longer reachable`,
				);
			return this.send(
				sender,
				{
					to: original.fromId,
					body,
					priority,
					replyTo: original.id,
					expectReply: false,
				},
				[sender_],
			);
		}
		const target = this.registry.deliveryAgent(original.fromId);
		if (target && target.status !== "gone")
			return this.send(sender, {
				to: target.id,
				body,
				priority,
				replyTo: original.id,
				expectReply: false,
			});
		// A human sender (the operator, or the user from the app) reads replies
		// later (`pulsar inbox`, the app); store it for them.
		const human = this.registry.human(original.fromId);
		if (!human)
			throw new RpcError("gone", `${original.fromName} is no longer online`);
		const checked = this.checkBody(body);
		this.checkRate(sender, false);
		this.recordSend(sender, false);
		const message: Message = {
			id: newId("m"),
			threadId: original.threadId,
			fromId: sender.id,
			fromName: sender.name,
			to: human.id === OPERATOR_ID ? "operator" : human.id,
			body: checked,
			priority: normalPriority(priority),
			replyTo: original.id,
			expectReply: false,
			createdAt: Date.now(),
		};
		this.store.addMessage(message);
		this.store.markReplied(sender.id, original.id, Date.now());
		const r = writeReceipt(this.store, message.id, human, "queued", null, null);
		this.events.emit("message", { message, recipients: [human.name] });
		this.waiters.resolveReplies(original.id, delivered(message, sender));
		return { message, receipts: [r] };
	}

	/** The session confirmed (`delivered`) or could not take (`queued`) a push. */
	ack(me: Agent, messageId: string, via: string) {
		this.recipient(me, messageId);
		writeReceipt(this.store, messageId, me, "delivered", via, null);
	}

	nack(me: Agent, messageId: string, reason: string) {
		this.recipient(me, messageId);
		writeReceipt(
			this.store,
			messageId,
			me,
			"queued",
			"extension",
			`the session could not take it: ${reason}`,
		);
	}

	/** Only a recipient acks or nacks: a receipt for anyone else would hand them the message. */
	private recipient(me: Agent, messageId: string) {
		if (!this.store.receipt(messageId, me.id))
			throw new RpcError("not_found", `no message ${messageId} for you`);
	}

	inbox(me: Agent, markRead: boolean, limit: number) {
		const messages = this.store.unread(me.id, limit);
		if (markRead && messages.length) {
			this.store.markRead(
				me.id,
				messages.map((m) => m.id),
				Date.now(),
			);
			this.onRead(me, messages);
		}
		return {
			messages: messages.map((m) => {
				const d = delivered(m, this.registry.get(m.fromId));
				const attempt = this.store.receipt(m.id, me.id)?.attempt ?? 1;
				return attempt > 1 ? { ...d, attempt } : d;
			}),
			held: me.inbound === "hold" ? this.store.held(me.id).length : 0,
			// Messages this agent acked and has not finished (reply or done).
			acked: this.store
				.pendingFor(me.id)
				.filter((p) => p.receipt.state === "acked")
				.map((p) => p.receipt.messageId),
		};
	}

	history(me: Agent, p: Record<string, unknown>) {
		const limit = clampInt(p.limit, 30, 1, 200);
		// Agents read this: no `[human operator]` look-alikes in bodies or names.
		const shown = (ms: Message[]) =>
			ms.map((m) => ({
				...m,
				body: neutralizeHumanTag(m.body),
				fromName: neutralizeHumanTag(m.fromName),
			}));
		if (typeof p.threadId === "string" && p.threadId) {
			if (!this.inThread(me, p.threadId))
				throw new RpcError("not_found", `no thread ${p.threadId}`);
			return { messages: shown(this.store.thread(p.threadId, limit)) };
		}
		// A message id given as the search text (`inbox --query m_...`).
		const query = String(p.query ?? "").trim();
		const messageId =
			typeof p.messageId === "string" && p.messageId
				? p.messageId.trim()
				: MESSAGE_ID.test(query)
					? query
					: "";
		if (messageId) {
			const m = this.store.getMessage(messageId);
			// Another agents' thread reads as missing.
			if (!m || !this.inThread(me, m.threadId))
				throw new RpcError("not_found", `no message ${messageId}`);
			return {
				messages: shown(this.store.thread(m.threadId, limit)),
				receipts: this.store.receiptsFor(m.id),
			};
		}
		const scope = me.id === OPERATOR_ID ? null : me.id;
		return {
			messages: shown(this.store.search(scope, query, limit)),
		};
	}

	/**
	 * True when `me` sent or received a message of the thread. The operator
	 * (the human at the terminal) reads every thread.
	 */
	private inThread(me: Agent, threadId: string): boolean {
		if (me.id === OPERATOR_ID) return true;
		return this.store
			.thread(threadId, 500)
			.some(
				(m) =>
					m.fromId === me.id ||
					this.store.receiptsFor(m.id).some((r) => r.agentId === me.id),
			);
	}

	/**
	 * Blocks for the next message, an agent going idle (`idle:<name>`), or a
	 * reply (`reply:<message id>`). Answers at once when it already happened.
	 */
	wait(
		caller: Caller,
		me: Agent,
		p: Record<string, unknown>,
	): Promise<unknown> {
		const timeoutMs = clampInt(p.timeoutSeconds, 60, 1, 3600) * 1000;
		const forWhat = String(p.for ?? "message");
		let kind: WaitKind = "message";
		let target: string | undefined;
		if (forWhat.startsWith("idle:")) {
			kind = "idle";
			const name = forWhat.slice(5);
			// Any agent in the pool; a remote one's idle comes from its home node's deltas.
			const agent = this.registry.resolvePool(name, me)[0];
			if (!agent)
				throw new RpcError("no_recipients", `no live agent matches "${name}"`);
			if (agent.status === "idle")
				return Promise.resolve({ event: "idle", agent: toPublic(agent) });
			if (this.registry.view(agent).capabilities?.status === false)
				throw new RpcError(
					"unsupported",
					`${agent.name} does not currently report turn status; wait for a reply instead`,
				);
			target = agent.id;
		} else if (forWhat.startsWith("reply:")) {
			kind = "reply";
			target = forWhat.slice(6);
			const existing = this.store.repliesTo(target)[0];
			if (existing)
				return Promise.resolve({
					event: "reply",
					message: delivered(existing, this.registry.get(existing.fromId)),
				});
		} else {
			const queued = this.store.unread(me.id, 1)[0];
			if (queued) {
				this.store.markRead(me.id, [queued.id], Date.now());
				this.onRead(me, [queued]);
				return Promise.resolve({
					event: "message",
					message: delivered(queued, this.registry.get(queued.fromId)),
				});
			}
		}
		return this.waiters.add(caller, me.id, kind, target, timeoutMs);
	}
}
