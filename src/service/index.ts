import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ClientErrors } from "../diagnostics/client-errors.ts";
import {
	type LocalDiagnosticsDeps,
	LocalDiagnosticsRunner,
} from "../diagnostics/local.ts";
import { diagnosticsList, machineDiagnostics } from "../diagnostics/pool.ts";
import { execStats } from "../exec.ts";
import { PoolAdmin, type PoolVerb } from "../federation/admin.ts";
import { PoolMembers } from "../federation/members.ts";
import { type TailnetStatus, TailscaleTailnet } from "../federation/tailnet.ts";
import { gitInfoAsync } from "../git.ts";
import { codexThreadIdentity } from "../harnesses/codex-child-ident.ts";
import { DRIVERS, driverFor } from "../harnesses/index.ts";
import { opencodeSessionIdentity } from "../harnesses/opencode-ident.ts";
import type { LocalAnswerCheck, PromptRef } from "../harnesses/types.ts";
import { HostedCatalog, hostedReport } from "../hosted/catalog.ts";
import {
	unavailableHostedDetail,
	viewHostedDetail,
} from "../hosted/details.ts";
import { hostedDetailParams } from "../hosted/wire.ts";
import { HostedWrites } from "../hosted/writes.ts";
import type {
	AgentUsage,
	AskRequest,
	AskResponse,
	DiagnosticsReport,
	MachineDiagnostics,
	SendDone,
	StopResult,
	UsagePeriod,
	UsageReport,
} from "../http/wire.ts";
import { daemonLog } from "../log.ts";
import {
	cleanMachineName,
	hostMachineName,
	tailscaleName,
} from "../machine.ts";
import { stateDir } from "../paths.ts";
import { nativeProvider, type PresenceProvider } from "../presence/native.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import {
	type Agent,
	type AgentStatus,
	type AppStatus,
	PROTOCOL_VERSION,
	type Priority,
	type PublicAgent,
	type Registration,
} from "../types.ts";
import { Usage, type UsageOptions } from "../usage/index.ts";
import { VERSION } from "../version.ts";
import { Acting } from "./acting.ts";
import { AppApi } from "./app.ts";
import {
	type ApprovalRequest,
	Approvals,
	type InteractionAdapter,
	type InteractionRequest,
} from "./approvals.ts";
import { withoutTranscriptText } from "./ask-core.ts";
import { Attachments } from "./attachments.ts";
import { authorize, isOp, type Op } from "./authorize.ts";
import {
	agentIdOf,
	type Caller,
	OPERATOR_ID,
	type Principal,
} from "./caller.ts";
import type { CatalogPorts } from "./catalog.ts";
import { Changes } from "./changes.ts";
import { ClaudeChildHooks } from "./claude-child-hooks.ts";
import { type ControlPorts, Controls } from "./controls.ts";
import { Deliveries, type DeliveryConfig } from "./delivery.ts";
import { EnrollGate } from "./enroll.ts";
import { EventBus, type ServiceEvents } from "./events.ts";
import { Files } from "./files.ts";
import { GitOps } from "./git.ts";
import { cleanPrompt, KINDS } from "./interactions.ts";
import { Interest } from "./interest.ts";
import { Interrupts } from "./interrupts.ts";
import { IssueOps } from "./issues.ts";
import { Jobs, LagMonitor } from "./jobs.ts";
import { type LaunchDeps, Launches } from "./launch.ts";
import { INTERVALS, LIMITS } from "./limits.ts";
import { Lookup } from "./lookup.ts";
import { Mailbox } from "./mailbox.ts";
import { BACKFILL_MS, MessageSearch } from "./message-search.ts";
import { SqlitePasskeyStore } from "./passkey-store.ts";
import { Passkeys } from "./passkeys.ts";
import {
	isLocalSubagentId,
	isRemote,
	type PoolView,
	SUB_MARK,
} from "./pool.ts";
import { PrReviewOps } from "./pr-review.ts";
import { Presence } from "./presence.ts";
import { Push, type PushOptions } from "./push.ts";
import { Queue } from "./queue.ts";
import { Registry } from "./registry.ts";
import { Router } from "./router.ts";
import { ServerInteractions } from "./server-interactions.ts";
import { Sessions } from "./sessions.ts";
import { Subagents } from "./subagents.ts";
import {
	driverMissing,
	driverTranscript,
	subagentMissing,
	type TranscriptMissing,
	Transcripts,
} from "./transcripts.ts";
import { Turns } from "./turns.ts";
import { UserSessions } from "./user-sessions.ts";
import { clampInt, toPublic } from "./util.ts";
import { Views } from "./views.ts";
import { Waiters } from "./waiters.ts";

export {
	Acting,
	type ActingHandler,
	type ActTarget,
	actDigest,
} from "./acting.ts";
export {
	ACTING_OPS,
	type ActingOp,
	ALL_OPS,
	authorize,
	authorizeForwarded,
	FED_OPS,
	HTTP_OPS,
	type Op,
} from "./authorize.ts";
export type { Caller, Principal } from "./caller.ts";
export type { RelyingParty } from "./passkeys.ts";

export interface ServiceOptions {
	store: Store;
	/** Run the harness scanners (off in most tests). */
	scan?: boolean;
	/**
	 * Message search: off (no index; the stored copy is deleted on start),
	 * a forced engine (tests), the backfill interval.
	 */
	search?: { off?: boolean; engine?: "fts5" | "memory"; backfillMs?: number };
	/** Owned by launchd/systemd: the `shutdown` RPC is refused. */
	serviceMode?: boolean;
	/** Whether the daemon serves the app, for `status` (doctor). */
	appStatus?: () => AppStatus;
	/** A fixed machine name; otherwise detected (Tailscale, else the host name). */
	machine?: string;
	/** Called after a successful `shutdown` reply; exits the process by default. */
	onShutdown?: () => void;
	/** Where an agent's transcript is; the harness driver's by default (tests use fixtures). */
	transcripts?: {
		pollMs?: number;
		resolveMs?: number;
		resolve?: (agent: Agent) => ResolvedTranscript | null;
		/** Why an agent has no transcript (default: its driver's answer). */
		missing?: (agent: Agent) => TranscriptMissing;
	};
	/** Attachments: the folder they are saved in (tests use a temp folder). */
	attachments?: { dir?: () => string };
	/** Modes and slash commands: tmux, harness APIs and config folders (tests pass fakes). */
	controls?: { ports?: Partial<ControlPorts>; catalog?: Partial<CatalogPorts> };
	/** Issue detection: ask gh which issue an agent's PR closes (default: `scan`). */
	issues?: { prLookup?: boolean };
	/** Worktree changes: poll and debounce timers (tests shorten them). */
	changes?: { pollMs?: number; debounceMs?: number };
	/** Token usage: session folders and how often to read them (tests use fixtures). */
	usage?: UsageOptions & { intervalMs?: number; scan?: boolean };
	/** Web Push: where the VAPID keys live (the state folder by default) and how to send (tests). */
	push?: { keyFile?: string; send?: PushOptions["send"] };
	/** Finish and fail notifications (tests shorten the grace). */
	turns?: { graceMs?: number };
	/** Pool membership: where to write the display copy (`pool.json`). */
	pool?: { mirror?: string };
	/** Launches: a private tmux server, shell and harness command (tests). */
	launch?: Partial<
		Pick<LaunchDeps, "tmux" | "shell" | "command" | "timing" | "send">
	>;
	/**
	 * Presence checks: the OS prompt (this platform's by default; tests pass
	 * a fake or null) and how long the person has to answer.
	 */
	presence?: {
		native?: PresenceProvider | null;
		timeoutMs?: number;
		/** The last-resort terminal word (tests fake its terminal). */
		terminal?: EnrollGate | null;
	};
	/** Approvals: the daemon's timeout and the local-answer probe (tests override). */
	approvals?: {
		timeoutMs?: number;
		pollMs?: number;
		probe?: (agent: Agent, prompt: PromptRef) => LocalAnswerCheck | null;
		/** The interactive-tool adapter for an agent (the driver's by default). */
		adapter?: (agent: Agent) => InteractionAdapter | null;
		/** Overrides "can anyone answer from the app" (tests). */
		answerable?: () => boolean;
		/** The app is served on this node (the daemon's remote setting). */
		appServed?: () => boolean;
		/** The clock for prompt deadlines (tests). */
		now?: () => number;
	};
	/** Redelivery timers (docs/delivery.md); tests shorten them. */
	delivery?: Partial<DeliveryConfig>;
	/** Poll harness servers for prompts (OpenCode); defaults to `scan`. */
	serverInteractions?: boolean;
	/** Diagnostics: how doctor runs (the daemon's own CLI by default; tests fake it). */
	diagnostics?: Pick<LocalDiagnosticsDeps, "doctor" | "home" | "now">;
}

/**
 * The daemon's state and rules, independent of transport. Transports attach
 * a `Caller` per connection and pass each request to `handle`.
 */
export class PulsarService {
	readonly store: Store;
	readonly events = new EventBus();
	readonly sessions = new Sessions();
	readonly waiters = new Waiters();
	readonly registry: Registry;
	readonly router: Router;
	readonly mailbox: Mailbox;
	/** At-least-once delivery of tracked messages. */
	readonly deliveries: Deliveries;
	/** Live transcripts: `page(agentId, cursor?)` and `subscribe(agentId, fn)`. */
	readonly transcripts: Transcripts;
	/** Worktree changes for the diff viewer: `summary`, `file`, `watch`. */
	readonly changes: Changes;
	/** Agents' subagents: children kept apart from the registry. */
	readonly subagents: Subagents;
	private readonly claudeChildHooks: ClaudeChildHooks;
	/** Stop: interrupting agents' turns. */
	readonly interrupts: Interrupts;
	/** Acting ops (attachments, launch, git): Prove Human here, home-node proof for remote agents. */
	readonly acting: Acting;
	/** Files attached to messages, saved on the agent's machine. */
	readonly attachments: Attachments;
	/** The composer's `@` file list (git ls-files in the agent's folder). */
	readonly files: Files;
	readonly controls: Controls;
	/** Starting agents from the app (`agents.launch`). */
	readonly launches: Launches;
	/** Git actions on agents' worktrees: status, PR, and the git.* acting ops. */
	readonly git: GitOps;
	readonly issues: IssueOps;
	readonly prReview: PrReviewOps;
	/** The queue strip: messages not yet in an agent's conversation (withdraw, send now, edit). */
	readonly queue: Queue;
	/** This node's passkeys (approvals and passkey sessions share them). */
	readonly passkeys: Passkeys;
	/** Passkey sessions: what the app shows to act as the user. */
	readonly userSessions: UserSessions;

	/** Ask without waking anyone: `ask.local({question, selector?})`. */
	readonly ask: Lookup;
	/** Token usage read from harness session files, and its API estimate. */
	readonly usage: Usage;
	readonly hosted = new HostedCatalog();
	/** This machine's `pulsar doctor` report for the app (src/diagnostics/). */
	readonly diagnostics: { local: LocalDiagnosticsRunner };
	/** App load errors the app reported (`POST /client-errors`; doctor shows them). */
	readonly clientErrors = new ClientErrors();
	private readonly usageOpts: ServiceOptions["usage"];
	/** Full-text search over transcripts (`GET /search/messages`). */
	readonly messages: MessageSearch;
	/** Pool views and user sends for the app (HTTP transport). */
	readonly app: AppApi;
	/** Permission prompts from harness hooks, decided with a passkey; first answer wins. */
	readonly approvals: Approvals;
	/** Web Push to the app for new approvals (subscriptions on this node). */
	readonly push: Push;
	/** Agents the operator recently started, messaged or opened (notifications go to these). */
	readonly interest: Interest;
	/** Finished and failed turns (`agent:turn`, `notify`). */
	readonly turns: Turns;
	/** Who may be in the pool (by Tailscale node id), held here. */
	readonly poolMembers: PoolMembers;
	/** `pulsar mesh allow|deny|forget|owner`: resolve, confirm at the terminal, audit, announce. */
	readonly poolAdmin: PoolAdmin;
	readonly presence: Presence;
	/** How `pulsar mesh` resolves node names: federation's tailnet once it runs. */
	poolStatus: () => Promise<TailnetStatus | null> = async () =>
		new TailscaleTailnet(7337).status();
	/** Federation drops a peer whose binding `pulsar mesh forget` removed. */
	onPoolForget: (machineId: string) => void = () => {};
	/** Set by federation: the pool's members or owner changed. */
	onPoolChange: () => void = () => {};
	readonly serviceMode: boolean;
	private readonly appStatus: () => AppStatus;
	private readonly scan: boolean;
	private readonly searchBackfillMs: number;
	/** Relays prompts kept on harness servers (OpenCode); null when off. */
	private readonly serverPrompts: ServerInteractions | null;
	private readonly onShutdown: () => void;
	private timers: NodeJS.Timeout[] = [];
	/** Background jobs: single-flight, backing off when the machine is slow. */
	readonly jobs = new Jobs();
	/** Event-loop lag, with the jobs running when it stalls. */
	readonly lag = new LagMonitor(() => this.jobs.running());
	private lastActivity = Date.now();
	private tails = new WeakSet<Caller>();
	/** Agents each caller follows with `transcript.read {follow}` (one subscription each). */
	private follows = new WeakMap<Caller, Set<string>>();
	private readonly fixedMachine: boolean;
	private stopped = false;

	constructor(opts: ServiceOptions) {
		this.store = opts.store;
		this.scan = opts.scan ?? true;
		this.searchBackfillMs = opts.search?.backfillMs ?? BACKFILL_MS;
		this.serviceMode = opts.serviceMode ?? false;
		this.appStatus = opts.appStatus ?? (() => ({ state: "off" }));
		this.onShutdown =
			opts.onShutdown ?? (() => setTimeout(() => process.exit(0), 50).unref());
		this.fixedMachine = Boolean(opts.machine);
		this.registry = new Registry({
			store: this.store,
			sessions: this.sessions,
			events: this.events,
			waiters: this.waiters,
			machine: opts.machine
				? cleanMachineName(opts.machine)
				: hostMachineName(),
		});
		this.subagents = new Subagents({
			registry: this.registry,
			events: this.events,
		});
		this.registry.discoveredSubagents = () => this.subagents.addressable();
		this.registry.discoveredSubagent = (id) => this.subagents.localTarget(id);
		this.registry.nativeSubagentAliases = () => this.subagents.nativeAliases();
		this.registry.nativeSubagentTarget = (id) => this.subagents.aliasTarget(id);
		this.claudeChildHooks = new ClaudeChildHooks({
			registry: this.registry,
			store: this.store,
			agentFor: (id) => this.subagents.agentFor(id),
			refresh: (id) => this.subagents.refresh(id),
		});
		this.subagents.hookCanDeliver = (parent, key) =>
			this.claudeChildHooks.isActive(parent, key);
		this.subagents.hookIdentity = (child) =>
			this.claudeChildHooks.applyIdentity(child);
		this.router = new Router({
			store: this.store,
			registry: this.registry,
			sessions: this.sessions,
			waiters: this.waiters,
			resolveSubagent: (id) => this.subagents.resolveLocalTarget(id),
		});
		this.mailbox = new Mailbox({
			store: this.store,
			registry: this.registry,
			router: this.router,
			waiters: this.waiters,
			events: this.events,
			resolveSubagent: (id) => this.subagents.resolveLocalTarget(id),
		});
		this.deliveries = new Deliveries({
			store: this.store,
			registry: this.registry,
			router: this.router,
			waiters: this.waiters,
			events: this.events,
			...(opts.delivery ? { config: opts.delivery } : {}),
		});
		this.router.onHandoff = (m, agent, r) =>
			this.deliveries.handedOff(m, agent, r);
		this.router.onUncertain = (receipt) => {
			this.store.setDelivery(receipt.messageId, receipt.agentId, {
				dueAt: null,
			});
			this.deliveries.settle(receipt.messageId, receipt);
		};
		this.mailbox.onRead = (agent, messages) =>
			this.deliveries.readFromInbox(agent, messages);
		this.registry.onGone = (agent) => this.deliveries.gone(agent);
		this.registry.onBack = (agent) => {
			void this.deliveries.back(agent);
			void this.router.releaseNextTurn(agent);
		};
		this.passkeys = new Passkeys(new SqlitePasskeyStore(this.store));
		this.approvals = new Approvals({
			store: this.store,
			registry: this.registry,
			events: this.events,
			...opts.approvals,
			passkeys: this.passkeys,
			probe:
				opts.approvals?.probe ??
				((agent, prompt) =>
					driverFor(agent.harness)?.approvals?.watch(agent, prompt) ?? null),
			adapter:
				opts.approvals?.adapter ??
				((agent) => driverFor(agent.harness)?.interactions ?? null),
		});
		this.serverPrompts =
			(opts.serverInteractions ?? this.scan)
				? new ServerInteractions({
						registry: this.registry,
						approvals: this.approvals,
					})
				: null;
		this.userSessions = new UserSessions({
			store: this.store,
			passkeys: this.passkeys,
		});

		this.interrupts = new Interrupts({
			registry: this.registry,
			sessions: this.sessions,
			store: this.store,
		});
		this.acting = new Acting({
			registry: this.registry,
			store: this.store,
			passkeys: this.passkeys,
			machineId: () => this.machineId,
			machine: () => this.machine,
			relay: () => this.registry.pool,
		});
		this.git = new GitOps({
			registry: this.registry,
			acting: this.acting,
			pool: () => this.registry.pool,
		});
		this.prReview = new PrReviewOps({
			registry: this.registry,
			acting: this.acting,
			pool: () => this.registry.pool,
		});
		this.queue = new Queue({
			store: this.store,
			registry: this.registry,
			router: this.router,
			deliveries: this.deliveries,
			events: this.events,
			acting: this.acting,
		});
		this.presence = new Presence({
			native:
				opts.presence?.native !== undefined
					? opts.presence.native
					: nativeProvider(),
			terminal:
				opts.presence?.terminal !== undefined
					? opts.presence.terminal
					: new EnrollGate(),
			approvals: this.approvals,
			registry: this.registry,
			store: this.store,
			...(opts.presence?.timeoutMs
				? { timeoutMs: opts.presence.timeoutMs }
				: {}),
		});
		this.poolMembers = new PoolMembers(this.store, opts.pool?.mirror ?? null);
		this.poolAdmin = new PoolAdmin({
			members: this.poolMembers,
			store: this.store,
			events: this.events,
			presence: this.presence,
			machine: () => this.machine,
			status: () => this.poolStatus(),
			onForget: (id) => this.onPoolForget(id),
			onChange: () => this.onPoolChange(),
		});
		this.interest = new Interest({ store: this.store });
		this.push = new Push({
			store: this.store,
			events: this.events,
			registry: this.registry,
			keyFile: opts.push?.keyFile ?? (() => join(stateDir(), "vapid.json")),
			...(opts.push?.send ? { send: opts.push.send } : {}),
		});
		this.app = new AppApi({
			registry: this.registry,
			store: this.store,
			mailbox: this.mailbox,
			views: new Views({
				registry: this.registry,
				store: this.store,
				machineId: () => this.machineId,
				approvalFor: (id) => this.approvals.current(id),
				expiredBefore: (agent, since) =>
					this.approvals.expiredBefore(agent, since),
				canStop: (agent) => this.interrupts.can(agent),
				subagents: (id) => this.subagents.counts(id),
			}),
			machine: () => ({ id: this.machineId, name: this.machine }),
			subagents: this.subagents,
		});
		this.acting.onActed = (id) => {
			if (id) this.interest.note(id);
		};
		this.app.onOperatorSend = (ids) => {
			for (const id of ids) this.interest.note(id);
		};
		this.launches = new Launches({
			registry: this.registry,
			events: this.events,
			store: this.store,
			acting: this.acting,
			machineId: () => this.machineId,
			machine: () => this.machine,
			send: async (user, agentId, body) => {
				const r = (await this.app.send(user, {
					ids: [agentId],
					body,
					priority: "normal",
					expectReply: false,
					dryRun: false,
				})) as SendDone;
				return r.receipts[0]?.state ?? null;
			},
			onAgent: (id) => this.interest.note(id),
			...opts.launch,
		});
		const hostedWrites = new HostedWrites(this.store, undefined, (provider) =>
			this.hosted.invalidate(provider),
		);
		this.acting.register("hosted.write", ({ user, params }) =>
			hostedWrites.run(user.login, params),
		);
		this.acting.register("agents.launch", ({ user, params }) =>
			this.launches.start(user, params),
		);
		this.registry.onRelease = (agent) => {
			void this.router.releaseHeld(agent);
			void this.router.releaseNextTurn(agent);
		};
		const resolveTranscript = opts.transcripts?.resolve ?? driverTranscript;
		this.issues = new IssueOps({
			registry: this.registry,
			pool: () => this.registry.pool,
			resolve: resolveTranscript,
			prLookup: opts.issues?.prLookup ?? this.scan,
			// Tests read only fixture transcripts, never the real HOME's.
			firstMessage: this.scan || !!opts.transcripts?.resolve,
		});
		this.transcripts = new Transcripts(
			(id) => {
				// A local subagent: a record made from its parent, never registered.
				if (isLocalSubagentId(id)) return this.subagents.agentFor(id);
				const agent = this.registry.find(id);
				return agent && !agent.id.includes("/") ? agent : undefined;
			},
			{
				...opts.transcripts,
				resolve: (agent) =>
					agent.meta.subagentOf
						? this.subagents.transcript(agent)
						: resolveTranscript(agent),
				ensure: (id) => this.subagents.row(id),
				missing: (agent) =>
					opts.transcripts?.missing?.(agent) ??
					(agent.meta.subagentOf
						? subagentMissing(agent)
						: opts.transcripts?.resolve
							? "not_found"
							: driverMissing(agent)),
			},
		);
		this.turns = new Turns({
			events: this.events,
			registry: this.registry,
			interest: this.interest,
			resolve: resolveTranscript,
			...(opts.turns?.graceMs !== undefined
				? { graceMs: opts.turns.graceMs }
				: {}),
		});
		this.changes = new Changes(
			(id) => {
				// The operator (a presence check from a terminal) has no folder: no_cwd.
				if (id === OPERATOR_ID) return this.registry.operator();
				const agent = this.registry.find(id);
				return agent && !agent.id.includes("/") ? agent : undefined;
			},
			{
				...opts.changes,
				store: this.store,
				...(this.scan || opts.transcripts?.resolve
					? { transcript: resolveTranscript }
					: {}),
				// An edit or a command shows in the transcript first: re-read then.
				activity: (id, fn) => this.transcripts.subscribe(id, () => fn()),
			},
		);
		const localAgent = (id: string) => {
			const agent = this.registry.find(id);
			return agent && !agent.id.includes("/") ? agent : undefined;
		};
		this.attachments = new Attachments({
			dir: opts.attachments?.dir ?? (() => join(stateDir(), "attachments")),
			isLocal: (id) => !!this.registry.get(id),
		});
		this.acting.register("attachments.upload", this.attachments.handler);
		this.files = new Files(localAgent);
		this.controls = new Controls({
			lookup: localAgent,
			sessions: this.sessions,
			acting: this.acting,
			...opts.controls,
		});
		this.ask = new Lookup({
			views: this.app.views,
			transcripts: this.transcripts,
		});
		this.usageOpts = opts.usage;
		this.usage = new Usage(this.store, opts.usage);
		// New session lines: the app's Usage page and usage lines re-read.
		this.usage.scanner.onStored = () =>
			this.events.emit("usage", { at: Date.now() });
		this.messages = new MessageSearch({
			store: this.store,
			transcripts: this.transcripts,
			registry: this.registry,
			views: this.app.views,
			...(opts.search?.engine ? { engine: opts.search.engine } : {}),
			off: opts.search?.off ?? false,
		});
		if (!this.messages.off) {
			this.transcripts.tailer.tap = this.messages.tap;
			this.app.extraFeatures = () => ["search"];
		}
		this.diagnostics = {
			local: new LocalDiagnosticsRunner({
				...opts.diagnostics,
				daemon: () => {
					const lag = this.lag.stats();
					return {
						agents: this.registry.live().length,
						eventLoop: { p99: lag.p99, max: lag.max, stalls: lag.stalls },
					};
				},
			}),
		};
	}

	/** Every machine in the pool, at once, reports to come (`GET /diagnostics`). */
	diagnosticsList(as: Principal): DiagnosticsReport {
		authorize(as, "diagnostics");
		return diagnosticsList(
			{ id: this.machineId, name: this.machine },
			this.registry.pool?.diagnostics ?? null,
		);
	}

	/**
	 * The pool's machines as Diagnostics lists them (id, name, version,
	 * reachable): the event hub announces `machines` when it changes.
	 */
	machinesKey(): string {
		const list = diagnosticsList(
			{ id: this.machineId, name: this.machine },
			this.registry.pool?.diagnostics ?? null,
		);
		return JSON.stringify(
			list.machines.map((m) => [m.machineId, m.name, m.version, !m.error]),
		);
	}

	/** One machine's doctor report, made by its own daemon (`GET /diagnostics/:machineId`). */
	machineDiagnostics(
		as: Principal,
		machineId: string,
		fresh: boolean,
	): Promise<MachineDiagnostics> {
		authorize(as, "diagnostics");
		return machineDiagnostics(
			{ id: this.machineId, name: this.machine },
			this.diagnostics.local,
			this.registry.pool?.diagnostics ?? null,
			machineId,
			as,
			fresh,
		);
	}

	async hostedTask(
		as: Principal,
		provider: unknown,
		id: unknown,
		machine?: unknown,
	) {
		authorize(as, "hosted");
		const parsed = hostedDetailParams.safeParse({ provider, id, machine });
		if (!parsed.success)
			throw new RpcError("bad_request", "Invalid hosted task or source");
		const request = {
			provider: parsed.data.provider,
			id: parsed.data.id,
			machineId: parsed.data.machine ?? this.machineId,
		};
		if (request.machineId === this.machineId) return viewHostedDetail(request);
		return (
			this.registry.pool?.hosted?.detail(
				request.provider,
				request.id,
				request.machineId,
				as,
			) ?? unavailableHostedDetail(request, "source-unreachable")
		);
	}

	async hostedTasks(as: Principal, fresh = false) {
		authorize(as, "hosted");
		const [providers, remote] = await Promise.all([
			this.hosted.observe(fresh),
			this.registry.pool?.hosted?.observe(as, fresh) ?? [],
		]);
		return hostedReport([
			{
				machineId: this.machineId,
				name: this.machine,
				state: "reachable",
				providers,
			},
			...remote,
		]);
	}

	/** The pool's token usage, priced on this node (`GET /usage`). */
	usageReport(
		period: UsagePeriod,
		tzMinutes: number,
		as: Principal,
	): Promise<UsageReport> {
		authorize(as, "usage");
		return this.usage.report(
			period,
			tzMinutes,
			{ id: this.machineId, name: this.machine },
			this.registry.pool?.usage ?? null,
			as,
		);
	}

	/**
	 * Warns (SSE `limit` and Web Push, via the `limit` event) about plan
	 * limits past a threshold: this machine's latest readings, and the
	 * peers' (asked now with `withPeers`, else their last answer).
	 */
	async warnLimits(withPeers: boolean): Promise<void> {
		const pool = withPeers ? (this.registry.pool?.usage ?? null) : null;
		for (const w of await this.usage.limitWarnings(pool))
			this.events.emit("limit", w);
	}

	/** One agent's tokens, cost and context (a remote one's from its home node). */
	async agentUsage(id: string, as: Principal): Promise<AgentUsage> {
		authorize(as, "usage");
		const agent = this.registry.find(id);
		if (!agent) throw new RpcError("not_found", `no agent ${id}`);
		if (!agent.id.includes("/"))
			return this.usage.priceAgent(
				agent.id,
				await this.usage.localAgent(agent),
			);
		const pool = this.registry.pool?.usage;
		if (!pool) throw new RpcError("not_found", `no agent ${id}`);
		return this.usage.priceAgent(agent.id, await pool.agentUsage(agent.id, as));
	}

	/**
	 * Ask across the pool: this machine's agents ranked here (with their
	 * logs), every reachable peer's ranked by its own node (with its logs),
	 * merged by score. Remote matches carry pool addresses. `missing` names
	 * machines that did not answer.
	 */
	async askPool(q: AskRequest, as: Principal): Promise<AskResponse> {
		const answer = await this.askPoolAll(q, as);
		// What other agents said is their transcript: agents (who read only
		// their own) get the metadata and touched files, not the text.
		return as.kind === "agent" ? withoutTranscriptText(answer) : answer;
	}

	private async askPoolAll(q: AskRequest, as: Principal): Promise<AskResponse> {
		const pool = this.registry.pool;
		if (!pool) return this.ask.local(q);
		const [mine, remote] = await Promise.all([
			this.ask.local(q, { localOnly: true }),
			pool.ask(q, as),
		]);
		const views = this.app.views;
		const matches = [...mine.matches];
		let total = mine.total;
		let scanned = mine.scanned;
		for (const { machineId, response } of remote.answers) {
			total += Number(response.total) || 0;
			scanned += Number(response.scanned) || 0;
			for (const m of response.matches) {
				const agent = this.registry.find(`${machineId}/${m.agent.id}`);
				if (!agent) continue;
				matches.push({
					agent: views.row(agent),
					score: Number(m.score) || 0,
					evidence: Array.isArray(m.evidence) ? m.evidence.map(String) : [],
				});
			}
		}
		matches.sort(
			(a, b) => b.score - a.score || b.agent.lastSeen - a.agent.lastSeen,
		);
		return {
			question: mine.question,
			intent: mine.intent,
			matches: matches.slice(0, Math.max(20, mine.matches.length)),
			total,
			scanned,
			...(remote.missing.length
				? { partial: true, missing: remote.missing }
				: {}),
		};
	}

	/**
	 * Joins the pool: views, selectors, sends and transcripts span every
	 * machine `pool` knows (federation calls this once it starts).
	 */
	attachPool(pool: PoolView | null) {
		this.registry.pool = pool;
		this.subagents.pool = pool;
		this.transcripts.remote = pool?.transcripts ?? null;
		this.changes.remote = pool?.changes ?? null;
		this.attachments.remote = pool?.attachments ?? null;
		this.files.remote = pool?.attachments ?? null;
		this.controls.remote = pool?.controls ?? null;
		this.approvals.remote = pool?.approvals ?? null;
		this.events.emit("pool", { machineId: null });
	}

	/** Starts the scanners and background jobs. Call once this daemon owns the socket. */
	start() {
		this.approvals.expireStale();
		this.push.start();
		this.turns.start();
		this.queue.start();
		this.lag.start();
		const jobs = this.jobs;
		if (this.scan) {
			// Each harness scanner on its own timer, plus one run now.
			for (const { id, scan } of this.registry.scanners())
				jobs.every(
					`scan:${id}`,
					scan.intervalMs,
					() => this.registry.runScan(id, scan),
					{ runNow: true },
				);
		}
		// Prompts kept on a harness's own server (OpenCode), relayed to the app.
		if (this.serverPrompts)
			for (const d of DRIVERS)
				if (d.serverInteractions) {
					const si = d.serverInteractions;
					jobs.every(`interactions:${d.id}`, si.intervalMs, () =>
						this.serverPrompts?.poll(d.id, si),
					);
				}
		// Busy/idle for harnesses that report none themselves (Codex).
		if (this.scan)
			for (const d of DRIVERS)
				if (d.liveStatus) {
					const ls = d.liveStatus;
					jobs.every(`status:${d.id}`, ls.intervalMs, async () => {
						const live = this.registry
							.all()
							.filter(
								(a) =>
									a.harness === d.id &&
									a.meta.acp !== "1" &&
									a.status !== "gone",
							);
						if (!live.length) return;
						for (const r of await ls.read(live))
							this.registry.applyLiveStatus(r.agent, r.status, r.since);
					});
				}
		// Session names kept by harnesses with no scan (Codex's thread index).
		if (this.scan)
			for (const d of DRIVERS)
				if (d.names) {
					const names = d.names;
					jobs.every(`names:${d.id}`, names.intervalMs, async () => {
						const live = this.registry
							.all()
							.filter(
								(a) =>
									a.harness === d.id &&
									a.meta.acp !== "1" &&
									a.status !== "gone",
							);
						if (!live.length) return;
						for (const r of await names.read(live))
							this.registry.applyHarnessName(r.agent, r.name, r.source);
					});
				}
		jobs.every("sweep", INTERVALS.sweepMs, () => this.registry.sweep());
		if (this.scan)
			jobs.every("refresh:activity", INTERVALS.subagentsMs, () =>
				this.registry.refreshActivity(),
			);
		// Token usage: new lines of the harnesses' session files. Never under
		// a test runner unless a test asks (it would read the real HOME's
		// session folders); PULSAR_USAGE_SCAN=0 turns it off.
		if (
			this.usageOpts?.scan ??
			(this.scan &&
				process.env.NODE_ENV !== "test" &&
				process.env.PULSAR_USAGE_SCAN !== "0")
		) {
			jobs.every(
				"usage",
				this.usageOpts?.intervalMs ?? INTERVALS.usageMs,
				async () => {
					await this.usage.scanner.scan();
					await this.warnLimits(false);
				},
				{ runNow: true },
			);
			// Peers' plan limits, so a limit on any machine warns here too. Only
			// for a node with a push subscription (each ask is a forwarded,
			// audited read); the app's Usage page asks the peers itself.
			jobs.every("limits:pool", INTERVALS.limitsPoolMs, () =>
				this.push.hasSubscriptions() ? this.warnLimits(true) : undefined,
			);
		}
		// Subagents: one cheap check per live agent; lists only what moved.
		if (this.scan)
			jobs.every("subagents", INTERVALS.subagentsMs, () =>
				this.subagents.sweep(),
			);
		jobs.every("delivery", this.deliveries.config.tickMs, () =>
			this.deliveries.tick(),
		);
		// Branches change under running agents (checkout, a new worktree): re-read git.
		jobs.every("refresh:git", INTERVALS.refreshGitMs, () =>
			this.registry.refreshGit(),
		);
		jobs.every("refresh:prs", INTERVALS.refreshPrsMs, () =>
			this.registry.refreshPrs(),
		);
		jobs.every("refresh:models", INTERVALS.refreshModelsMs, () =>
			this.registry.refreshModels(),
		);
		// The GitHub issue each agent works on (branch, PR, first message).
		jobs.every("refresh:issues", INTERVALS.refreshPrsMs, () =>
			this.issues.refresh(),
		);
		// Attachments past their week (a scanning daemon: tests' services skip it).
		if (this.scan)
			jobs.every(
				"attachments:gc",
				ATTACHMENTS_GC_MS,
				() => this.attachments.gc(),
				{ runNow: true },
			);
		jobs.every("prune", INTERVALS.pruneMs, () =>
			this.store.prune(Date.now(), LIMITS.messageRetentionMs),
		);
		// Message search: index what live tails missed, from where it stopped.
		if (this.messages.off) this.messages.index.clear();
		else
			jobs.every("search:backfill", this.searchBackfillMs, () =>
				this.messages.backfill(),
			);
		jobs.every("search:prune", INTERVALS.pruneMs, () => this.messages.prune());
		if (!this.fixedMachine) {
			// The host name serves until Tailscale answers; startup never waits for it.
			this.refreshMachine();
			this.timers.push(
				setInterval(() => this.refreshMachine(), INTERVALS.refreshMachineMs),
			);
		}
	}

	/** This machine's name (agents' `machine` field and tag). */
	get machine(): string {
		return this.registry.machine;
	}

	/** This machine's stable id (stored on first run). */
	get machineId(): string {
		return this.store.machineId();
	}

	/**
	 * Adopts the MagicDNS name when Tailscale answers. A failed or slow probe
	 * changes nothing, so the name never flaps back to the host name.
	 */
	private refreshMachine() {
		void tailscaleName().then((name) => {
			if (name && !this.stopped) this.registry.setMachine(name);
		});
	}

	/** Stops background jobs and drops pending waits. The store stays open. */
	stop() {
		this.stopped = true;
		for (const t of this.timers) clearInterval(t);
		this.timers = [];
		this.jobs.stop();
		this.lag.stop();
		this.registry.closed = true;
		this.registry.clearHeld();
		this.waiters.clear();
		this.transcripts.close();
		this.serverPrompts?.stop();
		this.presence.stop();
		this.approvals.stop();
		this.push.stop();
		this.turns.stop();
		this.queue.stop();
	}

	/** Tracks a new caller until its `closed` signal aborts. */
	attach(caller: Caller) {
		this.sessions.add(caller);
		this.touch();
		caller.closed.addEventListener(
			"abort",
			() => {
				const role = this.sessions.role(caller);
				const id = agentIdOf(caller.principal);
				const parent = id ? this.registry.get(id)?.meta.subagentOf : undefined;
				this.sessions.remove(caller);
				this.touch();
				this.registry.detach(caller, role);
				if (parent && !this.registry.closed)
					void this.subagents.refresh(parent);
			},
			{ once: true },
		);
	}

	/** Marks the daemon as in use (a request or a connection change). */
	touch() {
		this.lastActivity = Date.now();
	}

	/** True once nothing has used the daemon for a while; the CLI exits then. */
	idleTooLong(now = Date.now()) {
		return (
			this.sessions.size === 0 && now - this.lastActivity > LIMITS.idleExitMs
		);
	}

	authorize(principal: Principal, op: Op, target?: string) {
		authorize(principal, op, target);
	}

	/** Records how a socket connection serves its agent (said in `hello`). */
	setRole(caller: Caller, role: Registration["role"]) {
		this.sessions.setRole(caller, role);
	}

	/** Refuses a second MCP connection for a session id that is already served. */
	checkClaim(caller: Caller, reg: Registration) {
		this.registry.checkClaim(caller, reg);
	}

	/**
	 * A CLI run from an agent's shell speaks as that agent but never owns its
	 * presence. The caller becomes that agent's principal.
	 */
	borrowAgent(caller: Caller, reg: Registration) {
		const id = this.registry.agentId(reg.harness, reg.sessionId, reg.pid);
		if (isLocalSubagentId(id))
			throw new RpcError(
				"forbidden",
				"subagent identity must be proved by its extension",
			);
		const agent =
			this.registry.get(id) ??
			this.registry.upsert({
				harness: reg.harness,
				sessionId: reg.sessionId,
				pid: reg.pid,
				cwd: reg.cwd,
				project: reg.project,
				branch: reg.branch,
				tags: reg.tags ?? [],
				meta: reg.meta ?? {},
				registered: false,
			});
		caller.principal = { kind: "agent", agentId: agent.id };
		this.sessions.bind(caller);
		return agent;
	}

	/** An MCP server or extension registers its session; the caller becomes that agent. */
	async registerOmpChild(caller: Caller, reg: Registration): Promise<Agent> {
		const child = reg.subagent;
		if (
			reg.role !== "extension" ||
			reg.harness !== "omp" ||
			!reg.pid ||
			!Number.isSafeInteger(reg.pid) ||
			reg.pid < 2 ||
			!child ||
			typeof child.key !== "string" ||
			!/^[A-Za-z0-9._-]{1,100}$/.test(child.key) ||
			typeof child.file !== "string" ||
			child.file.length > 4096 ||
			!isAbsolute(child.file) ||
			agentIdOf(caller.principal)
		)
			throw new RpcError("bad_request", "invalid OMP subagent registration");
		const agent = await this.subagents.ompChild(reg.pid, child.key, child.file);
		if (caller.closed.aborted || !agent)
			throw new RpcError("not_found", "no live OMP subagent owns that file");
		if (this.registry.connectedSubagent(agent.id))
			throw new RpcError(
				"session_claimed",
				"this OMP subagent already has a connection",
			);
		agent.pid = reg.pid;
		agent.registered = true;
		if (reg.capabilities?.includes("acks")) agent.meta.acks = "1";
		this.registry.registerSubagent(agent);
		caller.principal = { kind: "agent", agentId: agent.id };
		this.sessions.bind(caller, reg.capabilities);
		this.events.emit("agent", { action: "join", agent: toPublic(agent) });
		void this.subagents.refresh(agent.meta.subagentOf!);
		return agent;
	}

	/** A native MCP connection speaks as a child after the harness verifies its lineage. */
	async bindNativeChild(
		caller: Caller,
		reg: Registration,
	): Promise<Agent | null> {
		if (reg.role !== "mcp" || !reg.sessionId || reg.meta?.acp === "1")
			return null;
		const lookup =
			reg.harness === "opencode"
				? opencodeSessionIdentity
				: reg.harness === "codex" && reg.meta?.nativeToolContext === "1"
					? codexThreadIdentity
					: null;
		if (!lookup) return null;
		const child = await lookup(reg.sessionId);
		if (!child?.parentId) {
			if (reg.harness !== "codex") return null;
			if (!child || caller.closed.aborted)
				throw new RpcError(
					"not_found",
					"The invoking Codex thread could not be verified",
				);
			const git = await gitInfoAsync(child.cwd, { lane: "user" });
			if (caller.closed.aborted)
				throw new RpcError("closed", "The Codex MCP connection closed");
			return this.registerAgent(caller, {
				...reg,
				cwd: child.cwd,
				project: git.project,
				branch: git.branch,
			});
		}
		let parentSession = child;
		const lineage = new Set([child.id]);
		while (parentSession.parentId) {
			const id = parentSession.parentId;
			const parent =
				lineage.has(id) || lineage.size >= 10 ? null : await lookup(id);
			if (!parent)
				throw new RpcError(
					"not_found",
					"The harness did not verify a supported root for this child",
				);
			lineage.add(id);
			parentSession = parent;
		}
		if (caller.closed.aborted)
			throw new RpcError("closed", "The child MCP connection closed");
		const parentId = this.registry.agentId(reg.harness, parentSession.id, null);
		let parent = this.registry.get(parentId);
		if (!parent || parent.status === "gone")
			parent = this.registry.upsert({
				harness: reg.harness,
				sessionId: parentSession.id,
				pid: null,
				cwd: parentSession.cwd,
				project: null,
				branch: null,
				tags: [],
				registered: false,
				meta: parentSession.title
					? { harnessName: parentSession.title, harnessNameSource: "auto" }
					: {},
			});
		await this.subagents.refresh(parentId);
		const id = `${parentId}${SUB_MARK}${child.id}`;
		const discovered = this.subagents.agentFor(id);
		const agent =
			this.registry.get(id) ??
			discovered ??
			(reg.harness === "codex"
				? ({
						...parent,
						id,
						name: child.title ?? "Codex subagent",
						sessionId: child.id,
						pid: null,
						tags: [],
						activity: null,
						inbound: "accept",
						createdAt: Date.now(),
						lastSeen: Date.now(),
						meta: { subagentOf: parentId, subagentKey: child.id },
					} satisfies Agent)
				: null);
		if (
			caller.closed.aborted ||
			!agent ||
			agent.sessionId !== child.id ||
			agent.harness !== reg.harness
		)
			throw new RpcError(
				"not_found",
				"The child could not be verified in its parent's session list",
			);
		const oldId = this.registry.agentId(reg.harness, child.id, null);
		const currentId = agentIdOf(caller.principal);
		if (currentId && currentId !== oldId && currentId !== id)
			throw new RpcError(
				"forbidden",
				"The MCP connection already has a different session",
			);
		if (
			[id, oldId].some((key) =>
				this.sessions
					.forAgent(key)
					.some((c) => c !== caller && this.sessions.role(c) === "mcp"),
			)
		)
			throw new RpcError(
				"session_claimed",
				"The child already has an MCP connection",
			);
		agent.cwd = child.cwd;
		agent.status = "busy";
		agent.registered = true;
		agent.meta.subagentNative = "1";
		if (!discovered) agent.meta.subagentOutboundOnly = "1";
		else delete agent.meta.subagentOutboundOnly;
		if (reg.capabilities?.includes("acks")) agent.meta.acks = "1";
		this.store.reassign(oldId, id);
		this.waiters.reassign(oldId, id);
		this.registry.delete(oldId);
		this.registry.registerSubagent(agent);
		caller.principal = { kind: "agent", agentId: id };
		this.sessions.bind(caller);
		agent.reach = this.registry.reachOf(agent);
		this.events.emit("agent", { action: "join", agent: toPublic(agent) });
		void this.deliveries.back(agent).catch(() => {});
		void this.subagents.refresh(parentId);
		return agent;
	}

	registerAgent(caller: Caller, reg: Registration) {
		if (
			isLocalSubagentId(
				this.registry.agentId(reg.harness, reg.sessionId, reg.pid),
			)
		)
			throw new RpcError(
				"forbidden",
				"subagent identity must be proved by its extension",
			);
		const protectedMeta = this.checkTakeover(caller, reg);
		// Sticky per agent: an MCP server with the ack tools makes its agent acks-capable.
		if (reg.capabilities?.includes("acks")) protectedMeta.acks = "1";
		if (typeof reg.resumeKey === "string" && reg.resumeKey)
			protectedMeta.resumeKey = reg.resumeKey.slice(0, 200);
		const agent = this.registry.upsert({
			harness: reg.harness,
			sessionId: reg.sessionId,
			pid: reg.pid,
			cwd: reg.cwd,
			project: reg.project,
			branch: reg.branch,
			tags: reg.tags ?? [],
			...(reg.name ? { name: reg.name } : {}),
			meta: protectedMeta,
			registered: true,
			model: reg.model ?? null,
		});
		// A connection that says hello again under a new id moves over.
		const previousId = agentIdOf(caller.principal);
		if (previousId && previousId !== agent.id) {
			const previous = this.registry.get(previousId);
			if (
				previous?.sessionId &&
				previous.pid !== null &&
				previous.pid === agent.pid &&
				previous.harness === agent.harness &&
				driverFor(agent.harness)?.scan?.tracksPid
			) {
				// Its process switched sessions (Claude's /resume, /clear): one
				// process is one agent, and the old session's identity stays behind.
				this.registry.retireSession(previous, agent);
			} else {
				// The harness named its session late (Codex learned its thread).
				this.store.reassign(previousId, agent.id);
				this.waiters.reassign(previousId, agent.id);
				// The new id inherits the old name only once nothing else holds it,
				// and only over a default name (never a chosen or harness one).
				if (previous && this.sessions.forAgent(previous.id).length <= 1) {
					this.registry.delete(previous.id);
					if (agent.meta.nameFrom === "pulsar") {
						agent.name = this.registry.uniqueName(previous.name, agent.id);
						if (previous.meta.nameFrom === "self") agent.meta.nameFrom = "self";
					}
				}
			}
		}
		caller.principal = { kind: "agent", agentId: agent.id };
		this.sessions.bind(caller, reg.capabilities);
		agent.reach = this.registry.reachOf(agent);
		this.events.emit("agent", { action: "join", agent: toPublic(agent) });
		// Tracked messages an earlier session got go again; then anything that
		// arrived while the session had no pulsar connection is pushed.
		const role = reg.role;
		void (async () => {
			try {
				await this.deliveries.back(agent);
				if ((role === "extension" || role === "wake") && !this.registry.closed)
					await this.router.flushQueued(
						agent,
						this.deliveries.config.maxAttempts,
					);
				else if (!this.registry.closed)
					await this.router.releaseNextTurn(agent);
			} catch (e) {
				// The store closed under a test or a stopping daemon; nothing is lost.
				daemonLog(`delivery after hello failed: ${(e as Error).message}`);
			}
		})();
		return agent;
	}

	/**
	 * A hello for an agent that is already live must be that agent: refused
	 * when its process differs from the one recorded, or when it would be a
	 * second extension (the one that receives pushes). A live agent's push
	 * path (`meta.socket`) is never replaced by a registration. Returns the
	 * meta to apply.
	 */
	private checkTakeover(
		caller: Caller,
		reg: Registration,
	): Record<string, string> {
		const meta = { ...(reg.meta ?? {}) };
		const id = this.registry.agentId(reg.harness, reg.sessionId, reg.pid);
		const existing = this.registry.get(id);
		if (!existing || existing.status === "gone") return meta;
		const claimed = () =>
			new RpcError(
				"session_claimed",
				`${id} is live in another process; a client may only speak as its own session`,
			);
		if (existing.pid && reg.pid && existing.pid !== reg.pid) throw claimed();
		if (reg.role === "extension") {
			const others = this.sessions
				.forAgent(id)
				.filter((c) => c !== caller && this.sessions.role(c) === "extension");
			// The same process reconnecting (its old connection not yet seen as
			// closed, or a client that opens a new one per retry) replaces its old
			// extension connection; refusing it makes such clients retry forever.
			// The pid is the client's own claim either way, so a same-pid
			// "second extension" proves nothing a refusal would protect.
			if (others.length > 0 && !(existing.pid && existing.pid === reg.pid))
				throw claimed();
			// A client that never closes its old connections can't pile them up.
			for (const c of others)
				for (const old of this.sessions.retire(id, c))
					old.close?.(
						"replaced by newer extension connections from the same process",
					);
		}
		delete meta.socket;
		return meta;
	}

	/** An agent as callers see it (no driver meta). */
	publicAgent(agent: Agent): PublicAgent {
		return agent.meta.subagentOf ? this.registry.view(agent) : toPublic(agent);
	}

	/** Runs one request for a caller. `hello` belongs to the transport. */
	async handle(
		caller: Caller,
		method: string,
		p: Record<string, unknown>,
	): Promise<unknown> {
		if (!isOp(method) || method === "hello")
			throw new RpcError("unknown_method", `unknown method ${method}`);
		this.authorize(
			caller.principal,
			method,
			typeof p.agent === "string" ? p.agent : undefined,
		);
		const { registry, mailbox } = this;
		const claudeChild = this.claudeChildHooks.source(caller, method);
		switch (method) {
			case "status":
				return {
					version: VERSION,
					protocol: PROTOCOL_VERSION,
					pid: process.pid,
					// Run by launchd/systemd, or started on demand by a client.
					service: this.serviceMode,
					// Whether the app is served, or why not and when the next try is.
					app: this.appStatus(),
					agents: registry.live().length,
					connections: this.sessions.size,
					// Whether anything blocks the daemon (doctor warns on stalls).
					eventLoop: this.lag.stats(),
					exec: execStats(),
					jobs: this.jobs.stats(),
					// The pool as this daemon's federation sees it (doctor shows it).
					...(registry.pool ? { pool: registry.pool.machines() } : {}),
					// Claude sessions still on a hook without `--timeout` (doctor).
					oldHookSessions: this.approvals.oldHookSessions(),
					// App load errors reported by devices lately (doctor notes them).
					clientErrors: this.clientErrors.summary(),
				};
			case "whoami": {
				const me = claudeChild ?? registry.self(caller);
				return {
					agent: this.publicAgent(me),
					unread: this.store.unreadCount(me.id),
				};
			}
			case "list":
				return registry.list(String(p.selector ?? "*"), Boolean(p.includeGone));
			case "send":
				return await mailbox.send(claudeChild ?? registry.sender(caller), {
					to: String(p.to ?? ""),
					body: String(p.body ?? ""),
					priority: (p.priority as Priority) ?? "normal",
					replyTo: (p.replyTo as string) ?? null,
					expectReply: Boolean(p.expectReply),
				});
			case "reply":
				return await mailbox.reply(
					claudeChild ?? registry.sender(caller),
					String(p.messageId ?? ""),
					String(p.body ?? ""),
					(p.priority as Priority) ?? "normal",
				);
			case "inbox":
				return mailbox.inbox(
					claudeChild ?? registry.sender(caller),
					p.markRead !== false,
					clampInt(p.limit, 20, 1, 100),
				);
			case "set_identity": {
				if (!claudeChild) registry.self(caller);
				const changeIdentity = (params: Record<string, unknown>) => {
					const result = registry.setIdentity(
						claudeChild ?? registry.self(caller),
						params,
					);
					if (claudeChild?.meta.subagentOf)
						void this.subagents.refresh(claudeChild.meta.subagentOf);
					return result;
				};
				// A folder that exists, with its git info warmed for at most 250 ms
				// (async: other requests go on); a slower answer is applied later.
				// The agent is looked up again after each wait: a scan may have
				// replaced its record meanwhile.
				if (typeof p.cwd === "string") {
					const cwd = p.cwd;
					const exists =
						cwd.startsWith("/") &&
						(await access(cwd).then(
							() => true,
							() => false,
						));
					if (!exists) {
						const { cwd: _dropped, ...rest } = p;
						return changeIdentity(rest);
					}
					await Promise.race([
						gitInfoAsync(cwd, { lane: "user" }),
						new Promise((r) => setTimeout(r, 250).unref?.()),
					]);
				}
				return changeIdentity(p);
			}
			case "set_status": {
				const me = registry.self(caller);
				const status = p.status as AgentStatus;
				if (status === "busy" || status === "idle") {
					registry.setStatus(me, status);
					this.router.reportStatus(caller, me, status);
				}
				return { ok: true };
			}
			case "msg.ack":
				return this.deliveries.ack(
					claudeChild ?? registry.self(caller),
					String(p.messageId ?? ""),
				);
			case "msg.done": {
				const me = claudeChild ?? registry.sender(caller);
				const id = String(p.messageId ?? "");
				const result = typeof p.result === "string" ? p.result.trim() : "";
				// A result is the answer: it goes to the sender as a reply. Done is
				// recorded either way, so finished work is never redelivered when
				// the result can't be sent (the sender left, a rate limit).
				let unsent: unknown = null;
				if (result)
					try {
						await mailbox.reply(me, id, result, "normal");
					} catch (e) {
						unsent = e;
					}
				const done = this.deliveries.markDone(
					claudeChild ?? registry.self(caller),
					id,
				);
				if (unsent) throw unsent;
				return done;
			}
			case "msg.nack":
				return await this.deliveries.nack(
					claudeChild ?? registry.self(caller),
					String(p.messageId ?? ""),
					String(p.reason ?? "no reason given").slice(0, 500),
					p.retry === true,
				);
			case "harness_name": {
				// The pi/omp extension reports its host's session name (and renames).
				const me = registry.self(caller);
				// An empty name: the session has none now (pi/omp `/new`).
				registry.applyHarnessName(
					me,
					typeof p.name === "string" ? p.name : "",
					p.source === "auto" ? "auto" : "user",
				);
				return { ok: true };
			}
			case "resume_key": {
				const me = registry.self(caller);
				const key = String(p.key ?? "").slice(0, 200);
				if (key && me.meta.resumeKey !== key) {
					me.meta.resumeKey = key;
					await this.deliveries.back(me);
				}
				return { ok: true };
			}
			case "nack":
				mailbox.nack(
					registry.self(caller),
					String(p.messageId),
					String(p.reason ?? "unknown"),
				);
				return { ok: true };
			case "ack":
				mailbox.ack(
					registry.self(caller),
					String(p.messageId),
					String(p.via ?? "extension"),
				);
				return { ok: true };
			case "wait":
				return await mailbox.wait(
					caller,
					claudeChild ?? registry.sender(caller),
					p,
				);
			case "history":
				return mailbox.history(claudeChild ?? registry.sender(caller), p);
			case "tail":
				this.tail(caller);
				return { ok: true };
			case "transcript.read":
				return await this.readTranscript(caller, p);
			case "claude.subagent.bind":
				return {
					agent: this.publicAgent(
						await this.claudeChildHooks.bind(caller, p.proof, p.tool),
					),
				};
			case "claude.subagent.collect":
				return await this.claudeChildHooks.collect(caller, p);
			case "claude.subagent.confirm":
				return this.claudeChildHooks.confirm(caller);
			case "approval.request": {
				// Stopping (an upgrade, a restart): the hook asks the next daemon.
				if (this.approvals.stopping) return { decision: null, retry: true };
				const decision = await this.approvals.request(
					caller,
					approvalRequest(p),
				);
				return !decision && this.approvals.stopping
					? { decision: null, retry: true }
					: { decision };
			}
			case "interaction.ask":
				return {
					result: await this.approvals.ask(caller, interactionRequest(p)),
				};
			case "interaction.local":
				return {
					ok: this.approvals.answeredLocally(caller, String(p.ref ?? "")),
				};
			case "passkeys.list":
				return { passkeys: this.approvals.listPasskeys(caller.principal) };
			case "pool.list":
				return this.poolAdmin.list(caller.principal);
			case "pool.change":
				return await this.poolAdmin.change(
					caller,
					String(p.verb ?? "") as PoolVerb,
					String(p.target ?? ""),
					Number(p.pid) || undefined,
				);
			case "passkeys.remove":
				return {
					removed: await this.removePasskey(
						caller,
						String(p.id ?? ""),
						Number(p.pid) || undefined,
					),
				};
			case "presence.word":
				return this.presence.word(
					caller,
					String(p.ticket ?? ""),
					String(p.word ?? ""),
				);
			case "stop":
				return await this.stopAgent(caller.principal, String(p.agent ?? ""));
			case "lookup":
				return await this.askPool(
					{
						question: String(p.question ?? ""),
						...(typeof p.selector === "string" ? { selector: p.selector } : {}),
					},
					caller.principal,
				);
			case "wake_result":
				return this.router.wakeResult(caller, p);
			case "interrupt_result":
				return this.interrupts.answer(registry.self(caller).id, p);
			case "control_result":
				return this.controls.answer(registry.self(caller).id, p);
			case "shutdown":
				if (this.serviceMode)
					throw new RpcError(
						"service_mode",
						"this daemon runs as a service; stop it with launchctl or systemctl",
					);
				this.onShutdown();
				return { ok: true };
		}
	}

	/**
	 * `pulsar passkeys remove <id>` (socket): anyone on this machine may ask;
	 * the person confirms (Touch ID or the app's passkey) before it's removed.
	 */
	async removePasskey(
		caller: Caller,
		id: string,
		pid?: number,
	): Promise<boolean> {
		const p = caller.principal;
		authorize(p, "passkeys.remove");
		const key = this.approvals.passkeys.list().find((k) => k.id === id);
		if (!key)
			throw new RpcError("not_found", `no passkey ${id} on this machine`);
		const proof = await this.presence.confirm(caller, {
			op: "passkeys.remove",
			text: `remove passkey '${key.label}' (${id.slice(0, 8)})`,
			target: id,
			command: "pulsar passkeys remove",
			...(pid ? { pid } : {}),
		});
		return this.approvals.removePasskey(p, id, proof);
	}

	/**
	 * Stop: interrupts an agent's current turn. The one entry point for every
	 * transport (socket `stop`, `POST /agents/:id/stop`, and federation, which
	 * passes the forwarding user's principal); it authorizes `stop` itself.
	 */
	async stopAgent(
		principal: Principal,
		agentId: string,
		assertion?: unknown,
	): Promise<StopResult> {
		// An agent on another machine: its home node verifies a passkey
		// assertion for this Stop (relayed ceremony), then stops it.
		const remote = agentId.includes("/")
			? this.registry.find(agentId)
			: undefined;
		if (remote && isRemote(remote) && this.registry.pool)
			return (await this.registry.pool.stopAgent(
				remote.id,
				principal,
				assertion,
			)) as StopResult;
		// An id, or the exact name of one live agent (the CLI takes names).
		let id = remote?.id ?? agentId;
		if (!this.registry.find(id)) {
			const named = this.registry.live().filter((a) => a.name === agentId);
			if (named.length > 1)
				throw new RpcError(
					"ambiguous",
					`${named.length} agents are named ${agentId}; use the id`,
				);
			if (named[0]) id = named[0].id;
		}
		this.authorize(principal, "stop", id);
		return this.interrupts.stop(principal, id);
	}

	/** Request options for stopping an agent on another machine (its home node's challenge). */
	async stopOptions(principal: Principal, agentId: string): Promise<unknown> {
		const remote = agentId.includes("/")
			? this.registry.find(agentId)
			: undefined;
		if (!remote || !isRemote(remote) || !this.registry.pool)
			throw new RpcError(
				"bad_request",
				"a local agent's Stop uses your passkey session; no options needed",
			);
		return this.registry.pool.stopOptions(remote.id, principal);
	}

	/**
	 * `transcript.read {agent, cursor?, follow?}`: one history page. With
	 * `follow`, live events also stream to the caller as `transcript` frames
	 * (`{agent, events}`) until it closes. Subscribing happens before the page
	 * is read, so nothing falls between them (overlap replaces by id).
	 */
	private async readTranscript(caller: Caller, p: Record<string, unknown>) {
		const agentId = String(p.agent ?? "");
		const cursor = typeof p.cursor === "string" ? p.cursor : null;
		const followed = this.follows.get(caller) ?? new Set<string>();
		if (p.follow !== true || caller.closed.aborted || followed.has(agentId))
			return this.transcripts.page(agentId, cursor);
		const off = this.transcripts.subscribe(agentId, (events) =>
			caller.emit("transcript", { agent: agentId, events }),
		);
		followed.add(agentId);
		this.follows.set(caller, followed);
		const stop = () => {
			off();
			followed.delete(agentId);
			caller.closed.removeEventListener("abort", stop);
		};
		caller.closed.addEventListener("abort", stop, { once: true });
		try {
			return await this.transcripts.page(agentId, cursor);
		} catch (e) {
			stop();
			throw e;
		}
	}

	/**
	 * `tail`: agents joining and leaving, and messages. The operator sees
	 * every message; an agent sees only messages it sent or received.
	 */
	private tail(caller: Caller) {
		if (this.tails.has(caller) || caller.closed.aborted) return;
		this.tails.add(caller);
		const off = this.events.onAny((event, data) => {
			if (event === "agent") caller.emit(event, data);
			if (event !== "message") return;
			const me = agentIdOf(caller.principal);
			const { message, recipients } = data as ServiceEvents["message"];
			if (me && me !== OPERATOR_ID) {
				const name = this.registry.get(me)?.name;
				if (message.fromId !== me && !(name && recipients.includes(name)))
					return;
			}
			caller.emit(event, data);
		});
		caller.closed.addEventListener("abort", off, { once: true });
	}
}

/** How often saved attachments past their week are removed. */
const ATTACHMENTS_GC_MS = 6 * 60 * 60 * 1000;

const str = (v: unknown, max: number): string | null =>
	typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;

/** Validates `interaction.ask` params (from the pi/omp extension). */
function interactionRequest(p: Record<string, unknown>): InteractionRequest {
	const ref = str(p.ref, 64);
	const kind = KINDS.find((k) => k === p.kind);
	const tool = str(p.tool, 200) ?? (kind ? `ui.${kind}` : null);
	const prompt = kind === "permission" ? null : cleanPrompt(p.prompt);
	const input =
		p.input && typeof p.input === "object" && !Array.isArray(p.input)
			? (p.input as Record<string, unknown>)
			: {};
	if (
		!ref ||
		!kind ||
		!tool ||
		(kind !== "permission" && prompt?.kind !== kind)
	)
		throw new RpcError(
			"bad_request",
			"interaction.ask needs ref, kind, and a prompt of that kind",
		);
	if (JSON.stringify(input).length > 256 * 1024)
		throw new RpcError("bad_request", "input is too large");
	const timeout = Number(p.timeoutMs);
	return {
		ref,
		kind,
		tool,
		input,
		prompt,
		sessionRules: Array.isArray(p.sessionRules)
			? p.sessionRules.slice(0, 20).map((r) => String(r).slice(0, 300))
			: null,
		timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : null,
	};
}

/** Validates `approval.request` params (the hook's stdin, passed through). */
function approvalRequest(p: Record<string, unknown>): ApprovalRequest {
	const sessionId = str(p.sessionId, 200);
	const tool = str(p.tool, 200);
	const input = p.input;
	if (
		!sessionId ||
		!tool ||
		!input ||
		typeof input !== "object" ||
		Array.isArray(input)
	)
		throw new RpcError(
			"bad_request",
			"approval.request needs sessionId, tool and an input object",
		);
	return {
		sessionId,
		promptId: str(p.promptId, 200),
		tool,
		input: input as Record<string, unknown>,
		suggestions: Array.isArray(p.suggestions) ? p.suggestions.slice(0, 20) : [],
		cwd: str(p.cwd, 4096),
		transcriptPath: str(p.transcriptPath, 4096),
		hookTimeoutS:
			Number.isInteger(p.hookTimeoutS) && Number(p.hookTimeoutS) > 0
				? Number(p.hookTimeoutS)
				: null,
		...(Number.isFinite(p.elapsedMs) && Number(p.elapsedMs) > 0
			? { elapsedMs: Number(p.elapsedMs) }
			: {}),
	};
}
