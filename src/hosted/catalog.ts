import { readHosted } from "./providers.ts";
import {
	HOSTED_PROVIDERS,
	type HostedMachine,
	type HostedObservation,
	type HostedProvider,
	type HostedReport,
} from "./wire.ts";

const CACHE_MS = 30_000;
const STALE_MS = 24 * 60 * 60_000;

export class HostedCatalog {
	private readonly last = new Map<string, HostedObservation>();
	private readonly cache = new Map<
		HostedProvider,
		{ expires: number; result: Promise<HostedObservation> }
	>();
	private readonly read: typeof readHosted;
	constructor(read = readHosted) {
		this.read = read;
	}

	invalidate(provider: HostedProvider) {
		this.cache.delete(provider);
	}

	observe(fresh = false): Promise<HostedObservation[]> {
		return Promise.all(
			HOSTED_PROVIDERS.map((provider) => this.observeProvider(provider, fresh)),
		);
	}

	private observeProvider(
		provider: HostedProvider,
		fresh: boolean,
	): Promise<HostedObservation> {
		const cached = this.cache.get(provider);
		if (
			cached &&
			(cached.expires === Infinity || (!fresh && cached.expires > Date.now()))
		)
			return cached.result;
		const result = this.read(provider)
			.catch(() => ({
				state: "unavailable" as const,
				detail: "read-failed" as const,
			}))
			.then((read): HostedObservation => {
				const now = Date.now();
				// A write can invalidate this request while its provider is replying.
				const current = this.cache.get(provider)?.result === result;
				if (current)
					this.cache.set(provider, { expires: now + CACHE_MS, result });
				if (read.state === "ready") {
					const report = { ...read, provider, observedAt: now, detail: null };
					if (current) this.last.set(provider, report);
					return report;
				}
				const previous = this.last.get(provider);
				if (
					read.detail === "read-failed" &&
					previous?.observedAt &&
					now - previous.observedAt < STALE_MS
				)
					return { ...previous, state: "stale", detail: read.detail };
				if (current) this.last.delete(provider);
				return { ...read, provider, tasks: [], observedAt: null };
			});
		this.cache.set(provider, { expires: Infinity, result });
		return result;
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
