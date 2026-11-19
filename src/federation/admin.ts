import { RpcError } from "../rpc.ts";
import type { Caller, Principal } from "../service/caller.ts";
import { principalLabel } from "../service/caller.ts";
import type { EventBus } from "../service/events.ts";
import {
	type Confirmed,
	type Presence,
	spendConfirmed,
} from "../service/presence.ts";
import type { Store } from "../store.ts";
import type { PoolMembers } from "./members.ts";
import type { TailnetStatus } from "./tailnet.ts";

export type PoolVerb = "allow" | "deny" | "forget" | "owner";

interface Change {
	describe: string;
	apply: () => void;
}

/**
 * `pulsar mesh allow|deny|forget|owner`, in the daemon. A change is resolved
 * first (a node name to its stable id, from `tailscale status`), then
 * confirmed by the person (src/service/presence.ts: Touch ID or the app's
 * passkey, run by this daemon), then applied, all in one call. Anyone on this
 * machine may ask, agents included; nothing they send can confirm it. Every
 * change is audited and announced to open app tabs.
 */
export class PoolAdmin {
	private readonly d: {
		members: PoolMembers;
		store: Store;
		events: EventBus;
		presence: Presence;
		machine: () => string;
		status: () => Promise<TailnetStatus | null>;
		/** A peer binding was forgotten (federation drops the peer). */
		onForget: (machineId: string) => void;
		/** After a change is applied (federation re-checks its open streams). */
		onChange?: () => void;
		now?: () => number;
	};

	constructor(d: PoolAdmin["d"]) {
		this.d = d;
	}

	private now() {
		return (this.d.now ?? Date.now)();
	}

	private local(p: Principal) {
		if (p.kind !== "terminal" && p.kind !== "agent")
			throw new RpcError(
				"forbidden",
				"the pool is changed on the machine itself (`pulsar mesh`)",
			);
	}

	list(p: Principal) {
		this.local(p);
		return {
			owner: this.d.members.owner,
			entries: this.d.members.entries(),
			peers: this.d.store.peers().map((x) => ({
				machineId: x.machineId,
				name: x.name,
				node: x.node,
			})),
		};
	}

	/** Resolves the change, has the person confirm it, applies it. */
	async change(caller: Caller, verb: PoolVerb, target: string, pid?: number) {
		const p = caller.principal;
		this.local(p);
		if (!["allow", "deny", "forget", "owner"].includes(verb))
			throw new RpcError("bad_request", "verb: allow, deny, forget or owner");
		const t = target.trim();
		if (!t)
			throw new RpcError("bad_request", `usage: pulsar mesh ${verb} <node>`);
		const change = await this.resolve(verb, t);
		const op = `pool.${verb}`;
		let proof: Confirmed;
		try {
			proof = await this.d.presence.confirm(caller, {
				op,
				text: `${change.describe} (pulsar mesh)`,
				target: t,
				command: `pulsar mesh ${verb}`,
				...(pid ? { pid } : {}),
			});
		} catch (e) {
			this.audit(p, op, t, { error: (e as Error).message }, false);
			throw e;
		}
		if (!spendConfirmed(proof, op))
			throw new RpcError(
				"denied",
				"the confirmation doesn't match this change",
			);
		change.apply();
		this.d.onChange?.();
		this.audit(p, "pool.change", t, {
			change: change.describe,
			method: proof.method,
		});
		this.d.events.emit("security", {
			kind: "pool-changed",
			message: `Pool changed on ${this.d.machine()}: ${change.describe}`,
			node: this.d.machine(),
			at: this.now(),
		});
		return { ok: true as const, change: change.describe, method: proof.method };
	}

	private async resolve(verb: PoolVerb, t: string): Promise<Change> {
		const { members, store } = this.d;
		if (verb === "owner") {
			if (!/^[^\s@]+@[^\s@]+$/.test(t))
				throw new RpcError(
					"bad_request",
					"usage: pulsar mesh owner <login>, e.g. me@example.com",
				);
			return {
				describe: `make ${t} the pool owner on this tagged node`,
				apply: () => members.setOwner(t),
			};
		}
		const key = t.toLowerCase().replace(/\.$/, "");
		if (verb === "forget") {
			const entry = members
				.entries()
				.find(
					(e) => e.nodeId === t || e.name.toLowerCase() === key.split(".")[0],
				);
			const peer = store
				.peers()
				.find(
					(x) =>
						x.machineId === t ||
						x.node === t ||
						x.name.toLowerCase() === key.split(".")[0] ||
						x.dnsName?.toLowerCase() === key,
				);
			if (!entry && !peer)
				throw new RpcError(
					"not_found",
					`nothing in the pool settings matches ${t}`,
				);
			return {
				describe: `forget ${entry?.name ?? peer?.name}${peer ? " and its machine id" : ""}`,
				apply: () => {
					if (entry) members.remove(entry.nodeId);
					if (peer) {
						store.removePeer(peer.machineId);
						this.d.onForget(peer.machineId);
					}
				},
			};
		}
		const st = await this.d.status();
		if (!st) throw new RpcError("unavailable", "Tailscale is not running");
		const node = st.peers.find(
			(n) =>
				n.nodeId === t ||
				n.name.toLowerCase() === key ||
				n.dnsName.toLowerCase() === key,
		);
		if (!node) throw new RpcError("not_found", `no tailnet node named ${t}`);
		const who = node.tags.length
			? `tagged ${node.tags.join(",")}`
			: (node.login ?? "?");
		return {
			describe: `${verb} ${node.name} (${who}, node ${node.nodeId})`,
			apply: () =>
				members.set({
					nodeId: node.nodeId,
					name: node.name,
					login: node.login,
					verdict: verb === "deny" ? "deny" : "allow",
					at: this.now(),
				}),
		};
	}

	private audit(
		p: Principal,
		op: string,
		target: string | null,
		detail: unknown,
		ok = true,
	) {
		this.d.store.audit({
			at: this.now(),
			principal: principalLabel(p),
			op,
			target,
			detail: JSON.stringify(detail),
			ok,
		});
	}
}
