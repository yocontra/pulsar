import { readHosted } from "./providers.ts";
import {
	HOSTED_PROVIDERS,
	type HostedMachine,
	type HostedObservation,
	type HostedReport,
} from "./wire.ts";

const CACHE_MS = 30_000;
const STALE_MS = 24 * 60 * 60_000;

export class HostedCatalog {
	private readonly last = new Map<string, HostedObservation>();
	private latest: Promise<HostedObservation[]> | undefined;
	private completedAt = 0;

	private readonly read: typeof readHosted;

	constructor(read = readHosted) {
		this.read = read;
	}

	observe(): Promise<HostedObservation[]> {
		if (this.latest && Date.now() - this.completedAt < CACHE_MS)
			return this.latest;
		this.completedAt = Infinity;
		this.latest = Promise.all(
			HOSTED_PROVIDERS.map(async (provider): Promise<HostedObservation> => {
				const previous = this.last.get(provider);
				const result = await this.read(provider).catch(() => ({
					state: "unavailable" as const,
					detail: "read-failed" as const,
				}));
				const now = Date.now();
				if (result.state === "ready") {
					const report = {
						...result,
						provider,
						observedAt: now,
						detail: null,
					} as const;
					this.last.set(provider, report);
					return report;
				}
				if (
					result.detail === "read-failed" &&
					previous?.observedAt &&
					now - previous.observedAt < STALE_MS
				)
					return { ...previous, state: "stale", detail: result.detail };
				this.last.delete(provider);
				return { ...result, provider, tasks: [], observedAt: null };
			}),
		).finally(() => {
			this.completedAt = Date.now();
		});
		return this.latest;
	}
}

type Row = HostedReport["tasks"][number];

export function hostedReport(machines: HostedMachine[]): HostedReport {
	const tasks = new Map<string, { row: Row; rank: number }>();
	const providers: HostedReport["providers"] = [];
	for (const machine of machines) {
		for (const { tasks: listed, ...observation } of machine.providers) {
			const { provider } = observation;
			providers.push({ ...observation, machineId: machine.machineId });
			const state =
				machine.state === "reachable" && observation.state === "stale"
					? "stale"
					: machine.state;
			const rank = state === "reachable" ? 2 : state === "stale" ? 1 : 0;
			for (const task of listed) {
				const key = `${provider}:${task.id}`;
				const existing = tasks.get(key);
				const sources = existing?.row.sources ?? [];
				if (!sources.some((s) => s.machineId === machine.machineId))
					sources.push({ machineId: machine.machineId, state });
				if (
					!existing ||
					rank > existing.rank ||
					(rank === existing.rank &&
						(task.updatedAt ?? 0) > (existing.row.updatedAt ?? 0))
				)
					tasks.set(key, { row: { ...task, provider, sources }, rank });
			}
		}
	}
	return {
		machines: machines.map(({ providers: _, ...machine }) => machine),
		providers,
		tasks: Array.from(tasks.values(), ({ row }) => row).sort(
			(a, b) =>
				(b.updatedAt ?? 0) - (a.updatedAt ?? 0) ||
				a.provider.localeCompare(b.provider) ||
				a.id.localeCompare(b.id),
		),
	};
}
