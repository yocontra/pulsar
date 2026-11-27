import { conversationTitle } from "../harnesses/acp-session-info.ts";
import type {
	Approval,
	ApprovalState,
	InteractionAnswer,
	InteractionKind,
	Link,
	NeedsYou,
	TurnSummary,
	Wake,
} from "../http/wire.ts";
import { cleanRepoUrl } from "../repo-url.ts";
import { cleanAnswer, cleanPrompt, KINDS } from "../service/interactions.ts";
import { isLocalSubagentId, type PoolMachine } from "../service/pool.ts";
import { clean as cleanText, clip, SUMMARY_MAX } from "../service/push-copy.ts";
import type { Agent, AgentStatus, InboundPolicy } from "../types.ts";
import {
	clean,
	type Digest,
	type FedAgent,
	type FedHello,
} from "./protocol.ts";
import { cleanCounts } from "./subagents.ts";
import type { TailnetNode } from "./tailnet.ts";

/** One linked pulsar node, as this node knows it. */
export interface Peer {
	machineId: string;
	name: string;
	node: TailnetNode;
	hello: FedHello | null;
	/** The protocol version both speak; null when they share none. */
	version: number | null;
	link: Exclude<Link, "local">;
	/** When `link` last changed (ms). */
	linkSince: number;
	/** Last successful exchange in either direction (ms). */
	lastHeard: number;
	failures: number;
	probedAt: number;
	/** The copy of its agents this node holds: from which boot, up to which seq. */
	bootId: string | null;
	seq: number;
	fed: Map<string, FedAgent>;
	agents: Map<string, Agent>;
	digest: Digest | null;
	/** The open `/fed/v1/stream`, if any. */
	stream: AbortController | null;
	/** Last snapshot or delta (ms); an idle stream closes. */
	lastDelta: number;
	nextHeartbeat: number;
	beating: boolean;
	flushing: boolean;
	flushAgain: boolean;
}

const STATUSES = new Set<AgentStatus>(["busy", "idle", "unknown", "gone"]);
const INBOUND = new Set<InboundPolicy>(["accept", "hold", "refuse"]);
const WAKES = new Set<Wake>([
	"wakes",
	"inbox-only",
	"held",
	"refuses",
	"queued",
]);

/** A peer string, cleaned (no control characters); never used for an approval's tool input. */
function text(v: unknown, max: number): string | null {
	return typeof v === "string" ? clean(v, max) : null;
}

/** Agent records one peer may hold here. */
const MAX_AGENTS_PER_PEER = 5000;

/** Names pulsar keeps for humans; a peer's agent never shows as one. */
const RESERVED_NAMES = new Set(["operator", "user", "human", "system"]);

/**
 * A peer's agent record, checked: a malformed one is dropped. The peer is a
 * node of the pool owner, but its records still never carry a `/` in an id
 * (a pool address) or a `needs:` tag (projected from `needsYou`).
 */
export function cleanFedAgent(raw: unknown): FedAgent | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as Record<string, unknown>;
	const id = text(a.id, 300);
	const name = text(a.name, 200);
	const harness = text(a.harness, 60);
	if (
		!id ||
		!name ||
		!harness ||
		(id.includes("/") &&
			!(id.startsWith(`${harness}:`) && isLocalSubagentId(id)))
	)
		return null;
	const status = STATUSES.has(a.status as AgentStatus)
		? (a.status as AgentStatus)
		: "unknown";
	const needs = a.needsYou as Record<string, unknown> | null;
	const needsYou: NeedsYou | null =
		needs && typeof needs === "object"
			? {
					reason:
						needs.reason === "approval" || needs.reason === "terminal"
							? needs.reason
							: "asked",
					since: Number(needs.since) || Date.now(),
					detail: text(needs.detail, 500),
				}
			: null;
	const repoUrl = cleanRepoUrl(a.repoUrl);
	const title = conversationTitle(a.conversationTitle);
	const caps = a.capabilities as Record<string, unknown> | null;
	const capabilities =
		caps && (caps.surface === "managed-acp" || caps.surface === "attached")
			? {
					surface: caps.surface as "managed-acp" | "attached",
					...(typeof caps.host === "string"
						? { host: caps.host.slice(0, 64) }
						: {}),
					status: caps.status === true,
					stop: caps.stop === true,
					inbox: caps.inbox === true,
					wake: caps.wake === true,
					...(typeof caps.steer === "boolean" ? { steer: caps.steer } : {}),
					transcript: caps.transcript === true,
					subagents: caps.subagents === true,
					...(typeof caps.usage === "boolean" ? { usage: caps.usage } : {}),
					...(typeof caps.attachments === "boolean"
						? { attachments: caps.attachments }
						: {}),
					...(typeof caps.questions === "boolean"
						? { questions: caps.questions }
						: {}),
					...(typeof caps.approvals === "boolean"
						? { approvals: caps.approvals }
						: {}),
					...(typeof caps.skills === "boolean" ? { skills: caps.skills } : {}),
					...(typeof caps.commands === "boolean"
						? { commands: caps.commands }
						: {}),
					...(typeof caps.modes === "boolean" ? { modes: caps.modes } : {}),
					...(typeof caps.resume === "boolean" ? { resume: caps.resume } : {}),
				}
			: undefined;
	return {
		id,
		name,
		harness,
		project: text(a.project, 200),
		branch: text(a.branch, 300),
		...(repoUrl ? { repoUrl } : {}),
		machine: text(a.machine, 100) ?? undefined,
		tags: Array.isArray(a.tags)
			? a.tags
					.filter((t): t is string => typeof t === "string")
					.filter((t) => !t.startsWith("needs:"))
					.slice(0, 100)
					.map((t) => t.slice(0, 200))
			: [],
		status,
		model: text(a.model, 120),
		...(title ? { conversationTitle: title } : {}),
		activity: text(a.activity, 500),
		inbound: INBOUND.has(a.inbound as InboundPolicy)
			? (a.inbound as InboundPolicy)
			: "accept",
		registered: a.registered === true,
		reach: a.reach === "push" ? "push" : "pull",
		...(a.sessionFrom === "folder" ? { sessionFrom: "folder" as const } : {}),
		lastSeen: Number(a.lastSeen) || 0,
		createdAt: Number(a.createdAt) || 0,
		...(Number(a.statusSince) > 0
			? { statusSince: Number(a.statusSince) }
			: {}),
		needsYou,
		...(capabilities ? { capabilities } : {}),
		wake: WAKES.has(a.wake as Wake) ? (a.wake as Wake) : "inbox-only",
		hasTranscript: a.hasTranscript === true,
		canStop: a.canStop === true,
		...subagentCounts(a.subagents),
		approvals: Array.isArray(a.approvals)
			? a.approvals
					.slice(0, 50)
					.map((x) => cleanApproval(x, id))
					.filter((x): x is Approval => x !== null)
			: [],
		...turnOf(a.turn),
	};
}

/** A shared last turn, checked; dropped when malformed. */
function turnOf(raw: unknown): { turn?: FedAgent["turn"] } {
	const t = raw as Record<string, unknown> | null;
	if (!t || typeof t !== "object") return {};
	const at = Number(t.at);
	if (!(at > 0) || (t.kind !== "finished" && t.kind !== "failed")) return {};
	const summary = summaryOf(t.summary);
	return { turn: { kind: t.kind, at, ...(summary ? { summary } : {}) } };
}

/** A peer's turn summary: bounded, and redacted again here. */
function summaryOf(raw: unknown): TurnSummary | null {
	const s = raw as Record<string, unknown> | null;
	if (!s || typeof s !== "object") return null;
	const out: TurnSummary = {};
	const text = (v: unknown) =>
		typeof v === "string"
			? clip(cleanText(v.slice(0, 4 * SUMMARY_MAX)), SUMMARY_MAX)
			: "";
	const said = text(s.text);
	if (said) out.text = said;
	const error = text(s.error);
	if (error) out.error = error;
	const startedAt = Number(s.startedAt);
	if (Number.isFinite(startedAt) && startedAt > 0) out.startedAt = startedAt;
	const files = Number(s.files);
	if (Number.isInteger(files) && files > 0 && files <= 100_000)
		out.files = files;
	return Object.keys(out).length ? out : null;
}

/** A remote turn older than this when it first arrives is not announced (a long-offline peer). */
const TURN_FRESH_MS = 10 * 60_000;

const APPROVAL_STATES = new Set<ApprovalState>([
	"pending",
	"allowed",
	"denied",
	"answered-locally",
	"expired",
]);

/** A shared prompt, checked; dropped when malformed. Its agent is the record's. */
function cleanApproval(raw: unknown, agentId: string): Approval | null {
	if (!raw || typeof raw !== "object") return null;
	const x = raw as Record<string, unknown>;
	const requestId = text(x.requestId, 200);
	const tool = text(x.tool, 200);
	const inputHash = text(x.inputHash, 128);
	if (
		!requestId ||
		requestId.includes("/") ||
		!tool ||
		!inputHash ||
		!x.input ||
		typeof x.input !== "object" ||
		Array.isArray(x.input) ||
		JSON.stringify(x.input).length > 256 * 1024 ||
		!APPROVAL_STATES.has(x.state as ApprovalState)
	)
		return null;
	const kind = KINDS.includes(x.kind as InteractionKind)
		? (x.kind as InteractionKind)
		: "permission";
	const prompt = kind === "permission" ? null : cleanPrompt(x.prompt);
	// An interaction whose prompt can't be read can't be answered: drop it.
	if (kind !== "permission" && (!prompt || prompt.kind !== kind)) return null;
	let answer: InteractionAnswer | null = null;
	if (prompt && x.answer)
		try {
			answer = cleanAnswer(x.answer, prompt);
		} catch {}
	return {
		requestId,
		kind,
		...(x.readOnly === true ? { readOnly: true as const } : {}),
		...(prompt ? { prompt } : {}),
		...(answer ? { answer } : {}),
		agentId,
		machine: text(x.machine, 100) ?? "",
		tool,
		input: x.input as Record<string, unknown>,
		inputHash,
		cwd: text(x.cwd, 1000),
		branch: text(x.branch, 300),
		createdAt: Number(x.createdAt) || 0,
		expiresAt: Number(x.expiresAt) || 0,
		state: x.state as ApprovalState,
		sessionRules: Array.isArray(x.sessionRules)
			? x.sessionRules.map(String).slice(0, 50)
			: null,
		...(typeof x.outcome === "string"
			? { outcome: x.outcome.slice(0, 300) }
			: {}),
	};
}

function toAgent(peer: Peer, f: FedAgent): Agent {
	return {
		id: `${peer.machineId}/${f.id}`,
		name: RESERVED_NAMES.has(f.name.toLowerCase()) ? `${f.name}-agent` : f.name,
		harness: f.harness,
		...(f.capabilities ? { capabilities: f.capabilities } : {}),
		sessionId: null,
		pid: null,
		cwd: null,
		project: f.project,
		branch: f.branch,
		...(f.repoUrl ? { repoUrl: f.repoUrl } : {}),
		// Always the peer's own name: a peer can't pose as another machine.
		machine: peer.name,
		tags: [
			...f.tags.filter((t) => !t.startsWith("machine:")),
			`machine:${peer.name}`,
		],
		status: f.status,
		model: f.model,
		activity: f.activity,
		inbound: f.inbound,
		registered: f.registered,
		reach: f.reach,
		lastSeen: f.lastSeen,
		createdAt: f.createdAt,
		meta: {
			machineId: peer.machineId,
			localId: f.id,
			...(f.conversationTitle ? { acpTitle: f.conversationTitle } : {}),
		},
	};
}

function ago(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 60) return `${Math.max(m, 1)}m`;
	const h = Math.round(m / 60);
	return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/**
 * Every peer and its agents, in memory. `version` bumps on any change, so
 * the registry's name cache and the app's live views know to recompute.
 */
export class PoolState {
	readonly peers = new Map<string, Peer>();
	/** Tailnet node id → machine id. */
	readonly byNode = new Map<string, string>();
	private v = 0;
	private flat: { v: number; list: Agent[] } | null = null;
	private addresses = new Map<string, FedAgent>();
	onChange: (machineId: string | null) => void = () => {};
	/** A remote agent finished its turn (busy → idle): `wait idle:` resolves. */
	onIdle: (address: string) => void = () => {};
	/** A remote prompt appeared or changed (pool-address ids): SSE and push follow. */
	onApproval: (approval: Approval) => void = () => {};
	/**
	 * A remote agent's turn ended (its home node's newer `turn`): never for
	 * an agent this node had not seen before, nor for a stale record.
	 */
	onTurn: (address: string, turn: NonNullable<FedAgent["turn"]>) => void =
		() => {};
	/** Pool-address prompt id → its agent's pool address. */
	private approvalAgent = new Map<string, string>();

	version() {
		return this.v;
	}

	bump(machineId: string | null) {
		this.v++;
		this.onChange(machineId);
	}

	/** Adds or refreshes a peer from its hello; a node that came back under a new id replaces the old one. */
	upsert(node: TailnetNode, hello: FedHello, version: number | null): Peer {
		const oldId = this.byNode.get(node.nodeId);
		if (oldId && oldId !== hello.machineId) this.remove(oldId);
		let peer = this.peers.get(hello.machineId);
		if (!peer) {
			peer = {
				machineId: hello.machineId,
				name: hello.name,
				node,
				hello,
				version,
				link: "daemon-down",
				linkSince: Date.now(),
				lastHeard: 0,
				failures: 0,
				probedAt: 0,
				bootId: null,
				seq: 0,
				fed: new Map(),
				agents: new Map(),
				digest: null,
				stream: null,
				lastDelta: 0,
				nextHeartbeat: 0,
				beating: false,
				flushing: false,
				flushAgain: false,
			};
			this.peers.set(peer.machineId, peer);
		}
		if (peer.node.nodeId !== node.nodeId) this.byNode.delete(peer.node.nodeId);
		peer.node = node;
		// A new Pulsar version is a pool change too (Diagnostics checks again).
		const upgraded =
			!!peer.hello && peer.hello.pulsarVersion !== hello.pulsarVersion;
		peer.hello = hello;
		peer.version = version;
		if (peer.name !== hello.name) {
			peer.name = hello.name;
			this.bump(peer.machineId);
		} else if (upgraded) this.bump(peer.machineId);
		this.byNode.set(node.nodeId, peer.machineId);
		return peer;
	}

	/** A peer remembered from an earlier run, known only by name until discovery finds it. */
	remember(p: {
		machineId: string;
		name: string;
		node: string | null;
		dnsName: string | null;
		port?: number | null;
	}): Peer | null {
		if (this.peers.has(p.machineId) || !p.node || !p.dnsName) return null;
		const peer = this.upsert(
			{
				nodeId: p.node,
				name: p.name,
				dnsName: p.dnsName,
				userId: null,
				login: null,
				tags: [],
				online: false,
				...(p.port ? { port: p.port } : {}),
			},
			{
				fedProtocol: [0, 0],
				features: [],
				pulsarVersion: "",
				machineId: p.machineId,
				name: p.name,
			},
			null,
		);
		peer.hello = null;
		peer.link = "asleep";
		peer.linkSince = Date.now();
		return peer;
	}

	remove(machineId: string) {
		const peer = this.peers.get(machineId);
		if (!peer) return;
		peer.stream?.abort();
		this.peers.delete(machineId);
		if (this.byNode.get(peer.node.nodeId) === machineId)
			this.byNode.delete(peer.node.nodeId);
		for (const id of peer.agents.keys())
			this.addresses.delete(`${machineId}/${id}`);
		for (const f of peer.fed.values()) this.forgetApprovals(machineId, f);
		this.bump(machineId);
	}

	/** Drops the routes of `f`'s prompts that `now` no longer has (all of them without `now`). */
	private forgetApprovals(machineId: string, f?: FedAgent, now?: FedAgent) {
		if (!f?.approvals?.length) return;
		const still = new Set((now?.approvals ?? []).map((x) => x.requestId));
		for (const x of f.approvals)
			if (!still.has(x.requestId))
				this.approvalAgent.delete(`${machineId}/${x.requestId}`);
	}

	setLink(peer: Peer, link: Peer["link"]) {
		if (peer.link === link) return false;
		peer.link = link;
		peer.linkSince = Date.now();
		this.bump(peer.machineId);
		return true;
	}

	/** Replaces a peer's agents with a snapshot. */
	snapshot(peer: Peer, bootId: string, seq: number, agents: unknown[]) {
		for (const id of peer.agents.keys())
			this.addresses.delete(`${peer.machineId}/${id}`);
		// Compared against the copy held before: prompts still pending don't
		// push again, and busy→idle inside a snapshot still wakes waiters.
		const before = new Map(peer.fed);
		peer.fed.clear();
		peer.agents.clear();
		for (const raw of agents) this.put(peer, raw, before);
		for (const [id, f] of before)
			if (!peer.fed.has(id)) this.forgetApprovals(peer.machineId, f);
		peer.bootId = bootId;
		peer.seq = seq;
		this.bump(peer.machineId);
	}

	/** Applies one delta; false when it does not follow the copy held (a gap). */
	delta(
		peer: Peer,
		bootId: string,
		seq: number,
		upserts: unknown[],
		removes: unknown[],
	): boolean | "stale" {
		if (bootId === peer.bootId && seq <= peer.seq) return "stale";
		if (bootId !== peer.bootId || seq !== peer.seq + 1) return false;
		for (const raw of upserts) this.put(peer, raw);
		for (const id of removes) {
			if (typeof id !== "string") continue;
			this.forgetApprovals(peer.machineId, peer.fed.get(id));
			peer.fed.delete(id);
			peer.agents.delete(id);
			this.addresses.delete(`${peer.machineId}/${id}`);
		}
		peer.seq = seq;
		this.bump(peer.machineId);
		return true;
	}

	private put(
		peer: Peer,
		raw: unknown,
		held: Map<string, FedAgent> = peer.fed,
	) {
		const f = cleanFedAgent(raw);
		if (!f) return;
		// Bounded: a peer can't fill this node's memory with agent records.
		if (!peer.fed.has(f.id) && peer.fed.size >= MAX_AGENTS_PER_PEER) return;
		const prev = held.get(f.id);
		const before = prev?.status;
		const address = `${peer.machineId}/${f.id}`;
		if (before && before !== "idle" && f.status === "idle")
			queueMicrotask(() => this.onIdle(address));
		const turn = f.turn;
		if (
			prev &&
			turn &&
			turn.at > (prev.turn?.at ?? 0) &&
			Date.now() - turn.at < TURN_FRESH_MS
		)
			queueMicrotask(() => this.onTurn(address, turn));
		const seen = new Map(
			(prev?.approvals ?? []).map((x) => [
				x.requestId,
				`${x.state}|${x.outcome ?? ""}`,
			]),
		);
		for (const x of f.approvals ?? []) {
			const qid = `${peer.machineId}/${x.requestId}`;
			this.approvalAgent.set(qid, address);
			if (seen.get(x.requestId) !== `${x.state}|${x.outcome ?? ""}`) {
				const shown = this.qualify(peer.machineId, x);
				queueMicrotask(() => this.onApproval(shown));
			}
		}
		this.forgetApprovals(peer.machineId, prev, f);
		peer.fed.set(f.id, f);
		peer.agents.set(f.id, toAgent(peer, f));
		this.addresses.set(`${peer.machineId}/${f.id}`, f);
	}

	/** A remote prompt with pool-address ids, the way this node shows it. */
	private qualify(machineId: string, x: Approval): Approval {
		return {
			...x,
			requestId: `${machineId}/${x.requestId}`,
			agentId: `${machineId}/${x.agentId}`,
		};
	}

	/** The shared record of a remote prompt (home-node ids) and its machine. */
	approvalRecord(id: string): { machineId: string; a: Approval } | null {
		const address = this.approvalAgent.get(id);
		if (!address) return null;
		const f = this.addresses.get(address);
		const slash = id.indexOf("/");
		const homeId = id.slice(slash + 1);
		const a = f?.approvals?.find((x) => x.requestId === homeId);
		return a ? { machineId: id.slice(0, slash), a } : null;
	}

	approval(id: string): Approval | null {
		const r = this.approvalRecord(id);
		return r ? this.qualify(r.machineId, r.a) : null;
	}

	/** A remote agent's pending prompts, oldest first. */
	pendingApprovals(address: string): Approval[] {
		const machineId = address.slice(0, address.indexOf("/"));
		return (this.addresses.get(address)?.approvals ?? [])
			.filter((x) => x.state === "pending")
			.map((x) => this.qualify(machineId, x));
	}

	agents(): Agent[] {
		if (this.flat?.v === this.v) return this.flat.list;
		const list: Agent[] = [];
		for (const peer of this.peers.values())
			for (const a of peer.agents.values()) list.push(a);
		this.flat = { v: this.v, list };
		return list;
	}

	get(address: string): Agent | undefined {
		const slash = address.indexOf("/");
		const peer = this.peers.get(address.slice(0, slash));
		return peer?.agents.get(address.slice(slash + 1));
	}

	fedAgent(address: string): FedAgent | undefined {
		return this.addresses.get(address);
	}

	machine(peer: Peer, now = Date.now()): PoolMachine {
		const base: PoolMachine = {
			machineId: peer.machineId,
			name: peer.name,
			link: peer.link,
			linkSince: peer.linkSince,
			agents: [...peer.agents.keys()].filter((id) => !isLocalSubagentId(id))
				.length,
		};
		if (peer.link === "asleep")
			return {
				...base,
				reason: peer.lastHeard
					? `asleep ${ago(now - peer.lastHeard)}`
					: "asleep",
			};
		if (peer.link === "daemon-down")
			return { ...base, reason: `Pulsar on ${peer.name} is not answering` };
		if (peer.link === "upgrade")
			return {
				...base,
				reason: upgradeReason(peer, this.selfName, this.selfProtocol),
			};
		return base;
	}

	/** This node's name, for "upgrade pulsar on <this machine>". */
	selfName = "this machine";
	selfProtocol: [number, number] = [1, 1];
}

/** Which side has to upgrade: the one with the older protocol. */
export function upgradeReason(
	peer: Peer,
	selfName: string,
	ours?: [number, number],
) {
	const theirs = peer.hello?.fedProtocol;
	const mine = ours ?? [1, 1];
	if (theirs && theirs[0] > mine[1]) return `upgrade Pulsar on ${selfName}`;
	return `upgrade Pulsar on ${peer.name}`;
}

/** `FedAgent.subagents` from a peer: only well-formed counts above zero. */
function subagentCounts(v: unknown) {
	const c = cleanCounts(v);
	return c ? { subagents: c } : {};
}
