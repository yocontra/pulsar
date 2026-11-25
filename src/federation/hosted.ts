import { type HostedMachine, hostedObservations } from "../hosted/wire.ts";
import type { Principal } from "../service/caller.ts";
import type { Federation } from "./index.ts";

const STALE_MS = 24 * 60 * 60_000;

export class RemoteHosted {
	private owner: string | null = null;
	private last = new Map<string, HostedMachine["providers"]>();

	private readonly fed: Pick<Federation, "machines" | "act">;

	constructor(fed: RemoteHosted["fed"]) {
		this.fed = fed;
	}

	async observe(as: Principal): Promise<HostedMachine[]> {
		const owner = as.kind === "human" ? as.login.toLowerCase() : null;
		if (owner !== this.owner) {
			this.owner = owner;
			this.last = new Map();
		}
		// Use this caller's cache even if another owner reads during federation.
		const last = this.last;
		const machines = this.fed.machines();
		const ids = new Set(machines.map((m) => m.machineId));
		for (const id of last.keys()) if (!ids.has(id)) last.delete(id);

		return Promise.all(
			machines.map(async (machine): Promise<HostedMachine> => {
				const { machineId, name } = machine;
				const previous = () => {
					const cutoff = Date.now() - STALE_MS;
					const kept =
						last
							.get(machineId)
							?.filter((o) => o.observedAt !== null && o.observedAt > cutoff) ??
						[];
					if (!kept.length) last.delete(machineId);
					return kept;
				};
				if (machine.link !== "tailnet")
					return { machineId, name, state: "offline", providers: previous() };
				try {
					const result = await this.fed.act(
						`${machineId}/`,
						{ op: "hosted.list" },
						as,
						12_000,
					);
					const providers = hostedObservations.parse(result.providers);
					last.set(machineId, providers);
					return { machineId, name, state: "reachable", providers };
				} catch {
					return {
						machineId,
						name,
						state: "unavailable",
						providers: previous(),
					};
				}
			}),
		);
	}
}
