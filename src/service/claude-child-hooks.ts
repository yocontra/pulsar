import { readClaudeSession } from "../harnesses/claude-ident.ts";
import { lazyCrypto } from "../lazy.ts";
import { pidAlive } from "../processes.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";
import { agentIdOf, type Caller } from "./caller.ts";
import { SUB_MARK } from "./pool.ts";
import type { Registry } from "./registry.ts";
import { formatPush, writeReceipt } from "./util.ts";

const LIVE_MS = 15 * 60_000;
const MAX_CHILDREN = 2000;
const MAX_PER_HOOK = 4;
const IN_FLIGHT_MS = 3000;
const EVENTS = new Set([
	"SubagentStart",
	"PreToolUse",
	"PostToolUse",
	"SubagentStop",
]);
const VIA = "claude-subagent-hook";

const MINT_MS = 30_000;
const PULSAR_TOOLS = {
	send: ["send", "wait", "whoami"],
	respond: ["reply", "msg.ack", "msg.done", "msg.nack"],
	inbox: ["inbox", "history"],
	wait: ["wait", "whoami"],
	list_agents: ["list", "lookup", "whoami"],
	set_identity: ["set_identity", "whoami"],
	who: ["lookup"],
	whoami: ["whoami"],
	history: ["history"],
	ask: ["send", "wait", "whoami"],
	reply: ["reply"],
	ack: ["msg.ack"],
	done: ["msg.done"],
	nack: ["msg.nack"],
} satisfies Record<string, string[]>;

interface SourceProof {
	parentId: string;
	key: string;
	pid: number;
	tool: string;
	operations: readonly string[];
	until: number;
}

interface BoundSource {
	proof: SourceProof;
	child: Agent;
	wrote: boolean;
}

interface Proof {
	pid: number;
	until: number;
}
interface Claim {
	caller: Caller;
	agent: Agent;
	messageIds: string[];
	until: number;
}

export class ClaudeChildHooks {
	private readonly active = new Map<string, Proof>();
	private readonly claims = new Map<string, Claim>();
	private readonly sourceProofs = new Map<string, SourceProof>();
	private readonly sourceCalls = new Map<string, number>();
	private readonly bound = new WeakMap<Caller, BoundSource>();
	private readonly byCaller = new Map<Caller, Claim>();
	readonly registry: Registry;
	readonly store: Store;
	readonly agentFor: (id: string) => Agent | undefined;
	readonly refresh: (id: string) => Promise<void>;

	constructor(deps: {
		registry: Registry;
		store: Store;
		agentFor: (id: string) => Agent | undefined;
		refresh: (id: string) => Promise<void>;
	}) {
		this.registry = deps.registry;
		this.store = deps.store;
		this.agentFor = deps.agentFor;
		this.refresh = deps.refresh;
	}

	applyIdentity(child: Agent): Agent {
		const identity = this.store.loadIdentity(child.id);
		if (!identity) return child;
		return {
			...child,
			name: identity.name ?? child.name,
			activity: identity.activity,
			tags: [...new Set([...child.tags, ...identity.tags])],
			inbound: identity.inbound ?? child.inbound,
			meta: identity.name ? { ...child.meta, nameFrom: "self" } : child.meta,
		};
	}

	isActive(parent: Agent, key: string): boolean {
		const proof = this.active.get(parent.id + SUB_MARK + key);
		return !!proof && proof.pid === parent.pid && proof.until > Date.now();
	}

	async collect(caller: Caller, input: Record<string, unknown>) {
		const { key, event, sessionId, pid } = input;
		const parentId = agentIdOf(caller.principal);
		const parent = parentId ? this.registry.get(parentId) : undefined;
		if (
			parent?.harness !== "claude" ||
			parent.status === "gone" ||
			parent.sessionId !== sessionId ||
			typeof pid !== "number" ||
			parent.pid !== pid ||
			!pidAlive(pid) ||
			typeof key !== "string" ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(key) ||
			typeof event !== "string" ||
			!EVENTS.has(event)
		)
			throw new RpcError(
				"forbidden",
				"hook has no matching Claude parent session",
			);
		const record = await readClaudeSession(pid);
		if (
			record?.pid !== pid ||
			record.sessionId !== sessionId ||
			caller.closed.aborted
		)
			throw new RpcError(
				"forbidden",
				"hook's Claude parent session record changed",
			);
		const id = parent.id + SUB_MARK + key;
		const known = this.isActive(parent, key);
		if (event === "SubagentStop") {
			if (this.active.delete(id)) void this.refresh(parent.id);
			return { context: "" };
		}
		if (!known && this.active.size >= MAX_CHILDREN)
			this.active.delete(this.active.keys().next().value!);
		this.active.set(id, { pid, until: Date.now() + LIVE_MS });
		// SubagentStart can precede the log. The next discovery sweep probes it.
		if (!known) void this.refresh(parent.id);
		const agent = this.agentFor(id);
		if (!agent || agent.status === "gone") return { context: "" };
		const sourceProof =
			event === "PreToolUse" ? this.mint(parent, key, input) : undefined;
		const empty = { context: "", sourceProof };
		const before = this.claims.get(id);
		if (before) {
			if (before.until > Date.now()) return empty;
			this.release(before);
		}
		const messages = this.store.unread(id, MAX_PER_HOOK);
		if (!messages.length || this.byCaller.has(caller)) return empty;
		const claim = {
			caller,
			agent,
			messageIds: messages.map((message) => message.id),
			until: Date.now() + IN_FLIGHT_MS,
		};
		this.claims.set(id, claim);
		this.byCaller.set(caller, claim);
		caller.closed.addEventListener("abort", () => this.release(claim), {
			once: true,
		});
		return {
			sourceProof,
			context: messages
				.map((message) => {
					const sender = this.registry.from(message.fromId, message.fromName);
					const framing = sender
						? this.registry.messageFraming(message.id, sender)
						: null;
					return formatPush(
						message,
						sender
							? { ...sender, name: message.fromName }
							: {
									name: message.fromName,
									harness: "unknown",
									project: null,
									machine: "",
								},
						framing === "verified" && sender
							? { kind: "human", name: this.registry.operatorNameOf(sender) }
							: framing === "unverified"
								? { kind: "unverified" }
								: { kind: "agent" },
					);
				})
				.join("\n\n"),
		};
	}

	private mint(
		parent: Agent,
		key: string,
		input: Record<string, unknown>,
	): string | undefined {
		const { toolName, callId } = input;
		const tool =
			typeof toolName === "string"
				? /^mcp__pulsar__([a-z_]+)$/.exec(toolName)?.[1]
				: undefined;
		if (
			!tool ||
			!Object.hasOwn(PULSAR_TOOLS, tool) ||
			typeof callId !== "string" ||
			!/^[A-Za-z0-9_-]{1,160}$/.test(callId) ||
			!parent.pid
		)
			return;
		const operations = PULSAR_TOOLS[tool as keyof typeof PULSAR_TOOLS];
		const call = `${parent.id}:${callId}`;
		const now = Date.now();
		for (const [token, proof] of this.sourceProofs)
			if (proof.until <= now) this.sourceProofs.delete(token);
		for (const [name, expiry] of this.sourceCalls)
			if (expiry <= now) this.sourceCalls.delete(name);
		if (this.sourceCalls.has(call) || this.sourceCalls.size >= MAX_CHILDREN)
			return;
		const proof = lazyCrypto().randomBytes(32).toString("hex");
		this.sourceCalls.set(call, now + MINT_MS);
		this.sourceProofs.set(proof, {
			parentId: parent.id,
			key,
			pid: parent.pid,
			tool,
			operations,
			until: now + MINT_MS,
		});
		return proof;
	}

	async bind(caller: Caller, raw: unknown, tool: unknown) {
		const proof =
			typeof raw === "string" ? this.sourceProofs.get(raw) : undefined;
		if (
			!proof ||
			proof.until <= Date.now() ||
			proof.tool !== tool ||
			proof.parentId !== agentIdOf(caller.principal) ||
			this.bound.has(caller)
		)
			throw new RpcError("forbidden", "no valid Claude subagent proof");
		// Consume before any asynchronous validation.
		this.sourceProofs.delete(raw as string);
		const parent = this.registry.get(proof.parentId);
		const recordChild = this.agentFor(proof.parentId + SUB_MARK + proof.key);
		const record = await readClaudeSession(proof.pid);
		if (
			!parent ||
			parent.pid !== proof.pid ||
			record?.pid !== proof.pid ||
			record.sessionId !== parent.sessionId ||
			!this.isActive(parent, proof.key) ||
			!recordChild ||
			recordChild.status === "gone" ||
			caller.closed.aborted
		)
			throw new RpcError("forbidden", "Claude subagent is no longer live");
		const child = this.applyIdentity({
			...recordChild,
			reach: "pull",
			meta: { ...recordChild.meta, subagentPull: "1" },
		});
		caller.principal = { kind: "agent", agentId: child.id };
		this.bound.set(caller, { proof, child, wrote: false });
		return child;
	}

	source(caller: Caller, method: string): Agent | undefined {
		const bound = this.bound.get(caller);
		if (!bound) return;
		const parent = this.registry.get(bound.proof.parentId);
		if (
			agentIdOf(caller.principal) !== bound.child.id ||
			!parent ||
			parent.pid !== bound.proof.pid ||
			!this.isActive(parent, bound.proof.key) ||
			!bound.proof.operations.includes(method)
		)
			throw new RpcError(
				"forbidden",
				"operation is outside this Claude subagent tool proof",
			);
		if (
			[
				"send",
				"reply",
				"msg.ack",
				"msg.done",
				"msg.nack",
				"set_identity",
			].includes(method)
		) {
			if (bound.wrote)
				throw new RpcError(
					"forbidden",
					"this Claude subagent tool already sent its update",
				);
			bound.wrote = true;
		}
		return bound.child;
	}

	/** The command flushed its context to Claude. The model has not confirmed reading it. */
	confirm(caller: Caller) {
		const claim = this.byCaller.get(caller);
		if (!claim || claim.until <= Date.now()) return { accepted: false };
		for (const id of claim.messageIds)
			if (this.store.receipt(id, claim.agent.id)?.state === "queued")
				writeReceipt(
					this.store,
					id,
					claim.agent,
					"delivered",
					VIA,
					"Handed to Claude's subagent hook",
				);
		this.release(claim);
		return { accepted: true };
	}

	private release(claim: Claim) {
		if (this.claims.get(claim.agent.id) === claim)
			this.claims.delete(claim.agent.id);
		if (this.byCaller.get(claim.caller) === claim)
			this.byCaller.delete(claim.caller);
	}
}
