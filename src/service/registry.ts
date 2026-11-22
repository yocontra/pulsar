import { basename } from "node:path";
import { cachedGitInfo, type GitInfo, gitInfoAsync, slug } from "../git.ts";
import { DRIVERS, driverFor, pushFor } from "../harnesses/index.ts";
import {
	harnessNameOf,
	NAME_KEY,
	NAME_SOURCE_KEY,
	type NameSource,
	pulsarNameFor,
} from "../harnesses/names.ts";
import type { HarnessDriver, Scanned } from "../harnesses/types.ts";
import type { NeedsYou } from "../http/wire.ts";
import { neutralizeHumanTag, operatorName } from "../human-tag.ts";
import { daemonLog } from "../log.ts";
import { pidAlive } from "../processes.ts";
import { prFromRefs, prFromText, repoOf } from "../prs.ts";
import { RpcError } from "../rpc.ts";
import { matches, parseSelector } from "../selector.ts";
import type { Store } from "../store.ts";
import { autoTags, isAutoTag } from "../tags.ts";
import type {
	Agent,
	AgentStatus,
	InboundPolicy,
	PublicAgent,
	Registration,
} from "../types.ts";
import { agentIdOf, type Caller, OPERATOR_ID } from "./caller.ts";
import type { EventBus } from "./events.ts";
import { LIMITS } from "./limits.ts";
import { isAddress, type PoolView, splitAddress } from "./pool.ts";
import type { Sessions } from "./sessions.ts";
import { newId, toPublic } from "./util.ts";
import type { Waiters } from "./waiters.ts";

const RESERVED_NAMES = new Set(["operator", "user", "human", "system"]);

/** How long a renamed agent still answers to its former name. */
export const FORMER_NAME_MS = 15 * 60_000;

const NO_GIT: GitInfo = { project: null, branch: null, worktree: null };

/** Git info for each distinct folder, looked up concurrently (the exec lane bounds it). */
async function gitFor(
	cwds: Array<string | null>,
): Promise<Map<string, GitInfo>> {
	const unique = [...new Set(cwds.filter((c): c is string => !!c))];
	const infos = await Promise.all(unique.map((c) => gitInfoAsync(c)));
	return new Map(unique.map((c, i) => [c, infos[i]!]));
}

/** Sender ids of the pool owner: `user:<login>`. */
export const USER_PREFIX = "user:";

/** The virtual tag every agent that needs the user carries in selectors and views. */
const NEEDS_YOU_TAG = "needs:you";

/** Tags pulsar owns: an agent can neither claim nor drop them. */
function reservedTag(tag: string) {
	return tag.startsWith("machine:") || tag.startsWith("needs:");
}

export type { NeedsYou } from "../http/wire.ts";

export interface UpsertInput {
	harness: Agent["harness"];
	sessionId: string | null;
	pid: number | null;
	cwd: string | null;
	project: string | null;
	branch: string | null;
	tags: string[];
	name?: string;
	meta: Record<string, string>;
	registered: boolean;
	status?: AgentStatus;
	model?: string | null;
}

/**
 * Live presence: every agent on this machine, kept in memory because it is
 * only true while the daemon runs. Scans, git/PR/model refreshes and the
 * sweep keep it current.
 */
export class Registry {
	private agents = new Map<string, Agent>();
	/** Each folder's repo web page, as the last `refreshPrs` read it (null: none). */
	private repoUrls = new Map<string, string | null>();
	/** Pool-owner senders seen this run, by id. */
	private users = new Map<string, Agent>();
	/** Agents waiting on the user; empty until approvals exist. */
	private needs = new Map<string, NeedsYou>();
	/** The terminal wait each agent's last scan saw (applyTerminalWait). */
	private terminalSeen = new Map<string, string>();
	private readonly store: Store;
	private readonly sessions: Sessions;
	private readonly events: EventBus;
	private readonly waiters: Waiters;
	/** Set when the service stops: a scan or refresh still in flight changes nothing. */
	closed = false;
	/** This machine's name; every agent carries it and the `machine:` tag. */
	machine: string;
	/** Set by the service: pushes held messages once an agent accepts again. */
	onRelease: (agent: Agent) => void = () => {};
	/** Set by the service: an agent's session ended (tracked messages wait for it). */
	onGone?: (agent: Agent) => void;
	/** Set by the service: an agent is new to this daemon or back from gone. */
	onBack?: (agent: Agent) => void;
	/** The rest of the pool (federation); null on a node with no pool links. */
	pool: PoolView | null = null;
	/** Remote agents with display names, rebuilt when the pool or local names change. */
	private remoteCache: {
		key: string;
		list: Agent[];
		byId: Map<string, Agent>;
	} | null = null;

	constructor(deps: {
		store: Store;
		sessions: Sessions;
		events: EventBus;
		waiters: Waiters;
		machine: string;
	}) {
		this.machine = deps.machine;
		this.store = deps.store;
		this.sessions = deps.sessions;
		this.events = deps.events;
		this.waiters = deps.waiters;
	}

	get(id: string): Agent | undefined {
		return this.agents.get(id);
	}

	/**
	 * A local agent by id, or any pool agent by pool address (this machine's
	 * own addresses resolve to the local agent).
	 */
	find(id: string): Agent | undefined {
		const local = this.agents.get(id);
		if (local || !isAddress(id)) return local;
		const parts = splitAddress(id);
		if (!parts) return undefined;
		if (parts.machineId === this.store.machineId())
			return this.agents.get(parts.localId);
		this.remoteAgents();
		return this.remoteCache?.byId.get(id);
	}

	/**
	 * Agents on other machines, as `PoolView` holds them, with `@machine`
	 * added to a name another agent in the pool also has (a local agent
	 * keeps its name).
	 */
	remoteAgents(): Agent[] {
		const pool = this.pool;
		if (!pool) return [];
		const localNames = new Set<string>();
		for (const a of this.agents.values())
			if (a.status !== "gone") localNames.add(a.name);
		const key = `${pool.version()}\u0000${[...localNames].sort().join("\u0000")}`;
		if (this.remoteCache?.key === key) return this.remoteCache.list;
		const remotes = pool.agents();
		const counts = new Map<string, number>();
		for (const a of remotes) counts.set(a.name, (counts.get(a.name) ?? 0) + 1);
		const list = remotes.map((a) =>
			localNames.has(a.name) || (counts.get(a.name) ?? 0) > 1
				? { ...a, name: `${a.name}@${a.machine ?? a.meta.machineId}` }
				: a,
		);
		this.remoteCache = {
			key,
			list,
			byId: new Map(list.map((a) => [a.id, a])),
		};
		return list;
	}

	delete(id: string) {
		this.agents.delete(id);
		this.statusAt.delete(id);
		this.terminalSeen.delete(id);
		this.cancelIdle(id);
		this.clearNeedsYou(id);
	}

	/**
	 * How long a reported idle must hold before it shows; busy shows at once.
	 * A turn that pauses between steps (or a status source that flaps) never
	 * reads as idle. PULSAR_IDLE_SETTLE_MS overrides it (tests use 0).
	 */
	idleSettleMs = idleSettleDefault();

	/** Idle reported after busy, not shown yet: since when, and what to show. */
	private heldIdle = new Map<
		string,
		{ at: number; status: AgentStatus; timer: ReturnType<typeof setTimeout> }
	>();

	/**
	 * Holds an idle (or unknown) reading for a busy agent until it has lasted
	 * `idleSettleMs` from `at`. True while held (the agent stays busy); false
	 * when it should apply now. A repeated reading keeps the first time.
	 */
	private holdIdle(agent: Agent, status: AgentStatus, at: number): boolean {
		const settle = this.idleSettleMs;
		if (agent.status !== "busy" || settle <= 0 || this.closed) {
			this.cancelIdle(agent.id);
			return false;
		}
		const held = this.heldIdle.get(agent.id);
		if (held) {
			held.status = status;
			return true;
		}
		const left = settle - (Date.now() - at);
		if (left <= 0) return false;
		const timer = setTimeout(() => this.showIdle(agent.id), left);
		timer.unref?.();
		this.heldIdle.set(agent.id, { at, status, timer });
		traceStatus(`${agent.id} idle held (${left} ms)`);
		return true;
	}

	/** Drops a held idle: the agent is busy again (or gone). */
	private cancelIdle(id: string) {
		const held = this.heldIdle.get(id);
		if (!held) return;
		clearTimeout(held.timer);
		this.heldIdle.delete(id);
		traceStatus(`${id} idle dropped`);
	}

	/** A held idle lasted: shown now, dated from when the agent went idle. */
	private showIdle(id: string) {
		const held = this.heldIdle.get(id);
		if (!held) return;
		this.cancelIdle(id);
		const agent = this.agents.get(id);
		if (agent?.status !== "busy" || this.closed) return;
		agent.status = held.status;
		this.noteStatus(agent, "busy", held.at);
		traceStatus(`${id} -> ${held.status} (since ${held.at})`);
		this.waiters.resolveIdle(agent);
		this.events.emit("agent", { action: "update", agent: toPublic(agent) });
	}

	/** Shows every held idle whose settle time passed (a row built before its timer ran). */
	settleIdle(now = Date.now()) {
		for (const [id, held] of [...this.heldIdle])
			if (now - held.at >= this.idleSettleMs) this.showIdle(id);
	}

	/** Stops the settle timers (the service stopped). */
	clearHeld() {
		for (const id of [...this.heldIdle.keys()]) this.cancelIdle(id);
	}

	/** When each local agent's status last changed (ms); `unknown` counts as idle. */
	private statusAt = new Map<string, number>();

	private noteStatus(
		agent: Agent,
		was: AgentStatus | undefined,
		at = Date.now(),
	) {
		if (shown(was) === shown(agent.status)) return;
		this.statusAt.set(agent.id, at);
		if (was !== undefined) this.emitStatus(agent, was, at);
	}

	/** Announces a status change (`agent:status`); see ServiceEvents. */
	private emitStatus(agent: Agent, from: AgentStatus, at: number) {
		this.events.emit("agent:status", {
			agentId: agent.id,
			from,
			to: agent.status,
			at,
		});
	}

	/** When a local agent's status last changed: true even when no view was built in between. */
	statusSince(agent: Agent): number {
		return this.statusAt.get(agent.id) ?? agent.createdAt;
	}

	/**
	 * Marks (or, with null, clears) an agent as waiting on the user. The hook
	 * later phases call when an approval is pending or an agent asked the user.
	 * Announced at once as an `attention` event.
	 */
	setNeedsYou(agentId: string, needs: Omit<NeedsYou, "since"> | null) {
		if (!needs) return this.clearNeedsYou(agentId);
		// The operator isn't registered; a presence check from a terminal waits on it.
		if (!this.agents.has(agentId) && agentId !== OPERATOR_ID) return;
		const value: NeedsYou = { ...needs, since: Date.now() };
		this.needs.set(agentId, value);
		this.events.emit("attention", { agentId, needsYou: value });
	}

	private clearNeedsYou(agentId: string) {
		if (!this.needs.delete(agentId)) return;
		this.events.emit("attention", { agentId, needsYou: null });
	}

	needsYou(agentId: string): NeedsYou | null {
		if (isAddress(agentId)) return this.pool?.needsYou(agentId) ?? null;
		return this.needs.get(agentId) ?? null;
	}

	/** Agents that need the user, oldest first. */
	needingYou(): Agent[] {
		return [...this.needs.entries()]
			.sort((a, b) => a[1].since - b[1].since)
			.flatMap(([id]) => {
				// The operator waits on a presence check from a terminal.
				const agent =
					this.agents.get(id) ??
					(id === OPERATOR_ID ? this.operator() : undefined);
				return agent && agent.status !== "gone" ? [agent] : [];
			});
	}

	/**
	 * An agent as selectors and views see it: public fields plus the virtual
	 * `needs:you` tag while it waits on the user.
	 */
	view(agent: Agent): PublicAgent {
		const pub = toPublic(agent);
		return this.needsYou(agent.id)
			? { ...pub, tags: [...pub.tags, NEEDS_YOU_TAG] }
			: pub;
	}

	all(): Agent[] {
		return [...this.agents.values()];
	}

	uniqueName(wanted: string, selfId: string): string {
		// No agent name may look like the `[human operator]` tag.
		wanted = neutralizeHumanTag(wanted);
		// "operator" is the human at the terminal; no agent may take it.
		const base = RESERVED_NAMES.has(wanted.toLowerCase())
			? `${wanted}-agent`
			: wanted;
		const taken = new Set(
			[...this.agents.values()]
				.filter((a) => a.id !== selfId && a.status !== "gone")
				.map((a) => a.name),
		);
		if (!taken.has(base)) return base;
		for (let i = 2; ; i++)
			if (!taken.has(`${base}-${i}`)) return `${base}-${i}`;
	}

	private defaultName(
		harness: string,
		project: string | null,
		cwd: string | null,
	) {
		return `${harness}@${project ?? (cwd ? slug(basename(cwd)) : "unknown")}`;
	}

	/** The pulsar name an agent's harness name (in meta) gives, or null. */
	private harnessNameFor(meta: Record<string, string>): string | null {
		return pulsarNameFor(meta);
	}

	/**
	 * True when a saved name is one the agent chose. Older daemons saved
	 * every name: a default (`<harness>@<project>`, which no chosen name can
	 * be: `set_identity` slugs away the `@`) or the harness name it had does
	 * not count.
	 */
	private savedSelfName(saved: string | null, fromHarness: string | null) {
		if (!saved || saved.includes("@")) return false;
		return !fromHarness || saved.replace(/-\d+$/, "") !== fromHarness;
	}

	/**
	 * Names agents had until a rename: a `to` that names nobody live resolves
	 * through them for `FORMER_NAME_MS`, so a send to the old name still lands.
	 */
	private formerNames = new Map<string, { id: string; until: number }>();

	private rememberName(name: string, id: string) {
		const now = Date.now();
		for (const [old, e] of this.formerNames)
			if (e.until <= now) this.formerNames.delete(old);
		this.formerNames.set(name, { id, until: now + FORMER_NAME_MS });
	}

	/** The live agent a former name points at, if still within its grace period. */
	private byFormerName(name: string): Agent | undefined {
		const e = this.formerNames.get(name);
		if (!e) return undefined;
		if (e.until <= Date.now()) {
			this.formerNames.delete(name);
			return undefined;
		}
		const agent = this.agents.get(e.id);
		return agent && agent.status !== "gone" ? agent : undefined;
	}

	/**
	 * A harness reported its session's name (the pi/omp extension, the Codex
	 * index): kept in meta, and the agent follows it unless it chose its own
	 * name. Announces a rename.
	 */
	applyHarnessName(agent: Agent, raw: string, source: NameSource) {
		if (this.agents.get(agent.id) !== agent) return;
		const text = raw.trim().slice(0, 200);
		const before = harnessNameOf(agent.meta)?.raw;
		if (!text) {
			// The session lost its name (pi/omp `/new`): back to the default.
			if (!before) return;
			delete agent.meta[NAME_KEY];
			delete agent.meta[NAME_SOURCE_KEY];
			delete agent.meta.claudeName;
			if (agent.meta.nameFrom !== "harness") return;
			agent.meta.nameFrom = "pulsar";
			this.rename(
				agent,
				this.uniqueName(
					this.defaultName(agent.harness, agent.project, agent.cwd),
					agent.id,
				),
			);
			return;
		}
		if (agent.meta[NAME_KEY] === text && agent.meta[NAME_SOURCE_KEY] === source)
			return;
		agent.meta[NAME_KEY] = text;
		agent.meta[NAME_SOURCE_KEY] = source;
		if (agent.meta.nameFrom === "self") return;
		const wanted = pulsarNameFor(agent.meta);
		if (!wanted) return;
		if (agent.meta.nameFrom === "harness" && before === text) return;
		agent.meta.nameFrom = "harness";
		this.rename(agent, this.uniqueName(wanted, agent.id));
	}

	/** Renames a live agent: the old name stays an alias for a while; announced. */
	private rename(agent: Agent, name: string) {
		if (name === agent.name) return;
		if (agent.status !== "gone") this.rememberName(agent.name, agent.id);
		agent.name = name;
		this.events.emit("agent", { action: "update", agent: toPublic(agent) });
	}

	/**
	 * A local agent id. Never contains `/`: an id with one is a pool address
	 * (`<machineId>/<localId>`), so a registration cannot pose as a remote
	 * agent or a remote user.
	 */
	agentId(harness: string, sessionId: string | null, pid: number | null) {
		const h = harness.replaceAll("/", "%2F");
		if (sessionId) return `${h}:${sessionId.replaceAll("/", "%2F")}`;
		if (pid) return `${h}:pid:${pid}`;
		return `${h}:${newId("anon")}`;
	}

	upsert(input: UpsertInput): Agent {
		// `user:<login>` is the pool owner's sender id; no session may take it.
		if (input.harness === "user")
			throw new RpcError("bad_request", "the harness name `user` is reserved");
		const id = this.agentId(input.harness, input.sessionId, input.pid);
		const now = Date.now();
		const existing = this.agents.get(id);
		const saved = existing ? null : this.store.loadIdentity(id);
		const selfTags =
			saved?.tags ?? existing?.tags.filter((t) => !isAutoTag(t)) ?? [];
		const tags = [...new Set([...input.tags, ...selfTags])];
		// Name precedence (docs/adapters.md, "Names"): a name the agent chose
		// (set_identity, PULSAR_NAME) > the harness's own session name, which it
		// follows through renames > `<harness>@<project>`.
		const meta = { ...(existing?.meta ?? {}), ...input.meta };
		const fromHarness = this.harnessNameFor(meta);
		const selfNamed =
			existing?.meta.nameFrom === "self" ||
			(!existing && this.savedSelfName(saved?.name ?? null, fromHarness));
		let name: string;
		let nameFrom: string;
		if (input.name) {
			name = this.uniqueName(input.name, id);
			nameFrom = "self";
		} else if (selfNamed) {
			name = existing?.name ?? this.uniqueName(saved?.name ?? id, id);
			nameFrom = "self";
		} else if (fromHarness) {
			// Same harness name as before: keep the name (and its `-2` suffix).
			name =
				existing?.meta.nameFrom === "harness" &&
				harnessNameOf(existing.meta)?.raw === harnessNameOf(meta)?.raw
					? existing.name
					: this.uniqueName(fromHarness, id);
			nameFrom = "harness";
		} else if (existing) {
			name = existing.name;
			nameFrom = existing.meta.nameFrom ?? "pulsar";
		} else {
			name = this.uniqueName(
				this.defaultName(input.harness, input.project, input.cwd),
				id,
			);
			nameFrom = "pulsar";
		}
		if (existing && existing.status !== "gone" && existing.name !== name)
			this.rememberName(existing.name, id);
		const previousStatus = existing?.status;
		const agent: Agent = {
			id,
			name,
			harness: input.harness,
			sessionId: input.sessionId,
			pid: input.pid ?? existing?.pid ?? null,
			cwd: input.cwd ?? existing?.cwd ?? null,
			project: input.project ?? existing?.project ?? null,
			branch: input.branch ?? existing?.branch ?? null,
			...this.repoUrlFor(input.cwd ?? existing?.cwd ?? null, existing),
			machine: this.machine,
			tags,
			status:
				input.status ??
				(existing && existing.status !== "gone" ? existing.status : "unknown"),
			model: input.model ?? existing?.model ?? null,
			activity: existing?.activity ?? saved?.activity ?? null,
			inbound: existing?.inbound ?? saved?.inbound ?? "accept",
			registered: input.registered || (existing?.registered ?? false),
			reach: "pull",
			lastSeen: now,
			createdAt: existing?.createdAt ?? now,
			meta: { ...meta, nameFrom },
		};
		this.finishTags(agent);
		agent.reach = this.reachOf(agent);
		// A scan reading idle for a busy agent waits out the settle time.
		if (input.status !== undefined && existing && previousStatus === "busy") {
			if (input.status === "idle" || input.status === "unknown") {
				if (this.holdIdle(existing, input.status, now)) agent.status = "busy";
			} else this.cancelIdle(id);
		}
		this.agents.set(id, agent);
		this.noteStatus(agent, previousStatus);
		if (previousStatus !== "idle" && agent.status === "idle")
			this.waiters.resolveIdle(agent);
		// A registration notifies the service itself, once its connection is bound.
		if ((!existing || existing.status === "gone") && !input.registered)
			this.onBack?.(agent);
		else if (existing && existing.name !== name)
			this.events.emit("agent", { action: "update", agent: toPublic(agent) });
		return agent;
	}

	reachOf(agent: Agent): Agent["reach"] {
		if (this.sessions.extensionFor(agent.id)) return "push";
		return pushFor(agent) ? "push" : "pull";
	}

	/**
	 * Applies one scan. Git info for every folder is read first (async,
	 * cached), then the whole scan is applied in one synchronous step, so an
	 * agent is never named or tagged before its project is known.
	 */
	private async applyScan(
		found: Scanned[],
		harnesses: Set<string>,
		startedAt: number,
		tracksPid = false,
	) {
		const gits = await gitFor(found.map((s) => s.cwd));
		if (this.closed) return;
		const seen = new Set<string>();
		for (const s of found) {
			const git = (s.cwd && gits.get(s.cwd)) || NO_GIT;
			const agent = this.upsert({
				harness: s.harness,
				sessionId: s.sessionId,
				pid: s.pid,
				cwd: s.cwd,
				project: git.project,
				branch: git.branch,
				tags: autoTags(s.harness, git),
				meta: s.meta,
				registered: false,
				status: s.status,
				model: s.model ?? null,
			});
			seen.add(agent.id);
			if (s.waitingFor !== undefined)
				this.applyTerminalWait(agent, s.waitingFor);
		}
		// One process runs one session: a session of a scanned pid that the scan
		// no longer shows is one its process left (Claude's /resume, /clear),
		// still held by a pulsar connection made before the switch.
		const byPid = new Map<number, Agent>();
		if (tracksPid)
			for (const id of seen) {
				const a = this.agents.get(id);
				if (a?.pid) byPid.set(a.pid, a);
			}
		// Sessions a scanner owns that vanished: gone, unless a pulsar connection
		// still serves them (an OpenCode session that finished its run is idle).
		// One that appeared while this scan ran is not judged by it.
		for (const agent of this.agents.values()) {
			if (
				!harnesses.has(agent.harness) ||
				seen.has(agent.id) ||
				agent.status === "gone" ||
				agent.createdAt >= startedAt
			)
				continue;
			const current = agent.pid ? byPid.get(agent.pid) : undefined;
			if (current) {
				// A prompt still pending for that id (its approval card, its
				// needs-you) keeps it until answered; the next scan folds it in.
				if (!this.needs.has(agent.id)) this.retireSession(agent, current);
			} else if (this.sessions.forAgent(agent.id).length === 0)
				this.markGone(agent);
			else if (
				agent.status !== "idle" &&
				!this.holdIdle(agent, "idle", startedAt)
			) {
				const was = agent.status;
				agent.status = "idle";
				this.noteStatus(agent, was);
				this.waiters.resolveIdle(agent);
			}
		}
	}

	/**
	 * A session waiting on a dialog in its own terminal shows as needs-you
	 * (reason `terminal`) until the dialog closes. A relayed prompt (reason
	 * `approval`, which the approvals service owns) or a question is left
	 * as it is; once it clears, the next scan shows the terminal wait if
	 * the dialog is still open (an approval that timed out in the app).
	 */
	private applyTerminalWait(agent: Agent, waitingFor: string | null) {
		const current = this.needs.get(agent.id);
		// A wait shows once two scans in a row saw it: a relayed prompt's hook
		// connects a moment after the dialog opens, and must not flash a
		// terminal card first.
		const seen = this.terminalSeen.get(agent.id);
		if (waitingFor) this.terminalSeen.set(agent.id, waitingFor);
		else this.terminalSeen.delete(agent.id);
		if (waitingFor && seen !== waitingFor) return;
		// The dialog is a prompt relayed under another id of the same process
		// (a hook's session id): that card already says so.
		const relayed =
			!!agent.pid &&
			[...this.needs.entries()].some(
				([id, n]) =>
					id !== agent.id &&
					n.reason === "approval" &&
					this.agents.get(id)?.pid === agent.pid,
			);
		if (!waitingFor || relayed) {
			if (current?.reason === "terminal") this.clearNeedsYou(agent.id);
			return;
		}
		const detail = `Waiting in the terminal: ${waitingFor}`.slice(0, 200);
		if (current && (current.reason !== "terminal" || current.detail === detail))
			return;
		this.setNeedsYou(agent.id, { reason: "terminal", detail });
	}

	/** Runs and applies one driver's scan; never throws. */
	async runScan(harness: string, scan: NonNullable<HarnessDriver["scan"]>) {
		const startedAt = Date.now();
		const found = await scan.sessions();
		await this.applyScan(
			found,
			new Set([harness]),
			startedAt,
			scan.tracksPid === true,
		);
	}

	/**
	 * A session its process left for another (Claude Code's /resume, /clear,
	 * a session switch): one live process is one agent. Everything that
	 * spoke as or waited on the old session moves to the one the process runs
	 * now: its connections (an MCP server started before the switch keeps
	 * the old id), receipts and blocked waits. The old agent leaves the
	 * list. (Needs-you belongs to an approval keyed by agent id: the scan
	 * leaves an agent with a pending prompt alone until it is answered.) Its name, tags and activity stay behind: they
	 * describe the conversation it was (a /clear starts a new one).
	 */
	retireSession(old: Agent, current: Agent) {
		if (old.id === current.id) return;
		for (const c of this.sessions.forAgent(old.id)) {
			c.principal = { kind: "agent", agentId: current.id };
			this.sessions.bind(c);
		}
		this.store.reassign(old.id, current.id);
		this.waiters.reassign(old.id, current.id);
		if (old.registered) current.registered = true;
		for (const key of ["acks", "resumeKey", "tmux"])
			if (old.meta[key] && !current.meta[key])
				current.meta[key] = old.meta[key]!;
		if (current.inbound === "accept" && old.inbound !== "accept")
			current.inbound = old.inbound;
		current.reach = this.reachOf(current);
		this.delete(old.id);
		const was = old.status;
		old.status = "gone";
		old.lastSeen = Date.now();
		if (was !== "gone") this.emitStatus(old, was, old.lastSeen);
		this.events.emit("agent", { action: "gone", agent: toPublic(old) });
		this.events.emit("agent", { action: "update", agent: toPublic(current) });
		// A wait for the old session to finish ends now if the process is idle.
		if (current.status === "idle") this.waiters.resolveIdle(current);
	}

	/** Drivers with a scanner, for the service's timers. */
	scanners() {
		return DRIVERS.flatMap((d) => (d.scan ? [{ id: d.id, scan: d.scan }] : []));
	}

	markGone(agent: Agent) {
		this.clearNeedsYou(agent.id);
		this.cancelIdle(agent.id);
		const was = agent.status;
		agent.status = "gone";
		this.noteStatus(agent, was);
		agent.lastSeen = Date.now();
		this.events.emit("agent", { action: "gone", agent: toPublic(agent) });
		this.waiters.resolveGone(agent);
		this.onGone?.(agent);
	}

	/** Re-reads project, branch and worktree for every live agent, one git lookup per folder. */
	async refreshGit() {
		const gits = await gitFor(this.live().map((a) => a.cwd));
		if (this.closed) return;
		for (const agent of this.live()) {
			const git = agent.cwd ? gits.get(agent.cwd) : undefined;
			if (git) this.applyGit(agent, git);
		}
	}

	/** Sets an agent's git fields and auto-tags; self-tags are kept. */
	private applyGit(agent: Agent, git: GitInfo) {
		const before = agent.tags;
		const changed =
			agent.project !== git.project || agent.branch !== git.branch;
		agent.project = git.project;
		agent.branch = git.branch;
		agent.tags = [
			...autoTags(agent.harness, git),
			...before.filter((t) => !isAutoTag(t)),
		];
		this.finishTags(agent);
		if (changed || agent.tags.join() !== before.join())
			this.events.emit("agent", { action: "update", agent: toPublic(agent) });
	}

	/**
	 * Adds the auto-tags that do not come from git: `model:<id>` and
	 * `machine:<name>`; drops any `needs:` tag a registration claimed.
	 */
	private finishTags(agent: Agent) {
		// `needs:` is never stored: the needs-you hook projects it (see `view`).
		const base = agent.tags.filter(
			(t) => !t.startsWith("model:") && !reservedTag(t),
		);
		agent.tags = [
			...new Set([
				...base,
				...(agent.model ? [`model:${agent.model}`] : []),
				...(agent.machine ? [`machine:${agent.machine}`] : []),
			]),
		];
	}

	/** Renames this machine: every agent's `machine` field and tag follow. */
	setMachine(name: string) {
		if (!name || name === this.machine) return;
		this.machine = name;
		for (const agent of this.agents.values()) {
			agent.machine = name;
			this.finishTags(agent);
			if (agent.status !== "gone")
				this.events.emit("agent", { action: "update", agent: toPublic(agent) });
		}
	}

	/**
	 * Tags each agent with the PR it works on, offline: PR refs in the local repo
	 * that point at its branch, else the last PR of its repo named in its own
	 * session log (Claude's pr-link records, `gh pr create` output, PR URLs).
	 * Only the tag pulsar added is replaced; `pr:` tags an agent set stay.
	 */
	async refreshPrs() {
		// Per folder, not per agent: the repo (slug, web page) and the PR its HEAD is on.
		const byCwd = new Map<
			string,
			Promise<[{ slug: string | null; url: string | null }, number | null]>
		>();
		for (const agent of this.live()) {
			if (!agent.cwd) continue;
			let repo = byCwd.get(agent.cwd);
			if (!repo) {
				const cwd = agent.cwd;
				repo = Promise.all([repoOf(cwd), prFromRefs(cwd)]);
				byCwd.set(cwd, repo);
			}
			const [{ slug, url }, fromRefs] = await repo;
			const pr =
				fromRefs ??
				prFromText(
					(await driverFor(agent.harness)?.sessionLog?.(agent)) ?? "",
					slug,
				);
			if (this.closed) return;
			this.repoUrls.set(agent.cwd, url);
			if (agent.status === "gone") continue;
			let changed = false;
			if (agent.repoUrl !== url) {
				agent.repoUrl = url;
				changed = true;
			}
			const next = pr ? String(pr) : "";
			const prev = agent.meta.autoPr ?? "";
			if (next !== prev) {
				agent.tags = agent.tags.filter((t) => !prev || t !== `pr:${prev}`);
				if (next && !agent.tags.includes(`pr:${next}`))
					agent.tags.push(`pr:${next}`);
				agent.meta.autoPr = next;
				changed = true;
			}
			if (changed)
				this.events.emit("agent", { action: "update", agent: toPublic(agent) });
		}
		// Forget folders no live agent works in any more.
		for (const cwd of this.repoUrls.keys())
			if (!byCwd.has(cwd)) this.repoUrls.delete(cwd);
	}

	/**
	 * The repo page a (re)registered agent starts with: its folder's, as the
	 * last `refreshPrs` read it, else what the agent had. Absent until known.
	 */
	private repoUrlFor(
		cwd: string | null,
		existing: Agent | undefined,
	): { repoUrl?: string | null } {
		const url =
			cwd && this.repoUrls.has(cwd)
				? this.repoUrls.get(cwd)
				: existing?.repoUrl;
		return url === undefined ? {} : { repoUrl: url };
	}

	/** Model for harnesses whose scanner does not report it (drivers with a `model` hook). */
	async refreshModels() {
		for (const agent of this.live()) {
			if (!agent.sessionId) continue;
			const read = driverFor(agent.harness)?.model;
			const model = read ? await read(agent) : null;
			if (this.closed) return;
			if (model && model !== agent.model) {
				agent.model = model;
				this.finishTags(agent);
			}
		}
	}

	sweep() {
		const now = Date.now();
		for (const agent of [...this.agents.values()]) {
			if (
				agent.status !== "gone" &&
				agent.pid &&
				!pidAlive(agent.pid) &&
				this.sessions.forAgent(agent.id).length === 0
			) {
				this.markGone(agent);
			}
			if (agent.status === "gone" && now - agent.lastSeen > LIMITS.goneGraceMs)
				this.delete(agent.id);
		}
	}

	/** Live agents. A session whose process died is dropped here, before the sweep catches it. */
	live(): Agent[] {
		return [...this.agents.values()].filter((a) => {
			if (a.status === "gone") return false;
			if (
				a.pid &&
				!pidAlive(a.pid) &&
				this.sessions.forAgent(a.id).length === 0
			) {
				this.markGone(a);
				return false;
			}
			return true;
		});
	}

	list(selectorText: string, includeGone = false): PublicAgent[] {
		const selector = parseSelector(selectorText);
		return [...this.agents.values(), ...this.remoteAgents()]
			.filter((a) => includeGone || a.status !== "gone")
			.map((a) => this.view(a))
			.filter((a) => matches(a, selector))
			.sort(
				(a, b) =>
					(a.project ?? "").localeCompare(b.project ?? "") ||
					a.name.localeCompare(b.name),
			);
	}

	/** Live agents a `to` selects, never the sender; an exact name wins over a prefix. */
	resolveTargets(to: string, sender: Agent): Agent[] {
		const selector = parseSelector(to);
		const targets = this.live().filter(
			(a) => a.id !== sender.id && matches(this.view(a), selector),
		);
		return selector.kind === "name"
			? this.byName(selector.value, targets, sender)
			: targets;
	}

	/**
	 * Live agents anywhere in the pool a `to` selects, never the sender; an
	 * exact name wins over a prefix. Remote agents (see `PoolView`) go to the
	 * outbox, never to `Router.deliver`.
	 */
	resolvePool(to: string, sender: Agent): Agent[] {
		if (!this.pool) return this.resolveTargets(to, sender);
		const selector = parseSelector(to);
		const targets = [...this.live(), ...this.remoteAgents()].filter(
			(a) =>
				a.id !== sender.id &&
				a.status !== "gone" &&
				matches(this.view(a), selector),
		);
		return selector.kind === "name"
			? this.byName(selector.value, targets, sender)
			: targets;
	}

	/**
	 * Narrows a bare-name `to`: an exact live name or id wins, then a name
	 * the agent had until a recent rename, then every prefix match.
	 */
	private byName(value: string, targets: Agent[], sender: Agent): Agent[] {
		const exact = targets.filter((a) => a.name === value || a.id === value);
		if (exact.length === 1) return exact;
		if (exact.length === 0) {
			const former = this.byFormerName(value);
			if (former && former.id !== sender.id) return [former];
		}
		return targets;
	}

	/** The human at the terminal, as a sender. */
	operator(): Agent {
		return (
			this.agents.get(OPERATOR_ID) ?? {
				id: OPERATOR_ID,
				name: "operator",
				harness: "cli",
				sessionId: null,
				pid: null,
				cwd: null,
				project: null,
				branch: null,
				machine: this.machine,
				tags: ["harness:cli"],
				status: "idle",
				model: null,
				activity: "the human at the terminal",
				inbound: "accept",
				registered: false,
				reach: "pull",
				lastSeen: Date.now(),
				createdAt: Date.now(),
				meta: {},
			}
		);
	}

	/**
	 * A stored message's sender for a push: who sent it, or, when it has left
	 * the registry, a stand-in with the stored id and name (harness unknown).
	 * Never the operator: that frames the message as the terminal's.
	 */
	senderOf(msg: { fromId: string; fromName: string }): Agent {
		return (
			this.from(msg.fromId, msg.fromName) ?? {
				...this.operator(),
				id: msg.fromId,
				name: msg.fromName,
				harness: "unknown",
				tags: [],
				status: "gone",
				activity: null,
				meta: {},
			}
		);
	}

	/**
	 * The human operator as a sender: `user:<login>`, named "user" (a reserved
	 * name), on the node the request came from. `verified`: the request
	 * carried a passkey session; only then is a send framed as the human
	 * operator's (`[human operator - <name>]`). `name`: from Tailscale.
	 */
	user(login: string, node: string, verified = false, name?: string): Agent {
		const now = Date.now();
		const id = `${USER_PREFIX}${login}`;
		const agent: Agent = {
			id,
			name: "user",
			harness: "user",
			sessionId: null,
			pid: null,
			cwd: null,
			project: null,
			branch: null,
			machine: node,
			tags: ["harness:user"],
			status: "idle",
			model: null,
			activity: `your human operator via Pulsar (${node})`,
			inbound: "accept",
			registered: false,
			reach: "pull",
			lastSeen: now,
			createdAt: this.users.get(id)?.createdAt ?? now,
			meta: {
				operatorName: operatorName(name, login),
				...(verified ? { verified: "1" } : {}),
			},
		};
		this.users.set(id, agent);
		return agent;
	}

	/**
	 * A human sender by id: the operator, or the pool owner (known from an
	 * earlier send, else rebuilt with an unknown node). Null for agent ids.
	 */
	human(id: string): Agent | null {
		if (id === OPERATOR_ID) return this.operator();
		if (!id.startsWith(USER_PREFIX)) return null;
		return (
			this.users.get(id) ?? this.user(id.slice(USER_PREFIX.length), "unknown")
		);
	}

	/**
	 * True only for a pool-owner sender this registry made (from an HTTP user
	 * principal); nothing a socket client registers can pass.
	 */
	isUserSender(agent: Agent): boolean {
		return this.userFraming(agent) === "verified";
	}

	/**
	 * How a send from `agent` is framed: as the user's (a passkey session
	 * backed it), as the app's but unverified, or as an agent's (null).
	 */
	userFraming(agent: Agent): "verified" | "unverified" | null {
		// Only sender objects this registry made for the user (local or a
		// peer's `remoteUser`); nothing an agent registers can be one.
		if (this.users.get(agent.id) !== agent) return null;
		return agent.meta.verified === "1" ? "verified" : "unverified";
	}

	/**
	 * Messages sent by the user with a passkey session. The user's sender
	 * object is replaced on every send, so a message that waits (held, or
	 * queued for a session without pulsar) must carry its own flag: it is
	 * recorded here when the message is first delivered and read when it is
	 * pushed. In memory only: after a restart a waiting user message is
	 * framed as unverified, never the other way round.
	 */
	private verifiedMessages = new Set<string>();

	noteMessageFraming(messageId: string, sender: Agent) {
		if (this.userFraming(sender) !== "verified") return;
		this.verifiedMessages.add(messageId);
		if (this.verifiedMessages.size > 20_000) {
			const oldest = this.verifiedMessages.values().next().value;
			if (oldest !== undefined) this.verifiedMessages.delete(oldest);
		}
	}

	/** The name a verified operator send is tagged with (Tailscale display name, else login). */
	operatorNameOf(sender: Agent): string {
		const login = sender.id.startsWith(USER_PREFIX)
			? sender.id.slice(USER_PREFIX.length)
			: sender.id;
		return operatorName(sender.meta.operatorName, login);
	}

	/** How a message is framed: by its own flag, never by the sender's current state. */
	messageFraming(
		messageId: string,
		sender: Agent,
	): "verified" | "unverified" | null {
		const now = this.userFraming(sender);
		if (now === null) return now;
		return this.verifiedMessages.has(messageId) ? "verified" : "unverified";
	}

	/**
	 * Whoever sent a stored message: an agent, a human, a sender on another
	 * machine (a copy a peer delivered: `<machineId>/<id>`), or undefined.
	 */
	from(id: string, fromName = "unknown"): Agent | undefined {
		const local = this.agents.get(id) ?? this.human(id);
		if (local) return local;
		const parts = splitAddress(id);
		if (!parts || !this.pool) return undefined;
		if (parts.localId.startsWith(USER_PREFIX)) {
			const machine = this.pool.machine(parts.machineId);
			if (!machine) return undefined;
			// The sender as it arrived (its node).
			const seen = this.users.get(id);
			if (seen) return seen;
			return this.remoteUser(
				parts.machineId,
				parts.localId.slice(USER_PREFIX.length),
				this.users.get(id)?.machine ?? machine.name,
			);
		}
		return this.find(id) ?? this.pool.sender(id, fromName) ?? undefined;
	}

	/**
	 * The pool owner as a sender on another node (`<machineId>/user:<login>`).
	 * Only federation makes one, after the home node checked the login; like
	 * `user`, it frames pushes as the user's.
	 */
	remoteUser(machineId: string, login: string, node: string): Agent {
		const id = `${machineId}/${USER_PREFIX}${login}`;
		const now = Date.now();
		const agent: Agent = {
			id,
			name: "user",
			harness: "user",
			sessionId: null,
			pid: null,
			cwd: null,
			project: null,
			branch: null,
			machine: node,
			tags: ["harness:user"],
			status: "idle",
			model: null,
			activity: `your human operator via Pulsar (${node})`,
			inbound: "accept",
			registered: false,
			reach: "pull",
			lastSeen: now,
			createdAt: this.users.get(id)?.createdAt ?? now,
			meta: {
				machineId,
				localId: `${USER_PREFIX}${login}`,
			},
		};
		this.users.set(id, agent);
		return agent;
	}

	/** The agent a caller speaks as; `not_registered` when it has none. */
	self(caller: Caller): Agent {
		const id = agentIdOf(caller.principal);
		const agent = id ? this.agents.get(id) : undefined;
		if (!agent)
			throw new RpcError(
				"not_registered",
				"this connection has not said hello",
			);
		return agent;
	}

	/** Who sends: the caller's agent, or the operator for a plain CLI connection. */
	sender(caller: Caller): Agent {
		if (agentIdOf(caller.principal)) return this.self(caller);
		return this.operator();
	}

	/** One MCP connection owns a session id; a second claimant is refused. */
	checkClaim(caller: Caller, reg: Registration) {
		if (reg.role !== "mcp" || !reg.sessionId) return;
		const id = this.agentId(reg.harness, reg.sessionId, reg.pid);
		if (
			this.sessions
				.forAgent(id)
				.some((c) => c !== caller && this.sessions.role(c) === "mcp")
		) {
			throw new RpcError(
				"session_claimed",
				`${id} is already served by another connection`,
			);
		}
	}

	/** A connection closed: the agent it served may be gone now. */
	detach(caller: Caller, role: Registration["role"] | null) {
		// A CLI call made from inside an agent borrows its identity; it never owns presence.
		const id = agentIdOf(caller.principal);
		if (!id || role === "cli") return;
		const agent = this.agents.get(id);
		if (!agent) return;
		if (this.sessions.forAgent(agent.id).length === 0) {
			// A scanner may still see the session by its pid; otherwise it is gone.
			if (
				!agent.pid ||
				!pidAlive(agent.pid) ||
				!driverFor(agent.harness)?.scan?.tracksPid
			)
				this.markGone(agent);
			agent.registered = false;
		}
		agent.reach = this.reachOf(agent);
	}

	setIdentity(me: Agent, p: Record<string, unknown>) {
		if (typeof p.name === "string" && p.name.trim()) me.meta.nameFrom = "self";
		if (typeof p.name === "string" && p.name.trim())
			me.name = this.uniqueName(slug(p.name.trim()) || me.name, me.id);
		// `machine:` and `needs:` are pulsar's: an agent can neither claim another
		// machine nor say it needs the user, and cannot drop either.
		const add = (Array.isArray(p.tagsAdd) ? p.tagsAdd : [])
			.map(String)
			.map((t) => t.trim())
			.filter((t) => t && !reservedTag(t));
		const remove = new Set(
			(Array.isArray(p.tagsRemove) ? p.tagsRemove : [])
				.map(String)
				.filter((t) => !reservedTag(t)),
		);
		me.tags = [...new Set([...me.tags.filter((t) => !remove.has(t)), ...add])];
		// An agent that moved to another folder or worktree says so; git tags
		// follow. (The service drops a `cwd` that does not exist first.)
		if (typeof p.cwd === "string" && p.cwd.startsWith("/")) {
			const cwd = p.cwd;
			me.cwd = cwd;
			// Never a git call on the request path: the cached answer now (the
			// service warms it first), the fresh one when it arrives.
			const cached = cachedGitInfo(cwd);
			if (cached) this.applyGit(me, cached);
			void gitInfoAsync(cwd, { lane: "user" }).then((git) => {
				// The record now (a scan may have replaced `me`).
				const now = this.agents.get(me.id);
				if (now?.cwd === cwd && now.status !== "gone") this.applyGit(now, git);
			});
		}
		const activity = typeof p.activity === "string" ? p.activity : p.summary;
		if (typeof activity === "string")
			me.activity = activity.slice(0, 500) || null;
		if (typeof p.model === "string" && p.model.trim()) {
			me.model = p.model.trim().slice(0, 120);
			this.finishTags(me);
		}
		if (
			p.inbound === "accept" ||
			p.inbound === "hold" ||
			p.inbound === "refuse"
		) {
			const before = me.inbound;
			me.inbound = p.inbound as InboundPolicy;
			if (before === "hold" && me.inbound === "accept") this.onRelease(me);
		}
		this.store.saveIdentity(
			me.id,
			{
				// Only a chosen name is kept: a harness or default name is re-derived.
				name: me.meta.nameFrom === "self" ? me.name : null,
				// The PR tag pulsar detected is re-detected, not saved as the agent's own.
				tags: me.tags.filter(
					(t) => !isAutoTag(t) && t !== `pr:${me.meta.autoPr}`,
				),
				activity: me.activity,
				inbound: me.inbound,
			},
			Date.now(),
		);
		this.events.emit("agent", { action: "update", agent: toPublic(me) });
		return { agent: toPublic(me) };
	}

	setStatus(agent: Agent, status: AgentStatus) {
		const was = agent.status;
		agent.lastSeen = Date.now();
		if (status === "idle" || status === "unknown") {
			if (this.holdIdle(agent, status, agent.lastSeen)) return;
		} else this.cancelIdle(agent.id);
		agent.status = status;
		this.noteStatus(agent, was);
		if (status === "idle" && was !== "idle") this.waiters.resolveIdle(agent);
	}

	/**
	 * Applies a driver's status reading (`liveStatus`): a change is dated
	 * from when it happened (`since`, e.g. a rollout's turn event), not when
	 * it was read, and announced. A gone or deleted agent is left alone.
	 */
	applyLiveStatus(agent: Agent, status: "busy" | "idle", since: number) {
		if (this.agents.get(agent.id) !== agent || agent.status === "gone") return;
		const at = Math.min(since, Date.now());
		if (status === "busy") this.cancelIdle(agent.id);
		else if (this.holdIdle(agent, status, at)) return;
		const was = agent.status;
		if (was === status) {
			// A turn that ended and a new one that began between two readings.
			if (at > this.statusSince(agent)) {
				this.statusAt.set(agent.id, at);
				this.events.emit("agent", { action: "update", agent: toPublic(agent) });
			}
			return;
		}
		agent.status = status;
		// `unknown` shows as idle, but now we know when it went idle.
		if (was === "unknown") {
			this.statusAt.set(agent.id, at);
			if (status === "busy") this.emitStatus(agent, was, at);
		} else this.noteStatus(agent, was, at);
		if (status === "idle") this.waiters.resolveIdle(agent);
		this.events.emit("agent", { action: "update", agent: toPublic(agent) });
	}
}

/** The status as shown: `unknown` reads as idle. */
const shown = (s: AgentStatus | undefined) => (s === "unknown" ? "idle" : s);

function idleSettleDefault(): number {
	const env = Number(process.env.PULSAR_IDLE_SETTLE_MS);
	return Number.isFinite(env) && env >= 0 && process.env.PULSAR_IDLE_SETTLE_MS
		? env
		: 4000;
}

/** Status tracing for debugging busy/idle (PULSAR_DEBUG_STATUS=1). */
function traceStatus(line: string) {
	if (process.env.PULSAR_DEBUG_STATUS === "1") daemonLog(`status: ${line}`);
}
