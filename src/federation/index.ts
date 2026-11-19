import type { Identity } from "../http/identity.ts";
import type {
	AskRequest,
	AskResponse,
	DecideResponse,
	MessageHit,
	NeedsYou,
	SubagentCounts,
	SubagentList,
	Wake,
} from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { RelayedAct } from "../service/acting.ts";
import { ATTACH_LIMITS } from "../service/attachments.ts";
import { authorize } from "../service/authorize.ts";
import type { Principal } from "../service/caller.ts";
import { principalLabel } from "../service/caller.ts";
import type { PulsarService } from "../service/index.ts";
import type { LaunchRead } from "../service/launch.ts";
import { INTERVALS, LIMITS } from "../service/limits.ts";
import {
	isLocalSubagentId,
	type PoolMachine,
	type PoolView,
	type RemoteApprovals,
} from "../service/pool.ts";
import { delivered, writeReceipt } from "../service/util.ts";
import type { Agent, Message, Receipt, ReceiptState } from "../types.ts";
import { RECEIPT_STATES as ALL_RECEIPT_STATES } from "../types.ts";
import { USAGE_PERIODS } from "../usage/index.ts";
import { VERSION } from "../version.ts";
import { RemoteAttachmentsRelay } from "./attachments.ts";
import { RemoteChangesReader } from "./changes.ts";
import { LocalFeed } from "./local.ts";
import { isOwner, type PoolMembers } from "./members.ts";
import {
	clean,
	DEFAULT_FED_PORT,
	type Digest,
	FED_FEATURES,
	FED_HEADER,
	FED_PORT_HEADER,
	FED_PROTOCOL,
	type FedAction,
	type FedAgent,
	type FedHello,
	type FedOrigin,
	type FedReceipt,
	type FedSender,
	type FrameResult,
	fedReceipt,
	negotiate,
	parseHello,
	portOf,
	RECEIPTS2,
	type UpFrame,
} from "./protocol.ts";
import { readSse, sseStream } from "./sse.ts";
import { type Peer, PoolState, upgradeReason } from "./state.ts";
import { cleanSubagentList } from "./subagents.ts";
import {
	type Tailnet,
	type TailnetNode,
	type TailnetStatus,
	tailnetRpId,
} from "./tailnet.ts";
import { RemoteTranscriptReader } from "./transcripts.ts";
import { RemoteUsage } from "./usage.ts";

export type { Tailnet, TailnetNode, TailnetStatus } from "./tailnet.ts";

export interface FederationIntervals {
	/** How often `tailscale status` is read for new or vanished peers. */
	discoverMs: number;
	/** Heartbeat (digest gossip) period per peer, jittered ±20%. */
	heartbeatMs: number;
	/** Heartbeats missed before a peer counts as unreachable. */
	missed: number;
	/** How often this node's own agents are diffed into a delta. */
	coalesceMs: number;
	/** A registry stream with no delta for this long closes (lazy links). */
	linkIdleMs: number;
	outboxTickMs: number;
	receiptTickMs: number;
	/** A queued message for a peer that stays away this long fails. */
	outboxExpiryMs: number;
	/** Peers are probed again this often (version, name). */
	reprobeMs: number;
	requestTimeoutMs: number;
	/** How long Ask waits for each peer before answering without it. */
	askTimeoutMs: number;
	/** Messages a minute one peer may deliver here. */
	peerSendsPerMinute: number;
}

const FED_INTERVALS: FederationIntervals = {
	discoverMs: 30_000,
	heartbeatMs: 10_000,
	missed: 3,
	coalesceMs: 500,
	linkIdleMs: 120_000,
	outboxTickMs: 1000,
	receiptTickMs: 500,
	outboxExpiryMs: 24 * 3600_000,
	reprobeMs: 10 * 60_000,
	requestTimeoutMs: 10_000,
	askTimeoutMs: 1500,
	peerSendsPerMinute: 600,
};

/** A `/fed` stream this node serves, and who it was opened for. */
interface ServedStream {
	who: Identity;
	machineId: string;
	/** Opened with the user role (approvals, transcripts, changes). */
	asOwner: boolean;
	end: () => void;
}

export interface FederationOptions {
	tailnet: Tailnet;
	/** The pool owner's login; read from the tailnet's self node by default. */
	owner?: string;
	/**
	 * The owner's user id; read from the self node when it is the owner's.
	 * Ownership needs both (logins can repeat on a self-hosted server).
	 */
	ownerId?: string;
	/** The port this node serves on (sent in hello; tried on peers after their bound port). */
	port?: number;
	/** Protocol range to speak (tests simulate a skewed peer). */
	protocol?: [number, number];
	/** The WebAuthn RP id; derived from this node's MagicDNS name by default. */
	rpId?: string;
	/** Who may be in the pool; the service's (the store's) by default. */
	members?: PoolMembers;
	intervals?: Partial<FederationIntervals>;
	/** Deltas kept for replay; an older `since` gets a snapshot. */
	feedLog?: number;
	/** Hello features to announce (tests simulate a peer without `receipts2`). */
	features?: string[];
	log?: (line: string) => void;
}

const MAX_BATCH_BYTES = 8 * 1024 * 1024;
const MAX_STREAMS_PER_PEER = 4;
const MAX_TRANSCRIPTS_PER_PEER = 16;
/** Forwarded actions one peer may run here a minute. */
const ACTS_PER_MINUTE = 600;

/** A request body as text, or null once it passes `max` bytes (read as it streams, never whole). */
async function readCapped(req: Request, max: number): Promise<string | null> {
	if (Number(req.headers.get("content-length") ?? 0) > max) return null;
	if (!req.body) return "";
	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/** Receipt states that end a delivery attempt (no retry). */
const PERMANENT = new Set([
	"rate_limited",
	"forbidden",
	"bad_request",
	"unsupported",
]);

const RECEIPT_STATES = new Set<ReceiptState>(ALL_RECEIPT_STATES);

function jitter(ms: number) {
	return Math.round(ms * (0.8 + Math.random() * 0.4));
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": "no-store",
		},
	});
}

function refuse(status: number, code: string, message: string) {
	return json({ error: { code, message } }, status);
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function fail(code: string, message: string): FrameResult {
	return { ok: false, code, message };
}

/**
 * The pool: links this daemon to every other pulsar node of the same
 * Tailscale user (and allowed tagged nodes), shares its own agents with
 * them, holds theirs in memory, carries messages and receipts between them,
 * and forwards user actions to an agent's home node.
 *
 * It is the service's `PoolView`, and its `handle` serves `/fed/v1` on the
 * daemon's HTTPS server.
 */
/** How long a relayed acting op (commit, push, PR, launch, upload) may run on the home node. */
const ACTING_RUN_TIMEOUT_MS = 180_000;

export class Federation implements PoolView {
	readonly state = new PoolState();
	readonly feed: LocalFeed;
	readonly transcripts: RemoteTranscriptReader;
	readonly changes: RemoteChangesReader;
	readonly usage: RemoteUsage;
	readonly attachments: RemoteAttachmentsRelay;
	/** Prompts of remote agents: shared in their records, decided by their home node. */
	readonly approvals: RemoteApprovals = {
		approval: (id) => this.state.approval(id),
		pendingFor: (address) => this.state.pendingApprovals(address),
		options: async (as, id, decision, note, answer) => {
			const rec = this.state.approvalRecord(id);
			if (!rec) throw new RpcError("not_found", "no such approval");
			const r = await this.act(
				`${rec.machineId}/`,
				{
					op: "approval.options",
					id: rec.a.requestId,
					decision,
					...(note ? { note } : {}),
					...(answer ? { answer } : {}),
				},
				as,
			);
			if (r.register === true) return { register: true as const };
			if (!r.options || typeof r.options !== "object")
				throw new RpcError("unreachable", "the home node sent no options");
			return { options: r.options };
		},
		decide: async (as, id, decision, note, assertion, answer) => {
			const rec = this.state.approvalRecord(id);
			if (!rec) throw new RpcError("not_found", "no such approval");
			const r = await this.act(
				`${rec.machineId}/`,
				{
					op: "approval.decide",
					id: rec.a.requestId,
					decision,
					note,
					assertion,
					...(answer ? { answer } : {}),
				},
				as,
			);
			const res = r.response as DecideResponse | undefined;
			if (!res || typeof res.won !== "boolean" || !res.approval)
				throw new RpcError("unreachable", "the home node sent no decision");
			return {
				won: res.won,
				approval: {
					...res.approval,
					requestId: id,
					agentId: `${rec.machineId}/${res.approval.agentId}`,
				},
			};
		},
	};
	private readonly service: PulsarService;
	private readonly tailnet: Tailnet;
	private readonly protocol: [number, number];
	/** Hello features (tests simulate an older peer). */
	private readonly features: string[];
	private readonly port: number;
	readonly members: PoolMembers;
	private readonly iv: FederationIntervals;
	private readonly log: (line: string) => void;
	private owner: string | null;
	private ownerId: string | null;
	private self: TailnetStatus["self"] | null = null;
	private readonly rpIdOverride: string | null;
	private timers: NodeJS.Timeout[] = [];
	private stopped = false;
	private discovering: Promise<void> | null = null;
	/** Nodes that failed a probe (no pulsar there): retry after a growing wait. */
	private probeBackoff = new Map<string, { until: number; n: number }>();
	private probing = new Map<string, Promise<Peer | null>>();
	private rate = new Map<string, number[]>();
	/** Open `/fed` streams by `stream:<machineId>` / `transcript:<machineId>`. */
	private openStreams = new Map<string, number>();
	/** A receipt pass is running (`receiptTick`). */
	private sendingReceipts = false;
	/** Streams this node serves, re-checked when the pool changes. */
	private served = new Set<ServedStream>();
	/** Gaps in a row per peer (backoff before the next snapshot). */
	private gaps = new Map<string, number>();
	/** Last inline probe (a not-yet-linked node called) per node id. */
	private inlineProbes = new Map<string, number>();
	/** Last time a machine-id conflict was announced, by node>machine id. */
	private conflicts = new Map<string, number>();

	constructor(service: PulsarService, opts: FederationOptions) {
		this.service = service;
		this.tailnet = opts.tailnet;
		this.protocol = opts.protocol ?? FED_PROTOCOL;
		this.features = opts.features ?? FED_FEATURES;
		this.port = opts.port ?? DEFAULT_FED_PORT;
		this.members = opts.members ?? service.poolMembers;
		this.rpIdOverride = opts.rpId ?? null;
		this.iv = { ...FED_INTERVALS, ...opts.intervals };
		this.log = opts.log ?? (() => {});
		// A tagged node has no user: its owner is set with `pulsar mesh owner`.
		this.owner = opts.owner ?? this.members.owner ?? null;
		this.ownerId = opts.ownerId ?? null;
		service.poolStatus = () => this.tailnet.status();
		service.onPoolForget = (machineId) => {
			this.state.remove(machineId);
			this.recheckServed();
		};
		service.onPoolChange = () => this.recheckServed();
		this.feed = new LocalFeed(service, opts.feedLog);
		this.transcripts = new RemoteTranscriptReader(this);
		this.changes = new RemoteChangesReader(this);
		this.usage = new RemoteUsage(this);
		this.attachments = new RemoteAttachmentsRelay(this);
		this.state.selfProtocol = this.protocol;
		this.state.onApproval = (approval) =>
			this.service.events.emit("approval", { approval });
		this.state.onTurn = (address, turn) =>
			this.service.events.emit("agent:turn", { agentId: address, ...turn });
		this.state.onIdle = (address) => {
			const agent = this.service.registry.find(address);
			if (agent) this.service.waiters.resolveIdle(agent);
		};
		this.state.onChange = (machineId) =>
			this.service.events.emit("pool", { machineId });
	}

	get machineId(): string {
		return this.service.machineId;
	}

	/** The pool owner's login, once known. */
	get ownerLogin(): string | null {
		return this.owner;
	}

	/** This node's machine name. */
	get nodeName(): string {
		return this.service.machine;
	}

	/** Joins the service and starts discovery, heartbeats and the outbox. */
	async start() {
		for (const p of this.service.store.peers()) this.state.remember(p);
		this.state.selfName = this.service.machine;
		this.service.attachPool(this);
		this.feed.tick();
		const every = (ms: number, fn: () => void) => {
			const t = setInterval(fn, ms);
			t.unref?.();
			this.timers.push(t);
		};
		every(this.iv.coalesceMs, () => this.tick());
		every(this.iv.discoverMs, () =>
			this.discover().catch((e) =>
				this.log(`discovery failed: ${(e as Error).message}`),
			),
		);
		every(this.iv.outboxTickMs, () => this.outboxTick());
		every(this.iv.discoverMs, () => this.forgetStale());
		every(this.iv.receiptTickMs, () =>
			this.receiptTick().catch((e) =>
				this.log(`receipts failed: ${(e as Error).message}`),
			),
		);
		await this.discover();
	}

	/**
	 * Drops per-node bookkeeping that no longer decides anything: inline
	 * probe stamps past their 10 s, conflict stamps past their hour, and
	 * probe backoffs an hour past their window (a node that left the
	 * tailnet; one that comes back starts its backoff again).
	 */
	private forgetStale(now = Date.now()) {
		for (const [id, at] of this.inlineProbes)
			if (now - at > 10_000) this.inlineProbes.delete(id);
		for (const [key, at] of this.conflicts)
			if (now - at > 3600_000) this.conflicts.delete(key);
		for (const [id, b] of this.probeBackoff)
			if (now - b.until > 3600_000) this.probeBackoff.delete(id);
	}

	stop() {
		this.stopped = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		for (const peer of this.state.peers.values()) peer.stream?.abort();
		for (const s of this.served) s.end();
		this.served.clear();
		this.transcripts.close();
		this.changes.close();
		this.service.attachPool(null);
	}

	// --- PoolView ---

	agents(): Agent[] {
		return this.state.agents();
	}

	get(address: string): Agent | undefined {
		return this.state.get(address);
	}

	needsYou(address: string): NeedsYou | null {
		return this.state.fedAgent(address)?.needsYou ?? null;
	}

	wake(address: string): Wake | null {
		return this.state.fedAgent(address)?.wake ?? null;
	}

	statusSince(address: string): number | null {
		return this.state.fedAgent(address)?.statusSince ?? null;
	}

	hasTranscript(address: string): boolean {
		return this.state.fedAgent(address)?.hasTranscript ?? false;
	}

	canStop(address: string): boolean {
		return this.state.fedAgent(address)?.canStop === true;
	}

	subagentCounts(address: string): SubagentCounts | null {
		return this.state.fedAgent(address)?.subagents ?? null;
	}

	/** A remote agent's subagents, from its home node, as the original user. */
	async subagents(address: string, as?: Principal): Promise<SubagentList> {
		const slash = address.indexOf("/");
		const localId = address.slice(slash + 1);
		const r = await this.act(
			address,
			{ op: "subagents.list", agent: localId },
			as,
		);
		return cleanSubagentList(r.list, address.slice(0, slash), localId);
	}

	/** A local subagent that takes messages directly, as a delivery target. */
	private async subagentTarget(id: string): Promise<Agent | undefined> {
		if (!isLocalSubagentId(id)) return undefined;
		const row = await this.service.subagents.row(id);
		return row ? this.service.subagents.deliveryTarget(row) : undefined;
	}

	/** A local agent, or a local subagent id (the transcript code finds it or says not_found). */
	private knows(id: string): boolean {
		return Boolean(this.service.registry.get(id)) || isLocalSubagentId(id);
	}

	async ask(q: AskRequest, as?: Principal) {
		const peers = [...this.state.peers.values()].filter(
			(p) => p.link === "tailnet",
		);
		const answers: { machineId: string; response: AskResponse }[] = [];
		const missing: string[] = [];
		await Promise.all(
			peers.map(async (peer) => {
				try {
					const r = await this.act(
						`${peer.machineId}/`,
						{
							op: "ask",
							question: q.question,
							...(q.selector ? { selector: q.selector } : {}),
						},
						as,
						this.iv.askTimeoutMs,
					);
					const response = r.response as AskResponse | undefined;
					if (!response || !Array.isArray(response.matches))
						throw new Error("no answer");
					answers.push({ machineId: peer.machineId, response });
				} catch {
					missing.push(peer.name);
				}
			}),
		);
		return { answers, missing };
	}

	/** Message search on every reachable peer, each over its own agents. */
	async searchMessages(q: string, limit: number, as?: Principal) {
		const peers = [...this.state.peers.values()].filter(
			(p) => p.link === "tailnet",
		);
		const answers: { machineId: string; hits: MessageHit[] }[] = [];
		const missing: string[] = [];
		await Promise.all(
			peers.map(async (peer) => {
				try {
					const r = await this.act(
						`${peer.machineId}/`,
						{ op: "search.messages", q, limit },
						as,
						this.iv.askTimeoutMs,
					);
					if (!Array.isArray(r.hits)) throw new Error("no answer");
					answers.push({
						machineId: peer.machineId,
						hits: r.hits as MessageHit[],
					});
				} catch (e) {
					// An older node has no message search: it is not missing.
					if (
						e instanceof RpcError &&
						(e.code === "unsupported" || e.code === "bad_request")
					)
						return;
					missing.push(peer.name);
				}
			}),
		);
		return { answers, missing };
	}

	/** Relayed Stop, step 1: the agent's home node issues a challenge for this Stop. */
	async stopOptions(address: string, as: Principal): Promise<unknown> {
		if (as.kind !== "human")
			throw new RpcError(
				"forbidden",
				"only the human operator stops agents on other machines",
			);
		const localId = address.slice(address.indexOf("/") + 1);
		const r = await this.act(
			address,
			{ op: "stop.options", agent: localId },
			as,
		);
		return r.options;
	}

	/** Relayed Stop, step 2: the browser's assertion, verified by the home node. */
	async stopAgent(
		address: string,
		as: Principal,
		assertion?: unknown,
	): Promise<unknown> {
		if (as.kind !== "human")
			throw new RpcError(
				"forbidden",
				"only the human operator stops agents on other machines",
			);
		if (assertion === undefined)
			throw new RpcError(
				"session_required",
				"stopping an agent on another machine needs Face ID / Touch ID for that Stop",
			);
		const localId = address.slice(address.indexOf("/") + 1);
		const r = await this.act(
			address,
			{ op: "stop", agent: localId, assertion },
			as,
		);
		return r.result;
	}

	/** Relayed acting op, step 1: the home node's challenge for this exact act. */
	async actingOptions(
		machineId: string,
		act: RelayedAct,
		as: Principal,
	): Promise<unknown> {
		const r = await this.act(
			`${machineId}/`,
			{
				op: "acting.options",
				name: act.op,
				agent: act.agent,
				params: act.params,
			},
			as,
		);
		return r.options;
	}

	/** Relayed acting op, step 2: the home node verifies the assertion, then runs it. */
	async acting(
		machineId: string,
		act: RelayedAct & { assertion: unknown },
		as: Principal,
	): Promise<unknown> {
		const r = await this.act(
			`${machineId}/`,
			{
				op: "acting.run",
				name: act.op,
				agent: act.agent,
				params: act.params,
				assertion: act.assertion,
			},
			as,
			// Commit hooks, a push or `gh pr create` can run for minutes; timing out
			// here would report "unreachable" after the work succeeded.
			ACTING_RUN_TIMEOUT_MS,
		);
		return r.result;
	}

	/** A launch read on a machine's home node (src/service/launch.ts). */
	async launchRead(
		machineId: string,
		req: LaunchRead,
		as: Principal,
	): Promise<unknown> {
		const r = await this.act(`${machineId}/`, req, as);
		return r.result;
	}

	/** A remote agent's git status or PR, read on its home node. */
	async gitRead(
		address: string,
		what: "status" | "pr",
		as?: Principal,
	): Promise<unknown> {
		const slash = address.indexOf("/");
		const r = await this.act(
			address,
			{ op: "git.read", agent: address.slice(slash + 1), what },
			as,
			// gh asks GitHub: slower than a local read.
			40_000,
		);
		return what === "pr" ? r.pr : r.status;
	}

	/** A remote agent's issue card, read on its home node. */
	async issueRead(address: string, as?: Principal): Promise<unknown> {
		const slash = address.indexOf("/");
		const r = await this.act(
			address,
			{ op: "issue.read", agent: address.slice(slash + 1) },
			as,
			// gh asks GitHub: slower than a local read.
			40_000,
		);
		return r.issue;
	}

	/** A linked machine's id, by id or name. */
	machineIdOf(machine: string): string | null {
		if (this.state.peers.has(machine)) return machine;
		for (const p of this.state.peers.values())
			if (p.name === machine) return p.machineId;
		return null;
	}

	machines(): PoolMachine[] {
		const now = Date.now();
		return [...this.state.peers.values()].map((p) =>
			this.state.machine(p, now),
		);
	}

	machine(machineId: string): PoolMachine | undefined {
		const peer = this.state.peers.get(machineId);
		return peer ? this.state.machine(peer) : undefined;
	}

	version(): number {
		return this.state.version();
	}

	sender(id: string, fromName: string): Agent | null {
		const slash = id.indexOf("/");
		if (slash <= 0) return null;
		const machineId = id.slice(0, slash);
		return {
			id,
			name: fromName,
			harness: "unknown",
			sessionId: null,
			pid: null,
			cwd: null,
			project: null,
			branch: null,
			machine: this.state.peers.get(machineId)?.name ?? machineId,
			tags: [],
			status: "unknown",
			model: null,
			activity: null,
			inbound: "accept",
			registered: false,
			reach: "pull",
			lastSeen: 0,
			createdAt: 0,
			meta: { machineId, localId: id.slice(slash + 1) },
		};
	}

	enqueue(
		machineId: string,
		message: Message,
		sender: Agent,
		fromUser: boolean,
		targets: Agent[],
	): Pick<Receipt, "state" | "detail" | "via"> {
		const now = Date.now();
		this.service.store.outboxAdd(
			machineId,
			message.id,
			targets.map((t) => t.meta.localId ?? t.id.slice(t.id.indexOf("/") + 1)),
			now,
			now + this.iv.outboxExpiryMs,
			JSON.stringify(this.senderFrame(sender, fromUser)),
		);
		setImmediate(() => this.flushSafe(machineId));
		return {
			state: "queued",
			via: "pool",
			detail: this.waiting(this.state.peers.get(machineId), machineId),
		};
	}

	private senderFrame(sender: Agent, fromUser: boolean): FedSender {
		if (fromUser && sender.id.startsWith("user:"))
			return {
				kind: "user",
				login: sender.id.slice("user:".length),
				node: sender.machine ?? this.service.machine,
			};
		return {
			kind: "agent",
			id: sender.id,
			name: sender.name,
			harness: sender.harness,
			project: sender.project,
		};
	}

	/** The receipt detail for a message waiting on a peer. */
	private waiting(peer: Peer | undefined, machineId: string): string {
		if (!peer) return `waiting, ${machineId} is offline`;
		switch (peer.link) {
			case "tailnet":
				return `sending to ${peer.name}`;
			case "asleep":
				return `waiting, ${peer.name} is asleep`;
			case "upgrade":
				return `waiting: ${upgradeReason(peer, this.service.machine, this.protocol)}`;
			default:
				return `waiting, ${peer.name} is offline`;
		}
	}

	// --- Requests to peers ---

	/** One request to a peer's `/fed/v1`, with the protocol header and a timeout. */
	request(
		node: TailnetNode,
		path: string,
		init: RequestInit & {
			version?: number | null;
			stream?: boolean;
			timeoutMs?: number;
		} = {},
	): Promise<Response> {
		const { version, stream, timeoutMs, ...rest } = init;
		const signals = [rest.signal].filter((s): s is AbortSignal => Boolean(s));
		if (!stream)
			signals.push(AbortSignal.timeout(timeoutMs ?? this.iv.requestTimeoutMs));
		return this.tailnet.fetch(node, path, {
			...rest,
			signal:
				signals.length > 1 ? AbortSignal.any(signals) : (signals[0] ?? null),
			headers: {
				...(rest.body ? { "Content-Type": "application/json" } : {}),
				[FED_HEADER]: String(version ?? this.protocol[1]),
				[FED_PORT_HEADER]: String(this.port),
				...(rest.headers as Record<string, string> | undefined),
			},
		});
	}

	/** Posts up frames to a linked peer; one result per frame. */
	async post(
		peer: Peer,
		frames: UpFrame[],
		timeoutMs?: number,
	): Promise<FrameResult[]> {
		const res = await this.request(peer.node, "/fed/v1/frames", {
			method: "POST",
			body: JSON.stringify({ frames }),
			version: peer.version,
			...(timeoutMs ? { timeoutMs } : {}),
		});
		if (res.status === 426) {
			await res.body?.cancel();
			this.state.setLink(peer, "upgrade");
			throw new Error(upgradeReason(peer, this.service.machine, this.protocol));
		}
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(
				`${peer.name} answered ${res.status}: ${text.slice(0, 200)}`,
			);
		}
		const body = (await res.json()) as { results?: unknown };
		if (!Array.isArray(body.results) || body.results.length !== frames.length)
			throw new Error(`${peer.name} answered with a malformed batch`);
		return body.results as FrameResult[];
	}

	/** A forwarded action for a remote agent's home node. */
	async act(
		address: string,
		action: FedAction,
		as?: Principal,
		timeoutMs?: number,
	) {
		const slash = address.indexOf("/");
		const peer = this.state.peers.get(address.slice(0, slash));
		if (!peer) throw new RpcError("not_found", `no agent ${address}`);
		if (peer.link !== "tailnet")
			throw new RpcError(
				"unreachable",
				this.state.machine(peer).reason ?? `${peer.name} is offline`,
			);
		// The true originator travels with the action; the home node applies it.
		const principal: FedOrigin =
			as?.kind === "human"
				? {
						kind: "user",
						login: as.login,
						node: as.node,
					}
				: {
						kind: as?.kind === "agent" ? "agent" : "operator",
						node: this.service.machine,
					};
		let results: FrameResult[];
		try {
			results = await this.post(
				peer,
				[{ type: "act", as: principal, action }],
				timeoutMs,
			);
		} catch (e) {
			throw new RpcError("unreachable", (e as Error).message);
		}
		const r = results[0];
		if (!r || typeof r !== "object")
			throw new RpcError("unreachable", `${peer.name} sent no answer`);
		if (!r.ok) throw new RpcError(r.code, r.message);
		return r;
	}

	// --- Discovery ---

	/** Reads the tailnet and probes pool nodes that are new, back, or due. */
	discover(): Promise<void> {
		if (this.discovering) return this.discovering;
		this.discovering = this.discoverOnce().finally(() => {
			this.discovering = null;
		});
		return this.discovering;
	}

	private async discoverOnce() {
		if (this.stopped) return;
		const st = await this.tailnet.status();
		if (!st || this.stopped) return;
		this.self = st.self;
		this.owner ??= st.self.ownerLogin;
		// The owner's own node names the owner's user id.
		if (
			!this.ownerId &&
			st.self.ownerLogin &&
			st.self.userId &&
			this.owner?.toLowerCase() === st.self.ownerLogin.toLowerCase()
		)
			this.ownerId = st.self.userId;
		const now = Date.now();
		const seen = new Set<string>();
		const probes: TailnetNode[] = [];
		for (const node of st.peers) {
			if (node.nodeId === st.self.nodeId) continue;
			const known = this.state.byNode.get(node.nodeId);
			const peer = known ? this.state.peers.get(known) : undefined;
			if (!this.members.admits(node, this.owner, this.ownerId)) {
				if (peer) this.state.remove(peer.machineId);
				continue;
			}
			seen.add(node.nodeId);
			if (peer) peer.node = { ...node, port: peer.node.port };
			if (!node.online) {
				if (peer) this.down(peer, "asleep");
				continue;
			}
			const backoff = this.probeBackoff.get(node.nodeId);
			if (backoff && backoff.until > now) continue;
			if (
				!peer ||
				peer.hello === null ||
				peer.link === "asleep" ||
				(peer.link === "daemon-down" &&
					now - peer.probedAt > this.iv.heartbeatMs) ||
				now - peer.probedAt > this.iv.reprobeMs
			)
				// A known peer's node carries the port it was bound on.
				probes.push(peer ? peer.node : node);
		}
		// A known peer that left the tailnet listing (removed, or another user now) sleeps.
		for (const peer of this.state.peers.values())
			if (!seen.has(peer.node.nodeId)) this.down(peer, "asleep");
		this.recheckServed();
		for (let i = 0; i < probes.length; i += 32)
			await Promise.all(probes.slice(i, i + 32).map((n) => this.probe(n)));
	}

	/** Asks a node who it is (`/fed/v1/hello`); links it when the protocols overlap. */
	probe(node: TailnetNode, hint?: number): Promise<Peer | null> {
		const running = this.probing.get(node.nodeId);
		if (running) return running;
		const p = this.probeOnce(node, hint).finally(() =>
			this.probing.delete(node.nodeId),
		);
		this.probing.set(node.nodeId, p);
		return p;
	}

	private async probeOnce(
		node: TailnetNode,
		hint?: number,
	): Promise<Peer | null> {
		let hello: FedHello | null = null;
		// Where its pulsar may listen: what it told us, what it served on
		// before, our own port, the default.
		const ports = [
			...new Set(
				// The port bound before, ours, the default; a caller's hint last,
				// so its real daemon (not a process on another port) binds first.
				[node.port, this.port, DEFAULT_FED_PORT, hint].filter(
					(p): p is number => typeof p === "number",
				),
			),
		];
		try {
			let last: unknown = null;
			for (const port of ports) {
				try {
					const res = await this.request({ ...node, port }, "/fed/v1/hello");
					if (!res.ok) {
						await res.body?.cancel();
						throw new Error(`hello answered ${res.status}`);
					}
					hello = parseHello(await res.json(), node.name);
					if (!hello) throw new Error("malformed hello");
					// The port that answered, never the hello's word for it.
					node = { ...node, port };
					break;
				} catch (e) {
					last = e;
				}
			}
			if (!hello) throw last ?? new Error("no answer");
		} catch (e) {
			const prev = this.probeBackoff.get(node.nodeId);
			const n = (prev?.n ?? 0) + 1;
			this.probeBackoff.set(node.nodeId, {
				n,
				until:
					Date.now() + Math.min(this.iv.discoverMs * 2 ** (n - 1), 30 * 60_000),
			});
			const known = this.state.byNode.get(node.nodeId);
			const peer = known ? this.state.peers.get(known) : undefined;
			if (peer) {
				peer.probedAt = Date.now();
				this.down(peer, node.online ? "daemon-down" : "asleep");
			}
			this.log(`no Pulsar on ${node.name}: ${(e as Error).message}`);
			return null;
		}
		this.probeBackoff.delete(node.nodeId);
		if (hello.machineId === this.machineId) return null;
		// A peer's machine name is its Tailscale name, not what its hello says.
		hello = { ...hello, name: node.name };
		if (this.claimsAnother(node, hello)) return null;
		if (this.portMoved(node, hello)) return null;
		// The node now runs a new pulsar (reinstalled): its old id is dropped,
		// and the user hears of it (a process there could pose as a fresh
		// install while the daemon is down).
		const previous =
			this.state.byNode.get(node.nodeId) ??
			this.service.store.peers().find((p) => p.node === node.nodeId)?.machineId;
		if (previous && previous !== hello.machineId) {
			this.forgetBinding(previous);
			this.reinstalled(node, previous, hello.machineId);
		}
		const version = negotiate(this.protocol, hello.fedProtocol);
		const isNew = !this.state.peers.has(hello.machineId);
		const peer = this.state.upsert(node, hello, version);
		if (isNew)
			this.service.store.audit({
				at: Date.now(),
				principal: `node:${node.nodeId}`,
				op: "fed.link",
				target: hello.machineId,
				detail: JSON.stringify({ name: hello.name, node: node.name }),
				ok: true,
			});
		peer.probedAt = Date.now();
		try {
			this.service.store.savePeer(
				{
					machineId: peer.machineId,
					name: peer.name,
					node: node.nodeId,
					dnsName: node.dnsName,
					allowed: node.tags.length > 0,
					pulsarVersion: hello.pulsarVersion,
					fedProtocol: hello.fedProtocol,
					lastSeen: Date.now(),
					port: node.port ?? DEFAULT_FED_PORT,
				},
				Date.now(),
			);
		} catch (e) {
			// The store closed (shutting down): the peer is remembered next time.
			this.log(`could not save ${peer.name}: ${(e as Error).message}`);
		}
		if (version === null) {
			peer.stream?.abort();
			this.state.setLink(peer, "upgrade");
			this.log(
				`${peer.name}: ${upgradeReason(peer, this.service.machine, this.protocol)}`,
			);
		} else {
			this.heard(peer);
			peer.nextHeartbeat = 0;
		}
		return peer;
	}

	/**
	 * A machine id is bound to the node that first linked with it (by its
	 * Tailscale stable id), here and in the `peers` table. A hello from
	 * another node claiming it is refused, audited and announced; only
	 * `pulsar mesh forget` frees the id.
	 */
	private claimsAnother(node: TailnetNode, hello: FedHello): boolean {
		const held = this.state.peers.get(hello.machineId)?.node.nodeId;
		const stored = this.service.store
			.peers()
			.find((p) => p.machineId === hello.machineId)?.node;
		const bound = held ?? stored ?? null;
		if (!bound || bound === node.nodeId) return false;
		const name =
			this.state.peers.get(hello.machineId)?.name ??
			this.service.store.peers().find((p) => p.machineId === hello.machineId)
				?.name ??
			hello.machineId;
		this.probeBackoff.set(node.nodeId, {
			n: 1,
			until: Date.now() + this.iv.reprobeMs,
		});
		const key = `${node.nodeId}>${hello.machineId}`;
		const last = this.conflicts.get(key) ?? 0;
		this.log(`${node.name} claimed the machine id of ${name}; refused`);
		if (Date.now() - last > 3600_000) {
			this.conflicts.set(key, Date.now());
			this.service.store.audit({
				at: Date.now(),
				principal: `node:${node.nodeId}`,
				op: "fed.conflict",
				target: hello.machineId,
				detail: JSON.stringify({ claimedBy: node.name, boundTo: bound, name }),
				ok: false,
			});
			this.service.events.emit("security", {
				kind: "pool-conflict",
				message: `${clean(node.name, 100)} claimed to be ${clean(name, 100)} and was refused. If ${clean(name, 100)} was reinstalled on that node, run \`pulsar mesh forget ${clean(name, 100)}\` on ${this.service.machine}.`,
				node: this.service.machine,
				at: Date.now(),
			});
		}
		return true;
	}

	/**
	 * The relying party for a ceremony relayed through `link`: this tailnet's
	 * shared RP id, and the one exact origin of that peer's app (its MagicDNS
	 * name from Tailscale and its bound port), never a frame's word.
	 */
	rpFor(link: Peer): { rpId: string; origins: string[] } {
		const port = link.node.port ?? DEFAULT_FED_PORT;
		return {
			rpId: this.rpId(),
			origins: [
				`https://${link.node.dnsName}${port === 443 ? "" : `:${port}`}`,
			],
		};
	}

	/** This tailnet's WebAuthn RP id (its registrable domain). */
	rpId(): string {
		if (this.rpIdOverride) return this.rpIdOverride;
		const name = this.self?.dnsName;
		if (!name)
			throw new RpcError("unavailable", "this node has no tailnet name yet");
		return tailnetRpId(name);
	}

	/**
	 * A peer's app port is bound at first link, like its machine id: a known
	 * node answering on another port is refused, audited and announced (a
	 * process on that machine could serve its own app there and collect
	 * passkey ceremonies for its origin). `pulsar mesh forget` rebinds.
	 */
	private portMoved(node: TailnetNode, hello: FedHello): boolean {
		// Bound per Tailscale node, not per machine id: a new id (a "reinstall")
		// does not free the port.
		const stored = this.service.store
			.peers()
			.find((p) => p.node === node.nodeId)?.port;
		const now = node.port ?? DEFAULT_FED_PORT;
		if (stored === null || stored === undefined || stored === now) return false;
		this.probeBackoff.set(node.nodeId, {
			n: 1,
			until: Date.now() + this.iv.reprobeMs,
		});
		this.log(
			`${node.name} answered on port ${now}, bound to ${stored}; refused`,
		);
		const key = `${node.nodeId}:${now}`;
		if (Date.now() - (this.conflicts.get(key) ?? 0) > 3600_000) {
			this.conflicts.set(key, Date.now());
			this.service.store.audit({
				at: Date.now(),
				principal: `node:${node.nodeId}`,
				op: "fed.port",
				target: hello.machineId,
				detail: JSON.stringify({ name: node.name, bound: stored, seen: now }),
				ok: false,
			});
			this.service.events.emit("security", {
				kind: "pool-conflict",
				message: `${clean(node.name, 100)} answered on port ${now}, not its port ${stored}, and was refused. If you moved pulsar on ${clean(node.name, 100)} to another port, run \`pulsar mesh forget ${clean(node.name, 100)}\` on ${this.service.machine}.`,
				node: this.service.machine,
				at: Date.now(),
			});
		}
		return true;
	}

	/** A known node now answers with another machine id: audited and announced. */
	private reinstalled(node: TailnetNode, previous: string, next: string) {
		const name = clean(node.name, 100);
		this.log(`${node.name} runs a new Pulsar (${previous} → ${next})`);
		this.service.store.audit({
			at: Date.now(),
			principal: `node:${node.nodeId}`,
			op: "fed.reinstall",
			target: next,
			detail: JSON.stringify({ name: node.name, previous }),
			ok: true,
		});
		this.service.events.emit("security", {
			kind: "pool-reinstall",
			message: `${name} now runs a new Pulsar install (new machine id). If you did not reinstall Pulsar on ${name}, check that machine.`,
			node: this.service.machine,
			at: Date.now(),
		});
	}

	/** Drops a peer and its stored binding. */
	private forgetBinding(machineId: string) {
		this.state.remove(machineId);
		try {
			this.service.store.removePeer(machineId);
		} catch {}
	}

	/** The peer answered (or called): it is linked; anything queued for it goes now. */
	private heard(peer: Peer) {
		peer.lastHeard = Date.now();
		peer.failures = 0;
		peer.nextHeartbeat = peer.lastHeard + jitter(this.iv.heartbeatMs);
		if (peer.version === null) return;
		if (this.state.setLink(peer, "tailnet")) {
			this.service.store.outboxWake(peer.machineId, Date.now());
			setImmediate(() => this.flushSafe(peer.machineId));
		}
	}

	private down(peer: Peer, link: "asleep" | "daemon-down") {
		if (peer.link === "upgrade" && peer.version === null) return;
		peer.stream?.abort();
		peer.stream = null;
		if (!this.state.setLink(peer, link)) return;
		// Receipts of what waits for it now say why.
		for (const e of this.service.store.outboxFor(peer.machineId))
			this.markWaiting(peer, e.messageId, e.targetIds);
	}

	private failed(peer: Peer) {
		peer.failures++;
		if (peer.failures >= this.iv.missed)
			this.down(peer, peer.node.online ? "daemon-down" : "asleep");
	}

	// --- Heartbeats, digests and registry streams ---

	private tick() {
		if (this.stopped) return;
		this.feed.tick();
		const now = Date.now();
		for (const peer of this.state.peers.values()) {
			if (peer.version === null || peer.link === "asleep") continue;
			if (
				peer.link === "tailnet" &&
				now - peer.lastHeard > this.iv.heartbeatMs * this.iv.missed
			)
				this.down(peer, peer.node.online ? "daemon-down" : "asleep");
			if (now >= peer.nextHeartbeat && !peer.beating)
				this.heartbeat(peer).catch(() => {});
			if (peer.stream && now - peer.lastDelta > this.iv.linkIdleMs) {
				peer.stream.abort();
				peer.stream = null;
			}
		}
	}

	/** One gossip exchange: our digest up, theirs back; a stale copy pulls. */
	private async heartbeat(peer: Peer) {
		peer.beating = true;
		peer.nextHeartbeat = Date.now() + jitter(this.iv.heartbeatMs);
		try {
			const [r] = await this.post(peer, [
				{ type: "digest", digest: this.feed.digest(this.machineId) },
			]);
			if (!r?.ok) throw new Error(r ? r.message : "no answer");
			this.heard(peer);
			this.gossip(peer, r.digest as Digest);
		} catch (e) {
			if (peer.link !== "upgrade") this.failed(peer);
			this.log(`heartbeat to ${peer.name} failed: ${(e as Error).message}`);
		} finally {
			peer.beating = false;
		}
	}

	/** A peer's digest: pull its agents when our copy is behind. */
	private gossip(peer: Peer, digest: Digest | undefined) {
		if (!digest || digest.machineId !== peer.machineId) return;
		peer.digest = digest;
		if (digest.bootId !== peer.bootId || digest.seq !== peer.seq)
			this.openStream(peer);
	}

	/** Opens the registry stream from a peer (snapshot or replayed deltas, then live deltas). */
	openStream(peer: Peer) {
		if (peer.stream || peer.link !== "tailnet" || this.stopped) return;
		// A gap timer or a late heartbeat can hold a peer the pool since removed.
		if (this.state.peers.get(peer.machineId) !== peer) return;
		const ac = new AbortController();
		peer.stream = ac;
		peer.lastDelta = Date.now();
		const since = peer.bootId
			? `?since=${encodeURIComponent(`${peer.bootId}:${peer.seq}`)}`
			: "";
		void (async () => {
			try {
				const res = await this.request(peer.node, `/fed/v1/stream${since}`, {
					signal: ac.signal,
					stream: true,
					version: peer.version,
				});
				if (!res.ok || !res.body) {
					await res.body?.cancel();
					throw new Error(`stream answered ${res.status}`);
				}
				await readSse(
					res.body,
					(event, data) => this.onDown(peer, ac, event, data),
					ac.signal,
				);
			} catch (e) {
				if (!ac.signal.aborted) {
					this.log(`stream from ${peer.name} ended: ${(e as Error).message}`);
					this.failed(peer);
				}
			} finally {
				if (peer.stream === ac) {
					peer.stream = null;
					// The peer ended it (a restart, a deploy): compare digests soon
					// rather than a whole heartbeat later; jittered so a pool-wide
					// restart does not stampede.
					if (!ac.signal.aborted)
						peer.nextHeartbeat = Math.min(
							peer.nextHeartbeat,
							Date.now() + jitter(Math.min(1000, this.iv.heartbeatMs)),
						);
				}
			}
		})();
	}

	private onDown(peer: Peer, ac: AbortController, event: string, data: string) {
		if (peer.stream !== ac) return;
		let frame: Record<string, unknown>;
		try {
			frame = JSON.parse(data) as Record<string, unknown>;
		} catch {
			return;
		}
		const bootId = String(frame.bootId ?? "");
		const seq = Number(frame.seq);
		if (event === "snapshot" && Array.isArray(frame.agents)) {
			this.state.snapshot(peer, bootId, seq, frame.agents);
		} else if (event === "delta") {
			const r = this.state.delta(
				peer,
				bootId,
				seq,
				Array.isArray(frame.upserts) ? frame.upserts : [],
				Array.isArray(frame.removes) ? frame.removes : [],
			);
			if (r === false) {
				// A gap (missed deltas, or the peer restarted): start over from a snapshot.
				ac.abort();
				peer.stream = null;
				peer.bootId = null;
				// Backs off when gaps repeat, so a peer can't force snapshot storms.
				const n = (this.gaps.get(peer.machineId) ?? 0) + 1;
				this.gaps.set(peer.machineId, n);
				const t = setTimeout(
					() => this.openStream(peer),
					n <= 1 ? 0 : Math.min(500 * 2 ** (n - 2), 30_000),
				);
				t.unref?.();
				return;
			}
			this.gaps.delete(peer.machineId);
		} else return;
		peer.lastDelta = Date.now();
		this.heard(peer);
	}

	// --- Outbox ---

	private outboxTick() {
		if (this.stopped) return;
		const { store } = this.service;
		const now = Date.now();
		for (const e of store.outboxExpire(now)) {
			const peer = this.state.peers.get(e.peer);
			for (const id of e.targetIds) {
				const address = `${e.peer}/${id}`;
				const target =
					this.service.registry.find(address) ?? this.sender(address, id);
				if (target)
					writeReceipt(
						store,
						e.messageId,
						target,
						"failed",
						"pool",
						`${peer?.name ?? e.peer} stayed offline; not delivered`,
					);
			}
		}
		// Every peer with something due: the oldest rows may all be a sleeper's.
		for (const machineId of store.outboxDuePeers(now))
			this.flushSafe(machineId);
	}

	/** `flush` from a timer: a failure is logged, never an unhandled rejection. */
	private flushSafe(machineId: string) {
		this.flush(machineId).catch((e) =>
			this.log(`outbox for ${machineId} failed: ${(e as Error).message}`),
		);
	}

	/** Sends what waits for one peer, in batches; failures back off per message. */
	async flush(machineId: string) {
		const peer = this.state.peers.get(machineId);
		if (peer?.link !== "tailnet" || this.stopped) return;
		if (peer.flushing) {
			peer.flushAgain = true;
			return;
		}
		peer.flushing = true;
		const { store } = this.service;
		try {
			for (;;) {
				const entries = store.outboxDue(machineId, Date.now(), 100);
				if (entries.length === 0) break;
				const batch: { entry: (typeof entries)[number]; message: Message }[] =
					[];
				for (const entry of entries) {
					const message = store.getMessage(entry.messageId);
					if (message) batch.push({ entry, message });
					else store.outboxDone(machineId, entry.messageId);
				}
				if (batch.length === 0) continue;
				let results: FrameResult[];
				try {
					results = await this.post(
						peer,
						batch.map(({ entry, message }) => ({
							type: "deliver",
							message,
							targets: entry.targetIds,
							from:
								this.parseSender(entry.sender) ?? this.storedSender(message),
						})),
					);
				} catch (e) {
					const error = (e as Error).message;
					this.failed(peer);
					for (const { entry } of batch) {
						store.outboxRetry(
							machineId,
							entry.messageId,
							Date.now() + this.backoff(entry.attempts),
							error,
						);
						this.markWaiting(peer, entry.messageId, entry.targetIds);
					}
					break;
				}
				this.heard(peer);
				for (const [i, { entry, message }] of batch.entries()) {
					const r = results[i];
					if (!r || typeof r !== "object") {
						store.outboxRetry(
							machineId,
							message.id,
							Date.now() + this.backoff(entry.attempts),
							"no answer",
						);
					} else if (r.ok) {
						store.outboxDone(machineId, message.id);
						this.applyReceipts(peer, message.id, r.receipts);
					} else if (PERMANENT.has(r.code)) {
						store.outboxDone(machineId, message.id);
						for (const id of entry.targetIds)
							this.writeRemoteReceipt(peer, message.id, {
								agentId: id,
								agentName: id,
								state: "refused",
								via: "pool",
								detail: `${peer.name} refused it: ${r.message}`,
								updatedAt: Date.now(),
							});
					} else {
						store.outboxRetry(
							machineId,
							message.id,
							Date.now() + this.backoff(entry.attempts),
							r.message,
						);
					}
				}
			}
		} finally {
			peer.flushing = false;
			if (peer.flushAgain) {
				peer.flushAgain = false;
				setImmediate(() => this.flushSafe(machineId));
			}
		}
	}

	private backoff(attempts: number) {
		return jitter(Math.min(1000 * 2 ** attempts, 60_000));
	}

	/** The sender frame stored with an outbox entry. */
	private parseSender(raw: string | null): FedSender | null {
		if (!raw) return null;
		try {
			const f = JSON.parse(raw) as FedSender;
			return f && (f.kind === "user" || f.kind === "agent") ? f : null;
		} catch {
			return null;
		}
	}

	/** Who sent an outbox message queued before senders were stored. */
	private storedSender(message: Message): FedSender {
		if (message.fromId.startsWith("user:"))
			return {
				kind: "user",
				login: message.fromId.slice("user:".length),
				node: this.service.machine,
			};
		const agent = this.service.registry.from(message.fromId, message.fromName);
		return {
			kind: "agent",
			id: message.fromId,
			name: message.fromName,
			harness: agent?.harness ?? "unknown",
			project: agent?.project ?? null,
		};
	}

	/** Receipts still `queued` for a message say why it waits. */
	private markWaiting(peer: Peer, messageId: string, localIds: string[]) {
		const detail = this.waiting(peer, peer.machineId);
		const current = new Map(
			this.service.store.receiptsFor(messageId).map((r) => [r.agentId, r]),
		);
		for (const id of localIds) {
			const address = `${peer.machineId}/${id}`;
			const r = current.get(address);
			if (r && r.state !== "queued") continue;
			this.writeRemoteReceipt(peer, messageId, {
				agentId: id,
				agentName: r?.agentName ?? id,
				state: "queued",
				via: "pool",
				detail,
				updatedAt: Date.now(),
			});
		}
	}

	private writeRemoteReceipt(peer: Peer, messageId: string, r: FedReceipt) {
		const address = `${peer.machineId}/${r.agentId}`;
		const shown = this.service.registry.find(address);
		const receipt: Receipt = {
			messageId,
			agentId: address,
			agentName: shown?.name ?? r.agentName,
			state: r.state,
			via: r.via,
			detail: r.detail,
			updatedAt: r.updatedAt,
			...(r.attempt ? { attempt: r.attempt } : {}),
			...(r.result !== undefined ? { result: r.result } : {}),
		};
		if (this.service.store.setReceipt(receipt))
			this.service.deliveries.settle(messageId, receipt);
	}

	/** True when a linked peer announced `feature` in its hello. */
	private peerHas(machineId: string, feature: string): boolean {
		return (
			this.state.peers.get(machineId)?.hello?.features.includes(feature) ??
			false
		);
	}

	/** Receipts a peer reported for one of this node's messages. */
	private applyReceipts(peer: Peer, messageId: string, raw: unknown) {
		if (!Array.isArray(raw)) return;
		// Only recipients this message was sent to on that machine.
		const sentTo = this.service.store.receiptIdsWithPrefix(
			messageId,
			`${peer.machineId}/`,
		);
		for (const item of raw.slice(0, 10_000)) {
			const r = item as FedReceipt;
			if (
				typeof r?.agentId !== "string" ||
				(r.agentId.includes("/") && !isLocalSubagentId(r.agentId)) ||
				!RECEIPT_STATES.has(r.state) ||
				!sentTo.has(`${peer.machineId}/${r.agentId}`)
			)
				continue;
			this.writeRemoteReceipt(peer, messageId, {
				agentId: r.agentId,
				agentName: clean(String(r.agentName ?? r.agentId), 200),
				state: r.state,
				via: typeof r.via === "string" ? clean(r.via, 60) : null,
				detail: typeof r.detail === "string" ? clean(r.detail, 500) : null,
				updatedAt: Number(r.updatedAt) || Date.now(),
				...(Number.isInteger(r.attempt) && Number(r.attempt) > 0
					? { attempt: Math.min(Number(r.attempt), 1000) }
					: {}),
				...(typeof r.result === "string"
					? { result: clean(r.result, 500) }
					: {}),
			});
		}
	}

	/** Sends changed receipts of delivered copies back to their senders. */
	private async receiptTick() {
		// One pass at a time: a slow peer must not get a copy of the batch per tick.
		if (this.stopped || this.sendingReceipts) return;
		this.sendingReceipts = true;
		try {
			await this.sendReceipts();
		} finally {
			this.sendingReceipts = false;
		}
	}

	private async sendReceipts() {
		const now = Date.now();
		const tracked = this.service.store.tracked(now);
		if (tracked.length === 0) return;
		const byPeer = new Map<
			string,
			{ frame: UpFrame; id: string; sig: string }[]
		>();
		for (const t of tracked) {
			const id = t.messageId;
			const targets = new Set(t.targets);
			const receipts = this.service.store
				.receiptsFor(id)
				.filter((r) => targets.has(r.agentId));
			const sig = receiptSig(receipts);
			if (sig === t.sig) continue;
			const receipts2 = this.peerHas(t.machineId, RECEIPTS2);
			const list = byPeer.get(t.machineId) ?? [];
			list.push({
				id,
				sig,
				frame: {
					type: "receipts",
					messageId: id,
					receipts: receipts.map((r) => fedReceipt(r, receipts2)),
				},
			});
			byPeer.set(t.machineId, list);
		}
		await Promise.all(
			[...byPeer].map(async ([machineId, items]) => {
				const peer = this.state.peers.get(machineId);
				if (peer?.link !== "tailnet") return;
				try {
					const results = await this.post(
						peer,
						items.map((i) => i.frame),
					);
					for (const [i, item] of items.entries())
						if (results[i]?.ok) this.service.store.trackSig(item.id, item.sig);
				} catch {
					// Sent again on the next tick.
				}
			}),
		);
	}

	// --- Serving /fed/v1 ---

	/**
	 * Serves one `/fed/v1` request. `who` is the connection's tailnet
	 * identity (whois on the remote address); only nodes of the pool owner
	 * and allowed tagged nodes get past it, as a `peer` principal.
	 */
	async handle(req: Request, who: Identity | null): Promise<Response> {
		const url = new URL(req.url);
		const path = url.pathname;
		if (!who)
			return refuse(
				403,
				"not_identified",
				"could not identify this connection",
			);
		const owner = this.owner;
		if (!owner)
			return refuse(
				503,
				"not_ready",
				"this node does not know its pool owner yet",
			);
		if (!this.members.admitsCaller(who, owner, this.ownerId))
			return refuse(403, "not_in_pool", `${who.node} is not in this pool`);
		if (path === "/fed/v1/hello" && req.method === "GET") {
			const hello: FedHello = {
				fedProtocol: this.protocol,
				features: this.features,
				pulsarVersion: VERSION,
				machineId: this.machineId,
				name: this.service.machine,
				port: this.port,
			};
			return json(hello);
		}
		const v = Number(req.headers.get(FED_HEADER));
		if (!Number.isInteger(v) || v < this.protocol[0] || v > this.protocol[1])
			return refuse(
				426,
				"upgrade",
				v > this.protocol[1]
					? `upgrade Pulsar on ${this.service.machine}`
					: `upgrade Pulsar on ${who.node}`,
			);
		const peer = await this.peerFor(
			who,
			portOf(req.headers.get(FED_PORT_HEADER)),
		);
		if (!peer)
			return refuse(
				403,
				"unknown_peer",
				`${who.node} has not linked yet; probe it first`,
			);
		const principal: Principal = {
			kind: "peer",
			machineId: peer.machineId,
			node: who.node,
		};
		// The user role (forwarded actions, user-framed messages) comes only
		// from the owner's own nodes, decided by whois here, never by a frame.
		const userCapable = isOwner(who, owner, this.ownerId);

		try {
			if (path === "/fed/v1/frames" && req.method === "POST") {
				const raw = await readCapped(req, MAX_BATCH_BYTES);
				if (raw === null) return refuse(413, "too_large", "batch over 8 MB");
				let frames: unknown;
				try {
					frames = (JSON.parse(raw) as { frames?: unknown }).frames;
				} catch {
					return refuse(400, "bad_request", "the body must be JSON");
				}
				if (!Array.isArray(frames) || frames.length > 500)
					return refuse(
						400,
						"bad_request",
						"`frames` must be an array of at most 500",
					);
				const results: FrameResult[] = [];
				for (const f of frames)
					results.push(await this.frame(peer, principal, f, userCapable));
				return json({ results });
			}
			if (path === "/fed/v1/stream" && req.method === "GET") {
				authorize(principal, "fed.subscribe");
				this.heard(peer);
				return this.streamResponse(
					url.searchParams.get("since"),
					peer.machineId,
					userCapable,
					who,
				);
			}
			if (path === "/fed/v1/transcript" && req.method === "GET") {
				authorize(principal, "fed.act");
				if (!userCapable)
					throw new RpcError(
						"forbidden",
						`${who.node} is not one of your own nodes; it can't act for you`,
					);
				return this.transcriptStream(url.searchParams, peer.machineId, who);
			}
			if (path === "/fed/v1/changes" && req.method === "GET") {
				authorize(principal, "fed.act");
				if (!userCapable)
					throw new RpcError(
						"forbidden",
						`${who.node} is not one of your own nodes; it can't act for you`,
					);
				return this.changesStream(url.searchParams, peer.machineId, who);
			}
		} catch (e) {
			const err =
				e instanceof RpcError
					? e
					: new RpcError("internal", (e as Error).message);
			return refuse(
				err.code === "forbidden"
					? 403
					: err.code === "rate_limited"
						? 429
						: err.code === "not_found"
							? 404
							: 400,
				err.code,
				err.message,
			);
		}
		return refuse(404, "unsupported", `this node does not serve ${path}`);
	}

	/** The peer behind an identity: known by node id, else probed now. */
	private async peerFor(who: Identity, port?: number): Promise<Peer | null> {
		const known = this.state.byNode.get(who.nodeId);
		if (known) return this.state.peers.get(known) ?? null;
		const st = await this.tailnet.status();
		const node = st?.peers.find((n) => n.nodeId === who.nodeId);
		if (!node || !st || !this.members.admits(node, this.owner, this.ownerId))
			return null;
		// One inline probe per node per 10 s: an admitted node with no pulsar
		// answering can't make every request run `tailscale status` and probes.
		const last = this.inlineProbes.get(node.nodeId) ?? 0;
		if (Date.now() - last < 10_000) return null;
		this.inlineProbes.set(node.nodeId, Date.now());
		this.probeBackoff.delete(node.nodeId);
		const peer = await this.probe(node, port);
		return peer?.version != null ? peer : null;
	}

	/** Counts a peer's open streams; refuses one over `cap` (a peer can't hold this node's sockets). */
	private holdStream(key: string, cap: number): () => void {
		const n = this.openStreams.get(key) ?? 0;
		if (n >= cap)
			throw new RpcError("rate_limited", `at most ${cap} open streams`);
		this.openStreams.set(key, n + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const left = (this.openStreams.get(key) ?? 1) - 1;
			if (left <= 0) this.openStreams.delete(key);
			else this.openStreams.set(key, left);
		};
	}

	/** Tracks a served stream until it closes; `recheckServed` may end it first. */
	private serve(
		who: Identity,
		machineId: string,
		asOwner: boolean,
		end: () => void,
	): () => void {
		const s: ServedStream = { who, machineId, asOwner, end };
		this.served.add(s);
		return () => this.served.delete(s);
	}

	/**
	 * Ends the served streams whose caller the pool no longer admits (denied,
	 * forgotten, removed) or that lost the user role they were opened with:
	 * membership is checked when a stream opens, and a stream can live for hours.
	 */
	private recheckServed() {
		const owner = this.owner;
		for (const s of [...this.served]) {
			const ok =
				owner !== null &&
				this.state.peers.has(s.machineId) &&
				this.members.admitsCaller(s.who, owner, this.ownerId) &&
				(!s.asOwner || isOwner(s.who, owner, this.ownerId));
			if (ok) continue;
			this.served.delete(s);
			s.end();
		}
	}

	/**
	 * The agent feed. A caller that can't act as the user (an allowed tagged
	 * node) gets it without approvals: prompts carry exact tool input, which
	 * is the user's alone, like transcripts.
	 */
	private streamResponse(
		since: string | null,
		machineId: string,
		userCapable: boolean,
		who: Identity,
	): Response {
		const release = this.holdStream(
			`stream:${machineId}`,
			MAX_STREAMS_PER_PEER,
		);
		this.feed.tick();
		const strip = (agents: FedAgent[]) =>
			userCapable ? agents : agents.map(({ approvals: _, ...a }) => a);
		const body = sseStream((sendRaw, end) => {
			const untrack = this.serve(who, machineId, userCapable, end);
			const send = (event: string, data: Record<string, unknown>) =>
				sendRaw(event, {
					...data,
					...(Array.isArray(data.agents)
						? { agents: strip(data.agents as FedAgent[]) }
						: {}),
					...(Array.isArray(data.upserts)
						? { upserts: strip(data.upserts as FedAgent[]) }
						: {}),
				});
			const [bootId = "", seqText = ""] = (since ?? "").split(":");
			const replay = since ? this.feed.since(bootId, Number(seqText)) : null;
			if (replay)
				for (const d of replay)
					send("delta", { type: "delta", bootId: this.feed.bootId, ...d });
			else send("snapshot", { type: "snapshot", ...this.feed.snapshot() });
			const off = this.feed.listen((d) =>
				send("delta", { type: "delta", bootId: this.feed.bootId, ...d }),
			);
			return () => {
				off();
				untrack();
				release();
			};
		});
		return sseResponse(body);
	}

	/** One local agent's live transcript, for the user a peer forwards. */
	private transcriptStream(
		q: URLSearchParams,
		machineId: string,
		who: Identity,
	): Response {
		const user = this.forwardedUser({
			login: q.get("login"),
			node: q.get("node"),
		});
		const agent = q.get("agent") ?? "";
		authorize(user, "transcript.read", agent);
		if (!this.knows(agent))
			throw new RpcError("not_found", `no agent ${agent}`);
		const release = this.holdStream(
			`transcript:${machineId}`,
			MAX_TRANSCRIPTS_PER_PEER,
		);
		const body = sseStream((send, end) => {
			const untrack = this.serve(who, machineId, true, end);
			const off = this.service.transcripts.subscribe(agent, (events) =>
				send("transcript", { events }),
			);
			return () => {
				off();
				untrack();
				release();
			};
		});
		return sseResponse(body);
	}

	/** One local agent's worktree summary while watched, for the user a peer forwards. */
	private changesStream(
		q: URLSearchParams,
		machineId: string,
		who: Identity,
	): Response {
		const user = this.forwardedUser({
			login: q.get("login"),
			node: q.get("node"),
		});
		const agent = q.get("agent") ?? "";
		const mode = q.get("mode") === "base" ? "base" : "worktree";
		authorize(user, "transcript.read", agent);
		if (!this.service.registry.get(agent))
			throw new RpcError("not_found", `no agent ${agent}`);
		// Shares the transcript streams' cap: both follow one agent for a viewer.
		const release = this.holdStream(
			`transcript:${machineId}`,
			MAX_TRANSCRIPTS_PER_PEER,
		);
		const body = sseStream((send, end) => {
			const untrack = this.serve(who, machineId, true, end);
			const off = this.service.changes.watch(agent, mode, (summary) =>
				send("changes", summary),
			);
			return () => {
				off();
				untrack();
				release();
			};
		});
		return sseResponse(body);
	}

	/**
	 * The originator of a forwarded action, as a principal here: the user
	 * (re-checked: the pool owner), the person at the forwarding node's
	 * terminal (operator), or an agent there (an agent principal no local
	 * agent shares: it may ask, never read another agent's transcript, stop
	 * others, or approve).
	 */
	private origin(
		peer: Principal,
		as: Partial<FedOrigin> | undefined,
	): Principal {
		const machineId = peer.kind === "peer" ? peer.machineId : "unknown";
		if (as?.kind === "agent")
			return { kind: "agent", agentId: `${machineId}/agent` };
		if (as?.kind === "operator") return { kind: "terminal" };
		return this.forwardedUser({ login: as?.login, node: as?.node });
	}

	/**
	 * The user a peer forwards, checked here (the pool owner's login). Never
	 * verified: no frame confers user authority. What needs it (approve,
	 * Stop) carries a WebAuthn assertion this node verifies itself.
	 */
	private forwardedUser(as: { login: unknown; node: unknown }): Principal {
		if (typeof as.login !== "string" || typeof as.node !== "string")
			throw new RpcError("bad_request", "a forwarded action names its user");
		if (!this.owner || as.login.toLowerCase() !== this.owner.toLowerCase())
			throw new RpcError("forbidden", `${as.login} is not this pool's owner`);
		return {
			kind: "human",
			login: as.login,
			node: clean(as.node, 100),
			verified: false,
		};
	}

	private async frame(
		peer: Peer,
		principal: Principal,
		raw: unknown,
		userCapable: boolean,
	): Promise<FrameResult> {
		const f = raw as UpFrame;
		try {
			switch (f?.type) {
				case "digest": {
					authorize(principal, "fed.digest");
					this.heard(peer);
					this.gossip(peer, f.digest);
					return { ok: true, digest: this.feed.digest(this.machineId) };
				}
				case "deliver":
					authorize(principal, "fed.deliver");
					this.heard(peer);
					return await this.receive(peer, f, userCapable);
				case "receipts": {
					authorize(principal, "fed.receipts");
					const message = this.service.store.getMessage(String(f.messageId));
					if (!message || this.service.store.originOf(message.id))
						return fail(
							"not_found",
							`no message ${String(f.messageId)} sent here`,
						);
					this.applyReceipts(peer, message.id, f.receipts);
					return { ok: true };
				}
				case "act":
					authorize(principal, "fed.act");
					// Only the owner's own nodes act for anyone; an allowed
					// tagged node shares its agents and messages, nothing more.
					if (!userCapable)
						return fail(
							"forbidden",
							"only your own nodes forward actions; this node is allowed as a peer",
						);
					if (
						!this.checkRate(
							`act:${peer.machineId}`,
							ACTS_PER_MINUTE,
							Date.now(),
						)
					)
						return fail(
							"rate_limited",
							`at most ${ACTS_PER_MINUTE} forwarded actions a minute`,
						);
					return await this.perform(principal, peer, f.as, f.action);
				default:
					return fail(
						"unsupported",
						`unknown frame ${String((f as { type?: unknown })?.type).slice(0, 40)}`,
					);
			}
		} catch (e) {
			const err =
				e instanceof RpcError
					? e
					: new RpcError("internal", (e as Error).message);
			return fail(err.code, err.message);
		}
	}

	private checkRate(key: string, cap: number, now: number) {
		// Bounded: windows that emptied are dropped once the map grows.
		if (this.rate.size > 10_000)
			for (const [k, v] of this.rate)
				if (!v.some((t) => now - t < INTERVALS.rateWindowMs))
					this.rate.delete(k);
		const log = (this.rate.get(key) ?? []).filter(
			(t) => now - t < INTERVALS.rateWindowMs,
		);
		if (log.length >= cap) {
			this.rate.set(key, log);
			return false;
		}
		log.push(now);
		this.rate.set(key, log);
		return true;
	}

	/**
	 * A message from a peer for some of this node's agents. Stored under the
	 * same id (a redelivery changes nothing and is not pushed again), checked
	 * against inbound policy and rate limits, then delivered locally.
	 */
	private async receive(
		peer: Peer,
		f: Extract<UpFrame, { type: "deliver" }>,
		userCapable: boolean,
	): Promise<FrameResult> {
		const { store, registry, router, waiters } = this.service;
		const m = f.message as Partial<Message> | undefined;
		if (
			!m ||
			typeof m.id !== "string" ||
			typeof m.threadId !== "string" ||
			typeof m.body !== "string" ||
			typeof m.fromId !== "string" ||
			m.fromId.includes("/") ||
			!Array.isArray(f.targets) ||
			f.targets.length > LIMITS.maxSendIds
		)
			return fail("bad_request", "malformed delivery");
		if (m.body.length > LIMITS.maxBody)
			return fail("too_large", "body too large");
		const targets = [
			...new Set(
				f.targets.filter(
					(t): t is string =>
						typeof t === "string" && (!t.includes("/") || isLocalSubagentId(t)),
				),
			),
		];

		let sender: Agent;
		const from = f.from;
		if (from?.kind === "user") {
			if (!userCapable)
				return fail(
					"forbidden",
					"only your own nodes send as you; this node is allowed as a peer",
				);
			const user = this.forwardedUser(from);
			authorize(user, "send");
			sender = registry.remoteUser(
				peer.machineId,
				from.login,
				clean(String(from.node), 100) || peer.name,
			);
		} else if (from?.kind === "agent") {
			// A peer names only senders it shares: one of its agents (its
			// registry stream), or the person at its terminal. Never a name
			// it made up, never another machine's agent.
			const address = `${peer.machineId}/${m.fromId}`;
			if (m.fromId === "cli:operator")
				sender = {
					...this.sender(address, `operator@${peer.name}`)!,
					harness: "cli",
				};
			else {
				const known = peer.fed.has(m.fromId)
					? registry.find(address)
					: undefined;
				if (!known)
					return fail(
						"unknown_sender",
						`${clean(m.fromId, 80)} is not an agent ${peer.name} shares (yet)`,
					);
				sender = known;
			}
		} else return fail("bad_request", "a delivery names its sender");

		const copy: Message = {
			id: m.id.slice(0, 100),
			threadId: m.threadId.slice(0, 100),
			fromId: sender.id,
			// The vouched sender's name, never the frame's free text.
			fromName: sender.name,
			to: String(m.to ?? "").slice(0, 4000),
			body: m.body,
			priority:
				m.priority === "urgent" || m.priority === "fyi" ? m.priority : "normal",
			replyTo: typeof m.replyTo === "string" ? m.replyTo : null,
			expectReply: m.expectReply === true,
			createdAt: Number(m.createdAt) || Date.now(),
		};
		// How the sender tracks it; an older sender's single-recipient ask gets the full treatment.
		const tracked =
			m.tracked === 1 || m.tracked === 2
				? m.tracked
				: copy.expectReply
					? targets.length === 1
						? 2
						: 1
					: 0;
		if (copy.expectReply && tracked) copy.tracked = tracked;
		const receipts2 = this.peerHas(peer.machineId, RECEIPTS2);
		const now = Date.now();
		const already = store.getMessage(copy.id) !== null;
		if (!already) {
			if (
				!this.checkRate(
					`peer:${peer.machineId}`,
					this.iv.peerSendsPerMinute,
					now,
				)
			)
				return fail(
					"rate_limited",
					`at most ${this.iv.peerSendsPerMinute} messages a minute from ${peer.name}`,
				);
			const broadcast = copy.to === "*";
			if (
				!this.checkRate(
					broadcast ? `${sender.id}#*` : sender.id,
					broadcast ? LIMITS.broadcastsPerMinute : LIMITS.sendsPerMinute,
					now,
				)
			)
				return fail(
					"rate_limited",
					broadcast
						? `at most ${LIMITS.broadcastsPerMinute} broadcasts a minute`
						: `at most ${LIMITS.sendsPerMinute} messages a minute`,
				);
		}
		// A reply counts as one only from a recipient of the message it answers:
		// a peer can't settle another agent's `ask` by naming any message id.
		if (copy.replyTo) {
			const recipients = store.receiptIdsWithPrefix(copy.replyTo, sender.id);
			if (!recipients.has(sender.id)) copy.replyTo = null;
		}
		const isNew = store.addMessage(copy, {
			originMachine: peer.machineId,
			receivedAt: now,
		});
		const stored = store.getMessage(copy.id)!;
		if (!isNew) {
			// Only the peer that delivered it first may redeliver it: an id is
			// no secret (broadcasts carry it pool-wide), its receipts are.
			if (store.originOf(stored.id) !== peer.machineId)
				return fail("conflict", `message id ${copy.id} is already taken`);
			// A redelivery (our earlier answer was lost): report, never push again.
			const wanted = new Set(targets);
			return {
				ok: true,
				duplicate: true,
				receipts: store
					.receiptsFor(stored.id)
					.filter((r) => wanted.has(r.agentId))
					.map((r) => fedReceipt(r, receipts2)),
			};
		}

		const parent = copy.replyTo ? store.getMessage(copy.replyTo) : null;
		if (parent) store.markReplied(sender.id, parent.id, now);
		const receipts: Receipt[] = [];
		const names: string[] = [];
		for (const id of targets) {
			const agent = registry.get(id) ?? (await this.subagentTarget(id));
			if (agent && agent.status !== "gone") {
				receipts.push(await router.deliver(copy, sender, agent));
				names.push(agent.name);
				continue;
			}
			const human = registry.human(id);
			if (human) {
				// A reply for the operator or the user: they read it later (inbox, the app).
				receipts.push(
					writeReceipt(store, copy.id, human, "queued", null, null),
				);
				names.push(human.name);
				continue;
			}
			receipts.push(
				writeReceipt(
					store,
					copy.id,
					{ ...this.sender(`${this.machineId}/${id}`, id)!, id },
					"failed",
					"pool",
					`no live agent ${id} on ${this.service.machine}`,
				),
			);
		}
		this.service.events.emit("message", { message: copy, recipients: names });
		if (parent) waiters.resolveReplies(parent.id, delivered(copy, sender));
		store.trackSet({
			messageId: copy.id,
			machineId: peer.machineId,
			targets,
			sig: receiptSig(receipts),
			// A tracked message's receipts go back until it can no longer change.
			until: copy.tracked
				? now + this.service.deliveries.config.ttlMs + 60_000
				: now + 30 * 60_000,
		});
		return {
			ok: true,
			receipts: receipts.map((r) => fedReceipt(r, receipts2)),
		};
	}

	/** A user action a peer forwarded, re-authorized here as that user. */
	private async perform(
		peer: Principal,
		link: Peer,
		as: Partial<FedOrigin> | undefined,
		action: FedAction,
	): Promise<FrameResult> {
		const user = this.origin(peer, as);
		// Every forwarded action leaves an audit row (who forwarded it, for whom).
		this.service.store.audit({
			at: Date.now(),
			principal: `${principalLabel(peer)} for ${principalLabel(user)}`,
			op: `fed.${clean(String(action?.op ?? "?"), 40)}`,
			target:
				"agent" in (action ?? {})
					? clean(String((action as { agent: unknown }).agent), 300)
					: "id" in (action ?? {})
						? clean(String((action as { id: unknown }).id), 300)
						: null,
			detail: null,
			ok: true,
		});
		switch (action?.op) {
			case "transcript.page": {
				authorize(user, "transcript.read", action.agent);
				if (!this.knows(String(action.agent)))
					return fail("not_found", `no agent ${String(action.agent)}`);
				const page = await this.service.transcripts.page(
					String(action.agent),
					typeof action.cursor === "string" ? action.cursor : null,
				);
				return { ok: true, page };
			}
			case "subagents.list": {
				const agent = String(action.agent);
				authorize(user, "agents");
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				return { ok: true, list: await this.service.subagents.list(agent) };
			}
			case "transcript.image": {
				authorize(user, "transcript.read", action.agent);
				if (!this.knows(String(action.agent)))
					return fail("not_found", `no agent ${String(action.agent)}`);
				const image = await this.service.transcripts.image(
					String(action.agent),
					String(action.imageId),
				);
				return {
					ok: true,
					mediaType: image.mediaType,
					data: image.data.toString("base64"),
				};
			}
			case "changes.summary": {
				const agent = String(action.agent);
				authorize(user, "transcript.read", agent);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				const summary = await this.service.changes.summary(
					agent,
					action.mode === "base" ? "base" : "worktree",
				);
				return { ok: true, summary };
			}
			case "changes.file": {
				const agent = String(action.agent);
				authorize(user, "transcript.read", agent);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				const diff = await this.service.changes.file(
					agent,
					action.mode === "base" ? "base" : "worktree",
					String(action.path).slice(0, 4096),
				);
				return { ok: true, diff };
			}
			case "attachments.chunk": {
				const agent = String(action.agent);
				if (user.kind !== "human")
					return fail(
						"forbidden",
						"only the human operator attaches files on other machines",
					);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				const data = Buffer.from(String(action.data ?? ""), "base64");
				if (data.length > ATTACH_LIMITS.chunkBytes)
					return fail("too_large", "chunk over 1 MB");
				// Only into this login's open upload, checked against its signed hashes.
				const r = await this.service.attachments.write(
					user.login,
					agent,
					String(action.upload).slice(0, 100),
					Number(action.index),
					Number(action.offset),
					data,
				);
				return { ok: true, ...r };
			}
			case "files.search": {
				const agent = String(action.agent);
				authorize(user, "transcript.read", agent);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				const files = await this.service.files.search(
					agent,
					String(action.q ?? "").slice(0, 200),
				);
				return { ok: true, files };
			}
			case "git.read": {
				const agent = String(action.agent);
				authorize(user, "transcript.read", agent);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				if (action.what === "pr")
					return { ok: true, pr: await this.service.git.pr(agent) };
				return { ok: true, status: await this.service.git.status(agent) };
			}
			case "issue.read": {
				const agent = String(action.agent);
				authorize(user, "transcript.read", agent);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				return { ok: true, issue: await this.service.issues.details(agent) };
			}
			case "stop.options": {
				const agent = String(action.agent);
				if (user.kind !== "human")
					return fail(
						"forbidden",
						"only the human operator stops agents on other machines",
					);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				const options = await this.service.approvals.passkeys.stopOptions(
					user.login,
					this.rpFor(link),
					agent,
					`node:${link.node.nodeId}`,
				);
				return { ok: true, options };
			}
			case "stop": {
				const agent = String(action.agent);
				if (user.kind !== "human")
					return fail(
						"forbidden",
						"only the human operator stops agents on other machines",
					);
				if (!this.service.registry.get(agent))
					return fail("not_found", `no agent ${agent}`);
				// This node's own challenge, credential and expected origin.
				const signer = await this.service.approvals.passkeys.verifyStop(
					user.login,
					this.rpFor(link),
					agent,
					action.assertion,
				);
				const result = await this.service.stopAgent(
					{ ...user, verified: true },
					agent,
				);
				this.service.store.audit({
					at: Date.now(),
					principal: principalLabel(user),
					op: "stop.relayed",
					target: agent,
					detail: JSON.stringify({ device: signer.device, via: link.name }),
					ok: true,
				});
				return { ok: true, result };
			}
			case "acting.options": {
				// This node's own challenge, bound to the op, target and params.
				const options = await this.service.acting.optionsFor(
					user,
					this.rpFor(link),
					relayedAct(action),
					`node:${link.node.nodeId}`,
				);
				return { ok: true, options };
			}
			case "acting.run": {
				// Verified here with this node's challenge and credentials; the
				// frame itself grants nothing.
				const result = await this.service.acting.runFor(
					user,
					this.rpFor(link),
					{ ...relayedAct(action), assertion: action.assertion },
					link.name,
				);
				return { ok: true, result };
			}
			case "launch.status":
			case "launch.options":
			case "launch.refs": {
				// Reads for the human operator only (checked by the service).
				const result = await this.service.launches.readHere(user, {
					op: action.op,
					id: String((action as { id?: unknown }).id ?? ""),
					cwd: String((action as { cwd?: unknown }).cwd ?? ""),
				} as LaunchRead);
				return { ok: true, result };
			}
			case "ask": {
				authorize(user, "lookup");
				const response = await this.service.ask.local(
					{
						question: String(action.question ?? "").slice(0, 2000),
						...(typeof action.selector === "string"
							? { selector: action.selector.slice(0, 4000) }
							: {}),
					},
					{ localOnly: true },
				);
				return { ok: true, response };
			}
			case "search.messages": {
				// Transcript text: the transcript.read rule, like a page read.
				authorize(user, "transcript.read");
				const found = this.service.messages.local(
					String(action.q ?? "").slice(0, 200),
					{ limit: Math.max(1, Math.min(Number(action.limit) || 20, 20)) },
				);
				return { ok: true, hits: found.hits };
			}
			case "approval.options": {
				// Only this node's own prompts: never relay on to a third node.
				if (String(action.id).includes("/"))
					return fail("not_found", "no such approval here");
				const decision = action.decision;
				if (
					!["allow-once", "allow-session", "deny", "answer"].includes(decision)
				)
					return fail(
						"bad_request",
						"decision: allow-once, allow-session, deny or answer",
					);
				const r = await this.service.approvals.options(
					user,
					this.rpFor(link),
					String(action.id),
					decision,
					{
						note: typeof action.note === "string" ? action.note : null,
						answer: action.answer,
						// The relaying node's bucket, from the link (not the frame).
						requester: `node:${link.node.nodeId}`,
					},
				);
				// Credentials are enrolled per node, with this node's own code.
				if ("register" in r)
					return fail(
						"no_passkey",
						`no passkey on ${this.service.machine} yet: open Pulsar on ${this.service.machine} and prove you're human there`,
					);
				return { ok: true, ...r };
			}
			case "approval.decide": {
				// The browser signed this node's challenge; verified here, like
				// a decision from this node's own app (only the origin differs).
				if (String(action.id).includes("/"))
					return fail("not_found", "no such approval here");
				const decision = action.decision;
				if (
					!["allow-once", "allow-session", "deny", "answer"].includes(decision)
				)
					return fail(
						"bad_request",
						"decision: allow-once, allow-session, deny or answer",
					);
				// No `session` is passed: a peer's word is never a passkey session
				// here, so without an assertion this is refused (`session_required`).
				const response = await this.service.approvals.decide(
					user,
					this.rpFor(link),
					String(action.id),
					{
						decision,
						...(typeof action.note === "string" ? { note: action.note } : {}),
						...(action.answer !== undefined ? { answer: action.answer } : {}),
						assertion: action.assertion,
					},
				);
				return { ok: true, response };
			}
			case "usage.rows": {
				authorize(user, "usage");
				const period = USAGE_PERIODS.includes(action.period)
					? action.period
					: "7d";
				const tz = Math.max(-1440, Math.min(1440, Number(action.tz) || 0));
				return { ok: true, usage: this.service.usage.local(period, tz) };
			}
			case "usage.agent": {
				const agent = this.service.registry.get(String(action.agent));
				authorize(user, "usage");
				if (!agent)
					return fail("not_found", `no agent ${String(action.agent)}`);
				return { ok: true, usage: this.service.usage.localAgent(agent) };
			}
			default:
				return fail(
					"unsupported",
					`unknown action ${String((action as { op?: unknown })?.op).slice(0, 40)}`,
				);
		}
	}
}

/** An acting frame's act, checked for shape (the op name by the service). */
function relayedAct(action: {
	name: unknown;
	agent: unknown;
	params: unknown;
}): RelayedAct {
	return {
		op: String(action.name).slice(0, 40) as RelayedAct["op"],
		agent: typeof action.agent === "string" ? action.agent.slice(0, 300) : null,
		params: action.params ?? null,
	};
}

/** What changed in a message's receipts, for the tracking signature. */
function receiptSig(receipts: Receipt[]): string {
	return JSON.stringify(
		receipts.map((r) => [r.agentId, r.state, r.detail, r.attempt ?? 1]),
	);
}
