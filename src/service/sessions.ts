import { agentIdOf, type Caller, type Role } from "./caller.ts";

/** Replaced extension connections one agent keeps open (see `retire`). */
export const MAX_RETIRED = 4;

/**
 * Callers attached to the service, with the role each one said hello as.
 * An agent's live sessions are the callers whose principal is that agent;
 * they are indexed by agent id (`bind` after a principal changes), so
 * lookups stay cheap however many connections are open.
 */
export class Sessions {
	private roles = new Map<Caller, Role | null>();
	private byAgent = new Map<string, Set<Caller>>();
	private agentOf = new Map<Caller, string>();
	/** Old extension connections a same-process reconnect replaced, oldest first. */
	private retired = new Map<string, Caller[]>();

	add(caller: Caller) {
		this.roles.set(caller, null);
		this.bind(caller);
	}

	remove(caller: Caller) {
		this.roles.delete(caller);
		const id = this.agentOf.get(caller);
		this.unindex(caller);
		if (id !== undefined) {
			const list = this.retired.get(id)?.filter((c) => c !== caller);
			if (list?.length) this.retired.set(id, list);
			else this.retired.delete(id);
		}
	}

	has(caller: Caller) {
		return this.roles.has(caller);
	}

	role(caller: Caller): Role | null {
		return this.roles.get(caller) ?? null;
	}

	setRole(caller: Caller, role: Role) {
		if (this.roles.has(caller)) this.roles.set(caller, role);
	}

	/** Re-files a caller under its current principal's agent (after hello). */
	bind(caller: Caller) {
		if (!this.roles.has(caller)) return;
		this.unindex(caller);
		const id = agentIdOf(caller.principal);
		if (!id) return;
		this.agentOf.set(caller, id);
		let set = this.byAgent.get(id);
		if (!set) {
			set = new Set();
			this.byAgent.set(id, set);
		}
		set.add(caller);
	}

	private unindex(caller: Caller) {
		const old = this.agentOf.get(caller);
		if (old === undefined) return;
		this.agentOf.delete(caller);
		const set = this.byAgent.get(old);
		set?.delete(caller);
		if (set?.size === 0) this.byAgent.delete(old);
	}

	/** Every caller speaking as this agent (MCP, extension, borrowing CLI). */
	forAgent(agentId: string): Caller[] {
		return [...(this.byAgent.get(agentId) ?? [])];
	}

	/** The agent's extension connection, which can push into its session. */
	extensionFor(agentId: string): Caller | undefined {
		for (const c of this.byAgent.get(agentId) ?? [])
			if (this.roles.get(c) === "extension") return c;
		return undefined;
	}

	wakeFor(agentId: string): Caller | undefined {
		return this.forAgent(agentId).find((c) => this.role(c) === "wake");
	}

	/**
	 * An agent's old extension connection, replaced by a newer one from the
	 * same process: it stays open (a 1.x client may still read from it) as an
	 * mcp connection, but an agent keeps at most MAX_RETIRED of them. Returns
	 * the ones past that, oldest first, for the caller to close.
	 */
	retire(agentId: string, caller: Caller): Caller[] {
		this.setRole(caller, "mcp");
		const list = [...(this.retired.get(agentId) ?? []), caller];
		const over = list.splice(0, Math.max(0, list.length - MAX_RETIRED));
		this.retired.set(agentId, list);
		return over;
	}

	get size() {
		return this.roles.size;
	}
}
