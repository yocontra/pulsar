import { antigravityHookConfig } from "../harnesses/antigravity-hook-config.ts";
import { ANTIGRAVITY_SESSION_ID } from "../harnesses/antigravity-ident.ts";
import type { Store } from "../store.ts";
import type { Agent } from "../types.ts";

const STORE_KEY = "antigravity:native-hook";
const MAX_PROOFS = 128;

function identity(agent: Agent, birth = agent.meta.processStart) {
	if (
		agent.harness !== "antigravity" ||
		agent.meta.acp === "1" ||
		agent.meta.subagentOf ||
		agent.status === "gone" ||
		!agent.pid ||
		!agent.sessionId ||
		!ANTIGRAVITY_SESSION_ID.test(agent.sessionId) ||
		!birth
	)
		return null;
	return JSON.stringify([agent.sessionId, agent.pid, birth]);
}

/** A live invocation is the only source of proof. Config can revoke it. */
export class NativeHookProofs {
	private observed = new WeakSet<Agent>();
	private recovered = new Set<string>();
	private configuration?: Awaited<ReturnType<typeof antigravityHookConfig>>;
	private checking?: Promise<void>;
	private readonly store: Store;
	private readonly changed: (apply: () => void) => void;
	private readonly closed: () => boolean;
	private readonly readConfig: typeof antigravityHookConfig;

	constructor(
		store: Store,
		changed: (apply: () => void) => void,
		closed: () => boolean,
		readConfig = antigravityHookConfig,
	) {
		this.store = store;
		this.changed = changed;
		this.closed = closed;
		this.readConfig = readConfig;
	}

	has(agent: Agent) {
		if (this.observed.has(agent)) return true;
		const key = identity(agent);
		return key !== null && this.recovered.has(key);
	}

	transfer(previous: Agent, current: Agent) {
		if (this.observed.has(previous)) this.observed.add(current);
	}

	observe(agent: Agent, birth: string | null, revision: unknown) {
		this.observed.add(agent);
		const key = birth && identity(agent, birth);
		if (
			!key ||
			!this.configuration?.installed ||
			this.configuration.revision !== revision ||
			this.recovered.has(key)
		)
			return;
		this.recovered.add(key);
		if (this.recovered.size > MAX_PROOFS)
			this.recovered.delete(this.recovered.values().next().value!);
		this.store.metaSet(
			STORE_KEY,
			JSON.stringify({
				revision: this.configuration.revision,
				sessions: [...this.recovered],
			}),
		);
	}

	refresh() {
		this.checking ??= this.read().finally(() => {
			this.checking = undefined;
		});
		return this.checking;
	}

	private async read() {
		const config = await this.readConfig(
			undefined,
			undefined,
			this.configuration,
		);
		if (this.closed()) return;
		const previous = this.configuration;
		if (
			previous !== undefined &&
			previous?.revision === config?.revision &&
			previous?.installed === config?.installed
		)
			return;
		const saved = this.store.metaGet(STORE_KEY);
		const recovered = new Set<string>();
		if (previous === undefined && config?.installed && saved) {
			try {
				const { revision, sessions } = JSON.parse(saved);
				if (revision === config.revision && Array.isArray(sessions))
					for (const key of sessions.slice(0, MAX_PROOFS))
						if (typeof key === "string" && key.length <= 200)
							recovered.add(key);
			} catch {
				// An invalid record cannot restore a capability.
			}
		}
		if (!recovered.size && saved) this.store.metaDelete(STORE_KEY);
		this.changed(() => {
			this.configuration = config;
			this.recovered = recovered;
			if (previous !== undefined) this.observed = new WeakSet();
		});
	}
}
