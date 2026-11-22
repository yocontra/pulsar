import { canonicalJson, sha256hex } from "../canonical.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import { type ActingOp, authorize, isActingOp } from "./authorize.ts";
import { type Principal, principalLabel } from "./caller.ts";
import type { Passkeys, RelyingParty } from "./passkeys.ts";
import type { Registry } from "./registry.ts";

/**
 * Acting ops: the operator changes something on an agent's machine
 * (attachments, launching an agent, git commit/push/PR). One rule for all:
 *
 * - Only the human operator, from the app (`authorize`).
 * - Here, on this node: a passkey session (Prove Human) on this node.
 * - On another machine: that machine (the home node) issues a challenge
 *   bound to the op, its target and a digest of its parameters; the browser
 *   signs it; the home node verifies the assertion itself, then runs the op
 *   as a verified user. A /fed frame never carries user authority: the
 *   relaying node's word, its session, or a `verified` flag count for
 *   nothing at the home node. Same as a relayed Stop.
 * - Every run leaves an audit row on the node that ran it (`<op>`), and a
 *   relayed one also `<op>.relayed` (device and relaying node).
 *
 * A feature registers its handler once (`register`); HTTP routes call
 * `run` (and `options` for the relayed ceremony, `POST /acting/options`);
 * federation calls `optionsFor` / `runFor` on the home node. Feature code
 * never touches the federation protocol.
 */

/** What an acting op runs against: one agent, or a machine itself. */
export const ACTING_SCOPE: Record<ActingOp, "agent" | "machine"> = {
	"attachments.upload": "agent",
	"agents.launch": "machine",
	"git.commit": "agent",
	"git.push": "agent",
	"git.pr": "agent",
	"git.comment": "agent",
	"git.reply": "agent",
	"git.resolve": "agent",
	"git.review": "agent",
	"queue.withdraw": "agent",
	"queue.promote": "agent",
};

/** The operator, verified: a passkey session here, or an assertion the home node checked. */
export type VerifiedUser = Extract<Principal, { kind: "human" }> & {
	verified: true;
};

/**
 * Runs one acting op on this node. `agent` is a local agent id (scope
 * `agent`, it exists) or null (scope `machine`). Throw an RpcError to fail.
 */
export type ActingHandler = (ctx: {
	user: VerifiedUser;
	agent: string | null;
	params: unknown;
}) => Promise<unknown>;

/** Where to act: an agent id or pool address, or a machine (id or name; empty: this one). */
export interface ActTarget {
	agent?: string | null;
	machine?: string | null;
}

/** How a relayed act travels to the home node (federation, `PoolView`). */
export interface RelayedAct {
	op: ActingOp;
	/** The home node's local agent id; null for a machine op. */
	agent: string | null;
	params: unknown;
}

/** The federation side the service needs to relay an act. */
export interface ActingRelay {
	actingOptions(
		machineId: string,
		act: RelayedAct,
		as: Principal,
	): Promise<unknown>;
	acting(
		machineId: string,
		act: RelayedAct & { assertion: unknown },
		as: Principal,
	): Promise<unknown>;
	/** A machine of the pool by id or name, if known. */
	machineIdOf(machine: string): string | null;
}

/** The digest of an act's parameters that its challenge covers. */
export function actDigest(params: unknown): string {
	return sha256hex(canonicalJson(params ?? null));
}

/** The target a challenge names: the agent's local id, or `machine:`. */
const bindTarget = (agent: string | null) => agent ?? "machine:";

interface ActingOptions {
	registry: Registry;
	store: Store;
	passkeys: Passkeys;
	machineId: () => string;
	machine: () => string;
	/** Federation; null on a node with no pool links. */
	relay: () => ActingRelay | null;
}

type Resolved =
	| { remote: false; agent: string | null }
	| { remote: true; machineId: string; agent: string | null };

export class Acting {
	private handlers = new Map<ActingOp, ActingHandler>();
	private o: ActingOptions;
	/**
	 * An op the operator ran from this node's app succeeded: its target (as
	 * the app named it), or the agent a launch reports (`agentId`), else null.
	 * Finish/fail notifications follow these agents (src/service/interest.ts).
	 */
	onActed: (agentId: string | null) => void = () => {};

	constructor(o: ActingOptions) {
		this.o = o;
	}

	/** Registers the handler for an op on this node; returns the unregister. */
	register(op: ActingOp, handler: ActingHandler): () => void {
		if (this.handlers.has(op))
			throw new Error(`acting op ${op} already has a handler`);
		this.handlers.set(op, handler);
		return () => {
			if (this.handlers.get(op) === handler) this.handlers.delete(op);
		};
	}

	/** Drops an op's handler (tests stand a dummy in for a feature's). */
	unregister(op: ActingOp) {
		this.handlers.delete(op);
	}

	/**
	 * Runs an op for the app: here with the passkey session, or on the home
	 * node with `assertion` (signed over that node's `options`).
	 */
	async run(
		principal: Principal,
		op: ActingOp,
		target: ActTarget,
		params: unknown,
		assertion?: unknown,
	): Promise<unknown> {
		const result = await this.runOnce(principal, op, target, params, assertion);
		const launched = (result as { agentId?: unknown } | null)?.agentId;
		this.onActed(
			target.agent ?? (typeof launched === "string" ? launched : null),
		);
		return result;
	}

	private async runOnce(
		principal: Principal,
		op: ActingOp,
		target: ActTarget,
		params: unknown,
		assertion?: unknown,
	): Promise<unknown> {
		const where = this.resolve(principal, op, target);
		if (!where.remote) return this.runHere(principal, op, where.agent, params);
		if (assertion === undefined)
			throw new RpcError(
				"session_required",
				"this action on another machine needs Face ID / Touch ID for that action",
			);
		return this.relay().acting(
			where.machineId,
			{ op, agent: where.agent, params, assertion },
			principal,
		);
	}

	/** Request options from the home node for an op on another machine. */
	async options(
		principal: Principal,
		op: ActingOp,
		target: ActTarget,
		params: unknown,
	): Promise<unknown> {
		authorize(principal, "acting.options");
		const where = this.resolve(principal, op, target);
		if (!where.remote)
			throw new RpcError(
				"bad_request",
				"an action on this machine uses your passkey session; no options needed",
			);
		return this.relay().actingOptions(
			where.machineId,
			{ op, agent: where.agent, params },
			principal,
		);
	}

	/** Home node: a challenge for one relayed act (federation receiver). */
	async optionsFor(
		user: Principal,
		rp: RelyingParty,
		act: RelayedAct,
		requester: string,
	): Promise<unknown> {
		const login = this.homeCheck(user, act);
		return this.o.passkeys.actOptions(
			login,
			rp,
			{
				op: act.op,
				target: bindTarget(act.agent),
				digest: actDigest(act.params),
			},
			requester,
		);
	}

	/**
	 * Home node: verifies the browser's assertion for exactly this act with
	 * this node's own challenge and credentials, then runs it as a verified
	 * user (federation receiver). `via`: the relaying node, for the audit.
	 */
	async runFor(
		user: Principal,
		rp: RelyingParty,
		act: RelayedAct & { assertion: unknown },
		via: string,
	): Promise<unknown> {
		const login = this.homeCheck(user, act);
		const signer = await this.o.passkeys.verifyAct(
			login,
			rp,
			{
				op: act.op,
				target: bindTarget(act.agent),
				digest: actDigest(act.params),
			},
			act.assertion,
		);
		const verified = { ...(user as VerifiedUser), verified: true as const };
		this.o.store.audit({
			at: Date.now(),
			principal: principalLabel(verified),
			op: `${act.op}.relayed`,
			target: bindTarget(act.agent),
			detail: JSON.stringify({ device: signer.device, via }),
			ok: true,
		});
		return this.runHere(verified, act.op, act.agent, act.params);
	}

	/** Authorizes (session required), runs the local handler, audits. */
	private async runHere(
		principal: Principal,
		op: ActingOp,
		agent: string | null,
		params: unknown,
	): Promise<unknown> {
		authorize(principal, op, agent ?? undefined);
		const handler = this.handlers.get(op);
		const audit = (ok: boolean, detail: string | null) =>
			this.o.store.audit({
				at: Date.now(),
				principal: principalLabel(principal),
				op,
				target: bindTarget(agent),
				detail,
				ok,
			});
		try {
			if (!handler)
				throw new RpcError(
					"unsupported",
					`${op} is not available on ${this.o.machine()}`,
				);
			const result = await handler({
				user: principal as VerifiedUser,
				agent,
				params,
			});
			audit(true, null);
			return result;
		} catch (e) {
			audit(false, JSON.stringify({ error: (e as Error).message }));
			throw e;
		}
	}

	/** The home node's own checks of a relayed act, before any passkey work. */
	private homeCheck(user: Principal, act: RelayedAct): string {
		if (user.kind !== "human")
			throw new RpcError(
				"forbidden",
				"only the human operator acts on agents of other machines",
			);
		if (!isActingOp(act.op))
			throw new RpcError("bad_request", "unknown acting op");
		if (!this.handlers.has(act.op))
			throw new RpcError(
				"unsupported",
				`${act.op} is not available on ${this.o.machine()}`,
			);
		const scope = ACTING_SCOPE[act.op];
		if (scope === "machine" ? act.agent !== null : !act.agent)
			throw new RpcError("bad_request", `${act.op}: wrong target`);
		// Only this node's own agents: never relayed on to a third node.
		if (act.agent !== null && !this.o.registry.get(act.agent))
			throw new RpcError("not_found", `no agent ${act.agent}`);
		return user.login;
	}

	private resolve(
		principal: Principal,
		op: ActingOp,
		target: ActTarget,
	): Resolved {
		if (!isActingOp(op)) throw new RpcError("bad_request", "unknown acting op");
		// Agents and the terminal never act through here (before any lookup).
		if (principal.kind !== "human") authorize(principal, op);
		if (ACTING_SCOPE[op] === "machine") {
			const m = target.machine ?? "";
			if (!m || m === this.o.machineId() || m === this.o.machine())
				return { remote: false, agent: null };
			const id = this.o.relay()?.machineIdOf(m) ?? null;
			if (!id) throw new RpcError("not_found", `no machine ${m}`);
			return { remote: true, machineId: id, agent: null };
		}
		const id = target.agent ?? "";
		if (!id) throw new RpcError("bad_request", `${op}: agent required`);
		const local = this.o.registry.get(id);
		if (local) return { remote: false, agent: local.id };
		const remote = id.includes("/") ? this.o.registry.find(id) : undefined;
		if (remote?.id.includes("/") && this.o.relay()) {
			const slash = remote.id.indexOf("/");
			return {
				remote: true,
				machineId: remote.id.slice(0, slash),
				agent: remote.id.slice(slash + 1),
			};
		}
		throw new RpcError("not_found", `no agent ${id}`);
	}

	private relay(): ActingRelay {
		const r = this.o.relay();
		if (!r) throw new RpcError("unreachable", "no other machines are linked");
		return r;
	}
}
