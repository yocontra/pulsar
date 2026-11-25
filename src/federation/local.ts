import { randomBytes } from "node:crypto";
import type { PulsarService } from "../service/index.ts";
import { LIMITS } from "../service/limits.ts";
import type { Digest, FedAgent } from "./protocol.ts";

/** Decided prompts stay in the record this long, so other nodes show the outcome. */
const RECENT_APPROVALS_MS = 120_000;

export interface Delta {
	seq: number;
	upserts: FedAgent[];
	removes: string[];
}

/** The comparison key: presence-only changes (`lastSeen` within a minute) send nothing. */
function key(a: FedAgent): string {
	return JSON.stringify({ ...a, lastSeen: Math.floor(a.lastSeen / 60_000) });
}

/**
 * This node's own agents as peers see them: a snapshot, a numbered delta
 * log, and a digest. `tick` diffs the live registry against what was last
 * published; each non-empty diff is one delta with the next `seq`.
 */
export class LocalFeed {
	readonly bootId = randomBytes(8).toString("hex");
	private seq = 0;
	private current = new Map<string, { agent: FedAgent; key: string }>();
	private log: Delta[] = [];
	private listeners = new Set<(d: Delta) => void>();
	private readonly service: PulsarService;
	private readonly logMax: number;

	constructor(service: PulsarService, logMax = 500) {
		this.service = service;
		this.logMax = logMax;
	}

	/** What one local agent looks like to peers. */
	private record(): FedAgent[] {
		const { registry, store, turns } = this.service;
		const views = this.service.app.views;
		const full = store.fullInboxes(LIMITS.inboxCap);
		return registry.live().map((agent) => {
			const row = views.row(agent, "normal", full);
			return {
				id: agent.id,
				name: agent.name,
				harness: agent.harness,
				project: agent.project,
				branch: agent.branch,
				...(agent.repoUrl ? { repoUrl: agent.repoUrl } : {}),
				machine: agent.machine ?? this.service.machine,
				// `needs:you` is projected from `needsYou` on the other side.
				tags: agent.tags,
				status: agent.status,
				statusSince: registry.statusSince(agent),
				model: agent.model,
				activity: agent.activity,
				inbound: agent.inbound,
				registered: agent.registered,
				reach: agent.reach,
				lastSeen: agent.lastSeen,
				createdAt: agent.createdAt,
				needsYou: row.needsYou,
				wake: row.wake,
				hasTranscript: row.hasTranscript,
				capabilities: row.capabilities,
				canStop: row.canStop,
				...(row.subagents ? { subagents: row.subagents } : {}),
				approvals: this.service.approvals.recentFor(
					agent.id,
					RECENT_APPROVALS_MS,
				) as FedAgent["approvals"],
				...(turns.lastTurn(agent.id) ? { turn: turns.lastTurn(agent.id) } : {}),
			};
		});
	}

	/** Diffs the registry; publishes a delta when anything changed. */
	tick(): Delta | null {
		const next = new Map<string, { agent: FedAgent; key: string }>();
		for (const agent of this.record())
			next.set(agent.id, { agent, key: key(agent) });
		const upserts: FedAgent[] = [];
		const removes: string[] = [];
		for (const [id, n] of next) {
			const prev = this.current.get(id);
			if (!prev || prev.key !== n.key) upserts.push(n.agent);
			else n.agent = prev.agent;
		}
		for (const id of this.current.keys()) if (!next.has(id)) removes.push(id);
		this.current = next;
		if (upserts.length === 0 && removes.length === 0) return null;
		const delta: Delta = { seq: ++this.seq, upserts, removes };
		this.log.push(delta);
		if (this.log.length > this.logMax)
			this.log.splice(0, this.log.length - this.logMax);
		for (const fn of [...this.listeners]) fn(delta);
		return delta;
	}

	snapshot(): { bootId: string; seq: number; agents: FedAgent[] } {
		return {
			bootId: this.bootId,
			seq: this.seq,
			agents: [...this.current.values()].map((v) => v.agent),
		};
	}

	/** Deltas after `seq`, or null when the log no longer reaches back that far. */
	since(bootId: string, seq: number): Delta[] | null {
		if (bootId !== this.bootId || seq > this.seq) return null;
		if (seq === this.seq) return [];
		const first = this.log[0];
		if (!first || first.seq > seq + 1) return null;
		return this.log.filter((d) => d.seq > seq);
	}

	digest(machineId: string): Digest {
		return {
			machineId,
			bootId: this.bootId,
			seq: this.seq,
			agentCount: this.current.size,
		};
	}

	/** Live deltas; returns the unsubscribe function. */
	listen(fn: (d: Delta) => void): () => void {
		this.listeners.add(fn);
		return () => {
			this.listeners.delete(fn);
		};
	}
}
