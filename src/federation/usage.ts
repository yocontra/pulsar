import type { UsagePeriod } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Principal } from "../service/caller.ts";
import {
	cleanAgentUsage,
	cleanLocalUsage,
	type LocalAgentUsage,
	type PoolUsage,
} from "../usage/index.ts";
import type { Federation } from "./index.ts";

/** A peer reads its own database; this is plenty, even mid-scan. */
const USAGE_TIMEOUT_MS = 5000;

/**
 * Token usage of other machines: each peer sums its own session files
 * (`act: usage.rows`, as the original user) and this node prices them.
 * A machine that is offline, slow or too old is reported with why.
 */
export class RemoteUsage implements PoolUsage {
	private readonly fed: Federation;

	constructor(fed: Federation) {
		this.fed = fed;
	}

	usage(period: UsagePeriod, tzMinutes: number, as?: Principal) {
		return Promise.all(
			this.fed.machines().map(async (m) => {
				const base = { machineId: m.machineId, name: m.name };
				if (m.link !== "tailnet")
					return {
						...base,
						usage: null,
						error: m.reason ?? `${m.name} is offline`,
					};
				try {
					const r = await this.fed.act(
						`${m.machineId}/`,
						{ op: "usage.rows", period, tz: tzMinutes },
						as,
						USAGE_TIMEOUT_MS,
					);
					const usage = cleanLocalUsage(r.usage);
					if (!usage) throw new Error("sent no usage");
					return { ...base, usage, error: null };
				} catch (e) {
					const msg = (e as Error).message;
					return {
						...base,
						usage: null,
						// An older node refuses the op it does not know.
						error:
							e instanceof RpcError && e.code === "unsupported"
								? `upgrade pulsar on ${m.name}`
								: msg,
					};
				}
			}),
		);
	}

	async agentUsage(address: string, as?: Principal): Promise<LocalAgentUsage> {
		const slash = address.indexOf("/");
		const r = await this.fed.act(
			address,
			{ op: "usage.agent", agent: address.slice(slash + 1) },
			as,
			USAGE_TIMEOUT_MS,
		);
		return cleanAgentUsage(r.usage);
	}
}
