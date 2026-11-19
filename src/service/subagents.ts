import { driverFor } from "../harnesses/index.ts";
import type { FoundSubagent, HarnessDriver } from "../harnesses/types.ts";
import type {
	SubagentCounts,
	SubagentList,
	SubagentMessaging,
	SubagentRow,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import type { EventBus } from "./events.ts";
import {
	isLocalSubagentId,
	isRemote,
	type PoolView,
	SUB_MARK,
	splitSubagentId,
} from "./pool.ts";
import type { Registry } from "./registry.ts";

/**
 * Subagents (docs/subagents.md): children an agent's harness runs for it
 * (Claude Task calls and teammates, Codex spawned threads, omp tasks,
 * OpenCode child sessions). They are not agents: they live here, never in
 * the registry, so selectors, `*`, broadcasts, counts and `list_agents`
 * never see them. Only their own id (`<parent>/sub:<key>`) reaches one.
 *
 * Discovery is lazy: `sweep` runs one cheap check per live agent (a folder's
 * mtime) and lists again only when it moved or a child still runs; a parent
 * someone looks at (its list or its transcript's subagent activity) is
 * listed on demand. Drivers re-read only files that changed.
 */

/** A listed parent is listed again on demand at most this often. */
const FRESH_MS = 2000;
/** Harnesses with no cheap stamp (API-backed) are swept at most this often per parent. */
const API_SWEEP_MS = 30_000;
/** A parent someone looked at stays watched (swept even without a stamp) this long. */
const WATCH_MS = 5 * 60_000;
/** Most subagents kept per parent (newest first). */
const MAX_PER_PARENT = 200;

interface Entry {
	stamp: string | null;
	found: FoundSubagent[];
	rows: SubagentRow[];
	counts: SubagentCounts | undefined;
	listedAt: number;
	inflight: Promise<void> | null;
	/** One more listing, asked for while `inflight` ran (it may miss a new file). */
	again: Promise<void> | null;
	watchedAt: number;
	key: string;
}

/** Where a message to a subagent of this harness goes. */
function messagingFor(
	driver: HarnessDriver | null | undefined,
	parentName: string,
): SubagentMessaging {
	const label = driver?.label ?? "This harness's";
	if (driver?.subagents?.direct && driver.push)
		return {
			mode: "direct",
			note: `Goes straight into this subagent's own ${label} session.`,
		};
	return {
		mode: "parent",
		note: `${label} subagents can't receive messages from Pulsar. This goes to the parent agent, ${parentName}, naming the subagent.`,
	};
}

/** The text a redirected message carries, so the parent knows who it is for. */
export function forParentBody(sub: SubagentRow, body: string): string {
	return `For your subagent "${sub.name}" (${sub.id.slice(sub.id.lastIndexOf(SUB_MARK) + SUB_MARK.length)}): ${body}`;
}

export class Subagents {
	private readonly registry: Registry;
	private readonly events: EventBus;
	private entries = new Map<string, Entry>();
	/** Set by the service when the node joins a pool. */
	pool: PoolView | null = null;
	/** Set by tests: the clock. */
	now: () => number = Date.now;

	constructor(deps: { registry: Registry; events: EventBus }) {
		this.registry = deps.registry;
		this.events = deps.events;
	}

	/** The local agent that can have subagents, or undefined. */
	private parent(parentId: string): Agent | undefined {
		const agent = this.registry.get(parentId);
		return agent && driverFor(agent.harness)?.subagents ? agent : undefined;
	}

	private entry(parentId: string): Entry {
		let e = this.entries.get(parentId);
		if (!e) {
			e = {
				stamp: null,
				found: [],
				rows: [],
				counts: undefined,
				listedAt: 0,
				inflight: null,
				again: null,
				watchedAt: 0,
				key: "",
			};
			this.entries.set(parentId, e);
		}
		return e;
	}

	/** A local agent's counts, once found (undefined: none or not looked yet). */
	counts(agentId: string): SubagentCounts | undefined {
		return this.entries.get(agentId)?.counts;
	}

	/** A local agent's subagents as last listed (no I/O). */
	cached(agentId: string): SubagentRow[] {
		return this.entries.get(agentId)?.rows ?? [];
	}

	/**
	 * Lists a local agent's subagents now (one at a time per agent). Asked
	 * while a listing runs, it lists once more after it, since that one may
	 * have read the folder before the change the caller knows about; callers
	 * that ask meanwhile share that one follow-up.
	 */
	refresh(parentId: string): Promise<void> {
		const agent = this.parent(parentId);
		if (!agent) return Promise.resolve();
		const e = this.entry(parentId);
		if (e.inflight) {
			e.again ??= e.inflight.then(() => {
				e.again = null;
				return this.refresh(parentId);
			});
			return e.again;
		}
		const run = (async () => {
			try {
				const driver = driverFor(agent.harness)!;
				let found: FoundSubagent[] = [];
				try {
					found = await driver.subagents!.list(agent);
				} catch {
					found = e.found;
				}
				if (this.registry.closed) return;
				found.sort((a, b) => b.startedAt - a.startedAt);
				found = found.slice(0, MAX_PER_PARENT);
				this.apply(agent, e, found);
			} finally {
				e.listedAt = this.now();
				e.inflight = null;
			}
		})();
		e.inflight = run;
		return run;
	}

	private apply(agent: Agent, e: Entry, found: FoundSubagent[]) {
		const driver = driverFor(agent.harness);
		const messaging = messagingFor(driver, agent.name);
		const hasTranscript = Boolean(
			driver?.subagents?.transcript || driver?.transcript,
		);
		const idOf = (key: string) => `${agent.id}${SUB_MARK}${key}`;
		const keys = new Set(found.map((f) => f.key));
		e.found = found;
		e.rows = found.map((f) => ({
			id: idOf(f.key),
			parentId: agent.id,
			name: f.name,
			harness: agent.harness,
			kind: f.kind,
			agentType: f.agentType,
			description: f.description,
			state: f.state,
			startedAt: f.startedAt,
			updatedAt: f.updatedAt,
			finishedAt: f.finishedAt,
			callId: f.callId,
			parentSubId:
				f.parentKey && keys.has(f.parentKey) ? idOf(f.parentKey) : null,
			hasTranscript:
				hasTranscript && Boolean(f.file || f.sessionId) && hasSource(driver, f),
			messaging,
		}));
		const running = found.filter((f) => f.state === "running").length;
		const done = found.filter((f) => f.state === "done").length;
		const counts = found.length
			? { total: found.length, running, done }
			: undefined;
		const key = JSON.stringify(e.rows, (k, v) =>
			k === "updatedAt" && typeof v === "number" ? Math.floor(v / 60_000) : v,
		);
		const changed = key !== e.key;
		e.key = key;
		e.counts = counts;
		if (changed) this.events.emit("subagents", { agentId: agent.id, counts });
	}

	/**
	 * The sweep: one cheap check per live agent; lists again only where the
	 * stamp moved, a child still runs, or (API harnesses) someone watches.
	 * Sequential, so it never floods the disk or a harness server.
	 */
	async sweep() {
		const now = this.now();
		for (const agent of this.registry.live()) {
			if (this.registry.closed) return;
			const sub = driverFor(agent.harness)?.subagents;
			if (!sub) continue;
			const e = this.entries.get(agent.id);
			const running = (e?.counts?.running ?? 0) > 0;
			if (sub.stamp) {
				let stamp: string | null = null;
				try {
					stamp = await sub.stamp(agent);
				} catch {}
				if (stamp === null && !e) continue;
				const entry = e ?? this.entry(agent.id);
				if (stamp !== entry.stamp || running) {
					entry.stamp = stamp;
					await this.refresh(agent.id);
				}
				continue;
			}
			const watched = e && now - e.watchedAt < WATCH_MS;
			if ((running || watched) && now - (e?.listedAt ?? 0) >= API_SWEEP_MS)
				await this.refresh(agent.id);
		}
		// Parents that left: drop them (they come back listed if they return).
		for (const id of this.entries.keys())
			if (!this.registry.get(id)) this.entries.delete(id);
	}

	/** Someone looks at this parent: keep it current. */
	watch(parentId: string) {
		const e =
			this.entries.get(parentId) ??
			(this.parent(parentId) ? this.entry(parentId) : null);
		if (e) e.watchedAt = this.now();
	}

	/**
	 * Live transcript events of a parent: a subagent call or sidechain
	 * record means its children changed; list again soon.
	 */
	noteEvents(parentId: string, events: TranscriptEvent[]) {
		if (!this.parent(parentId)) return;
		const busy = events.some(
			(ev) =>
				ev.sidechain ||
				ev.subtype === "task" ||
				(ev.kind === "tool_call" &&
					/^(Task|Agent|task|spawn_agent)$/.test(ev.tool?.name ?? "")),
		);
		if (!busy) return;
		const e = this.entry(parentId);
		e.watchedAt = this.now();
		if (this.now() - e.listedAt >= FRESH_MS) void this.refresh(parentId);
	}

	/**
	 * `GET /agents/:id/subagents`: a local agent's (listed now unless fresh),
	 * or a remote one's from its home node.
	 */
	async list(agentId: string, as?: Principal): Promise<SubagentList> {
		const local = this.registry.get(agentId);
		if (!local) {
			const remote = this.registry.find(agentId);
			if (remote && isRemote(remote) && this.pool?.subagents)
				return this.pool.subagents(agentId, as);
			throw new RpcError("not_found", `no agent ${agentId}`);
		}
		const e = this.parent(agentId) ? this.entry(agentId) : null;
		if (e) {
			e.watchedAt = this.now();
			if (this.now() - e.listedAt >= FRESH_MS) await this.refresh(agentId);
		}
		const items = e?.rows ?? [];
		return {
			agentId,
			items,
			total: items.length,
			running: items.filter((r) => r.state === "running").length,
		};
	}

	/**
	 * `GET /subagents/:id`: one subagent, local (listed when needed) or
	 * remote (its parent's list from the home node).
	 */
	async get(id: string, as?: Principal): Promise<SubagentRow> {
		const parts = splitSubagentId(id);
		if (parts && !isLocalSubagentId(id)) {
			const list = await this.list(parts.parentId, as);
			const hit = list.items.find((r) => r.id === id);
			if (hit) return hit;
		} else if (parts) {
			const hit = await this.row(id);
			if (hit) return hit;
		}
		throw new RpcError("not_found", `no subagent ${id}`);
	}

	/** A local subagent's row by id, listing its parent when needed. */
	async row(id: string): Promise<SubagentRow | undefined> {
		const parts = splitSubagentId(id);
		if (!parts || !isLocalSubagentId(id)) return undefined;
		const e = this.entries.get(parts.parentId);
		const hit = e?.rows.find((r) => r.id === id);
		if (hit) return hit;
		if (!this.parent(parts.parentId)) return undefined;
		await this.refresh(parts.parentId);
		return this.entries.get(parts.parentId)?.rows.find((r) => r.id === id);
	}

	/** A local subagent's discovered record (sync; only what was listed). */
	private found(id: string): { parent: Agent; sub: FoundSubagent } | undefined {
		const parts = splitSubagentId(id);
		if (!parts || !isLocalSubagentId(id)) return undefined;
		const parent = this.registry.get(parts.parentId);
		const sub = this.entries
			.get(parts.parentId)
			?.found.find((f) => f.key === parts.key);
		return parent && sub ? { parent, sub } : undefined;
	}

	/**
	 * A local subagent as an `Agent`-shaped record, for the transcript tailer
	 * and for direct delivery. Never added to the registry.
	 */
	agentFor(id: string): Agent | undefined {
		const hit = this.found(id);
		if (!hit) return undefined;
		const { parent, sub } = hit;
		return {
			id,
			name: sub.name,
			harness: parent.harness,
			sessionId: sub.sessionId,
			pid: null,
			cwd: parent.cwd,
			project: parent.project,
			branch: parent.branch,
			...(parent.machine ? { machine: parent.machine } : {}),
			tags: [],
			status:
				sub.state === "running"
					? "busy"
					: sub.state === "idle"
						? "idle"
						: "gone",
			model: null,
			activity: sub.description,
			inbound: "accept",
			registered: false,
			reach: "push",
			lastSeen: sub.updatedAt,
			createdAt: sub.startedAt,
			meta: { subagentOf: parent.id, subagentKey: sub.key },
		};
	}

	/**
	 * Who a direct send to this subagent goes to: the local record (driver
	 * `push` with its own session id), or a remote one the pool hands to its
	 * home node. Undefined when it is not direct or not found.
	 */
	deliveryTarget(row: SubagentRow): Agent | undefined {
		if (row.messaging.mode !== "direct" || row.state === "done")
			return undefined;
		if (isLocalSubagentId(row.id)) return this.agentFor(row.id);
		const slash = row.id.indexOf("/");
		const parent = this.registry.find(row.parentId);
		if (!parent || slash <= 0) return undefined;
		return {
			...parent,
			id: row.id,
			name: row.name,
			sessionId: null,
			pid: null,
			tags: [],
			status: row.state === "running" ? "busy" : "idle",
			activity: row.description,
			inbound: "accept",
			reach: "push",
			meta: {
				machineId: row.id.slice(0, slash),
				localId: row.id.slice(slash + 1),
				subagentOf: row.parentId,
			},
		};
	}

	/** The parent of a local subagent record made by `agentFor`. */
	parentOf(agent: Agent): Agent | undefined {
		const id = agent.meta.subagentOf;
		return id ? this.registry.get(id) : undefined;
	}

	/** Where a local subagent's transcript is (the tailer's resolver). */
	async transcript(agent: Agent): Promise<ResolvedTranscript | null> {
		const hit = this.found(agent.id);
		if (!hit) return null;
		const { parent, sub } = hit;
		const driver = driverFor(parent.harness);
		const own = await driver?.subagents?.transcript?.(parent, sub);
		if (own) return { source: own.source, parse: own.parse, cwd: parent.cwd };
		// Codex threads, OpenCode sessions: the harness's own transcript of that session.
		if (!sub.sessionId || !driver?.transcript) return null;
		const source = await driver.transcript.locate({
			harness: parent.harness,
			sessionId: sub.sessionId,
			cwd: parent.cwd,
		});
		return source
			? { source, parse: driver.transcript.parse, cwd: parent.cwd }
			: null;
	}
}

function hasSource(driver: HarnessDriver | null | undefined, f: FoundSubagent) {
	if (driver?.subagents?.transcript && f.file) return true;
	return Boolean(f.sessionId && driver?.transcript);
}
