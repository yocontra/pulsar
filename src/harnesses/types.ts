import type {
	InteractionAnswer,
	InteractionKind,
	InteractionPrompt,
	SubagentKind,
	SubagentState,
} from "../http/wire.ts";
import type { Action, SetupContext } from "../setup/actions.ts";
import type {
	NoticeColor,
	ParseState,
	TranscriptEvent,
	TranscriptSource,
	TranscriptSupport,
} from "../transcripts/types.ts";
import type { Agent, AgentStatus, Priority, Registration } from "../types.ts";

/** A live session found on disk or through a harness API. */
export interface Scanned {
	harness: string;
	sessionId: string;
	pid: number | null;
	cwd: string | null;
	status: AgentStatus;
	model?: string | null;
	meta: Record<string, string>;
	/**
	 * What the session waits on in its own terminal (Claude's `waitingFor`:
	 * "permission prompt", "input needed", "dialog open"), when it does. The
	 * registry shows it as needs-you (reason `terminal`) unless a relayed
	 * prompt already does.
	 */
	waitingFor?: string | null;
}

/**
 * One subagent a driver found under an agent (see `HarnessDriver.subagents`).
 * Everything is read from the harness's own files or API, bounded, and taken
 * as data.
 */
export interface FoundSubagent {
	/**
	 * Unique under its parent and safe in an id: Claude's agent id, a Codex
	 * thread id, an omp task name, an OpenCode session id.
	 */
	key: string;
	name: string;
	kind: SubagentKind;
	/** The color the harness gave it (a Claude teammate's), when it gave one. */
	color?: NoticeColor | null;
	agentType: string | null;
	description: string | null;
	state: SubagentState;
	startedAt: number;
	updatedAt: number;
	finishedAt: number | null;
	/** The parent's tool call that started it. */
	callId: string | null;
	/** Started by another subagent of the same parent: that one's key. */
	parentKey: string | null;
	/** Its own session in the harness (Codex thread, OpenCode session). */
	sessionId: string | null;
	/** Its own log file, when it has one (Claude, omp). */
	file: string | null;
	/** This driver verified whether a child transcript artifact exists. */
	fileAvailable?: boolean;
	/** Working directory explicitly reported for this child. */
	cwd?: string | null;
	/** Managed ACP negotiated cancellation for this child on the parent connection. */
	acpCancel?: boolean;
	/** This specific child exposes a verified addressed delivery path. */
	direct?: boolean;
}

/** Where one subagent's transcript is, and how to read it. */
export interface SubagentTranscript {
	source: TranscriptSource;
	parse: (chunk: string, state: ParseState) => TranscriptEvent[];
}

/** A driver's reading of one agent's status, and since when (ms). */
export interface LiveStatus {
	agent: Agent;
	status: "busy" | "idle";
	since: number;
}

/** A session name a driver read for an agent (see `names` and src/harnesses/names.ts). */
export interface HarnessName {
	agent: Agent;
	name: string;
	source: "user" | "auto";
}

/** The parts of an agent a driver reads to find its model or session log. */
export type SessionRef = Pick<Agent, "harness" | "sessionId" | "cwd"> & {
	/** The agent's process, when known (pi and omp find their open session file by it). */
	pid?: number | null;
	/** The agent's meta: `resumeKey` names the host session of a pid-keyed agent. */
	meta?: Record<string, string>;
};

export interface DeliveryResult {
	ok: boolean;
	/** Delivery may have succeeded. Replaying this input can duplicate it. */
	uncertain?: boolean;
	via: string;
	detail?: string;
}

/** What the MCP server knows about itself when it asks its harness who it serves. */
export interface IdentifyContext {
	/** pid of the harness process (the MCP server's ancestor); null when not found. */
	pid: number | null;
	/** The MCP server's own folder. */
	cwd: string;
	/** `PULSAR_SESSION_ID` when set: keep it, but still look up the rest. */
	sessionId: string | null;
	env: NodeJS.ProcessEnv;
}

/** What the harness says about the session. Fields left undefined keep the defaults. */
export interface Identity {
	sessionId?: string | null;
	/** The session's folder; null claims no folder yet. */
	cwd?: string | null;
	/** Adapter hints for the daemon, e.g. Claude's inbox socket. */
	meta?: Record<string, string>;
}

/**
 * One AI-coding-agent harness. Everything pulsar knows about a harness lives
 * in its driver; every member except `id`, `label` and `matchProcess` is
 * optional, and a harness with none of them is pull-only and still works.
 */
import type { InterruptResult } from "../http/wire.ts";

export type { InterruptResult };

export interface InterruptOutcome {
	result: InterruptResult;
	/** How it was attempted, e.g. `codex-app-server`, `tmux-escape`. */
	via: string;
	detail?: string;
}

/**
 * What a permission hook prints for its harness: allow (maybe with session
 * rules or a changed input, which is how Claude's interactive tools take an
 * answer) or deny with a message the model reads.
 */
export type HookDecision =
	| {
			behavior: "allow";
			updatedPermissions?: unknown[];
			updatedInput?: Record<string, unknown>;
	  }
	| { behavior: "deny"; message: string };

/** A prompt pending on a harness's own server (`serverInteractions`). */
export interface ServerPrompt {
	/** The harness's own id for it; stable while it is pending. */
	key: string;
	sessionId: string;
	kind: InteractionKind;
	/** The tool or action asking (`shell`, `question`). */
	tool: string;
	/** Permission: what is asked about, shown exactly. */
	input: Record<string, unknown>;
	prompt: InteractionPrompt | null;
	/** Permission: what "Allow for session" covers; null offers Allow once only. */
	sessionRules: string[] | null;
	/** Driver-private: what `reply` needs. */
	data?: unknown;
	/** Shown in the app but answered only on the agent's own screen (Codex). */
	readOnly?: boolean;
}

/** The app's answer to a server prompt. */
export interface ServerReply {
	decision: "allow-once" | "allow-session" | "deny" | "answer";
	answer: InteractionAnswer | null;
	note: string | null;
}

/** One relayed permission prompt, as a driver's local-answer probe sees it. */
export interface PromptRef {
	tool: string;
	input: Record<string, unknown>;
	createdAt: number;
	/** The harness's own transcript for the session, when the hook named it. */
	transcriptPath: string | null;
}

/**
 * Watches one prompt for an answer given on the agent's own screen. Called
 * about twice a second while the prompt is pending; true once the local
 * prompt was answered (allowed there, or anything that is not this hook).
 */
export type LocalAnswerCheck = () => boolean | Promise<boolean>;

/**
 * The part of a driver the MCP server, hook and extension use: which process
 * is the harness and which session it serves. Lives in light `*-ident.ts`
 * modules that the drivers spread in (see `ident.ts`).
 */
export type HarnessIdent = Pick<
	HarnessDriver,
	| "id"
	| "label"
	| "matchProcess"
	| "identify"
	| "onSessionReady"
	| "lateSession"
	| "currentSession"
	| "toolSessions"
	| "extension"
	| "cliArgs"
>;

export interface HarnessDriver {
	/** Harness id: the `harness:` tag, `PULSAR_HARNESS` value and `--client` name. */
	id: string;
	/** Name shown to people, e.g. "Claude Code". */
	label: string;

	/**
	 * True when a process command line is this harness. The MCP server walks up
	 * its process tree to the first match. Must not also match another driver's
	 * processes.
	 */
	matchProcess(args: string): boolean;

	/** Connect any native delivery channel supplied by the harness to its client process. */
	onSessionReady?(registration: Registration): Promise<void>;

	/** What the MCP server (or CLI) learns about its session at start. */
	identify?(ctx: IdentifyContext): Promise<Identity>;

	/**
	 * For harnesses that name the session only after the MCP server starts
	 * (Codex creates its thread later). Consulted before each tool call while the
	 * registration has no session id, and when the daemon says the id is
	 * already served by another connection.
	 */
	lateSession?: {
		/** The best session guess for this process, skipping ids in `exclude`. */
		find(
			reg: Registration,
			exclude: ReadonlySet<string>,
		): Promise<string | null>;
		/** Points the registration at a session (id, folder, git tags); null clears it. */
		adopt(reg: Registration, sessionId: string | null): Promise<void>;
	};

	/**
	 * For harnesses whose process can switch to another session while its
	 * MCP server keeps running (Claude Code's /resume, /clear). Consulted
	 * before each tool call: when it names a session other than the
	 * registration's, the MCP server says hello again under it and the
	 * daemon moves the agent over. Null: unknown, keep the registration's.
	 */
	currentSession?(reg: Registration): Promise<string | null>;

	/**
	 * The harness shows MCP tools to its model as shell-like commands, where
	 * only required arguments can be positional (omp). The MCP server then
	 * lists each tool's main arguments as required, in order.
	 */
	cliArgs?: boolean;

	/**
	 * For harnesses that run one MCP process for many sessions and name the
	 * session in each tool call's `_meta` (OpenCode). Each session gets its own
	 * daemon connection; the shared process does not register itself.
	 */
	toolSessions?: {
		/** The session id in a tool call's `_meta`, or null. */
		sessionId(meta: Record<string, unknown> | undefined): string | null;
		/** The session's folder, or null when unknown. */
		cwd(sessionId: string): Promise<string | null>;
	};

	/** Live sessions that do not need to run pulsar to be listed. */
	scan?: {
		intervalMs: number;
		sessions(): Scanned[] | Promise<Scanned[]>;
		/**
		 * True when scanned sessions are keyed by a live pid: an agent whose
		 * pulsar connection closed stays listed while its pid lives.
		 */
		tracksPid?: boolean;
	};

	/**
	 * Busy/idle for agents the harness reports no status for (Codex: from
	 * its rollouts). Polled on its own timer; an agent left out keeps its
	 * status.
	 */
	liveStatus?: {
		intervalMs: number;
		read(agents: Agent[]): Promise<LiveStatus[]>;
	};

	/**
	 * Session names the harness keeps where pulsar can read them (Codex's
	 * thread index), for agents no scan reports. Polled on its own timer;
	 * an agent left out keeps its name.
	 */
	names?: {
		intervalMs: number;
		read(agents: Agent[]): Promise<HarnessName[]>;
	};

	/** A safe, short fallback activity label for an attached session. */
	activity?(agent: Agent): Promise<string | null>;

	/**
	 * Subagents an agent runs. Discovery is lazy and
	 * incremental: `stamp` is one cheap check the daemon runs on a slow
	 * timer; `list` runs only when the stamp moved, a child is still running,
	 * or someone looks; unchanged files are not read again.
	 */
	subagents?: {
		/**
		 * Changes when the agent's children may have changed (a folder's
		 * mtime); null when it has none. Absent: `list` decides.
		 */
		stamp?(agent: Agent): Promise<string | null>;
		/** Every subagent of `agent`, nested ones too (flat, `parentKey` set). */
		list(agent: Agent): Promise<FoundSubagent[]>;
		/** One subagent's transcript; null when the harness keeps none Pulsar can read. */
		transcript?(
			agent: Agent,
			sub: FoundSubagent,
		): Promise<SubagentTranscript | null>;
		/**
		 * True only when `push.deliver` reaches a subagent given its own
		 * session id, verified live. Without it a message goes to the parent.
		 */
		direct?: boolean;
		/** Interrupt addresses the child session itself without targeting a shared process. */
		interruptBySession?: boolean;
	};

	/** Prove a native wake relay names the session its host process currently owns. */
	verifyWakeHost?(
		pid: number,
		sessionId: string,
	): Promise<{ cwd: string | null } | null>;

	/** Pushes text into a running session from outside it. */
	push?: {
		/** True when this driver can reach the agent. False for other harnesses. */
		canPush(agent: Agent): boolean;
		/** True when this session supports input addressed to its active turn. */
		canSteer?(agent: Agent): boolean;
		deliver(
			agent: Agent,
			text: string,
			priority: Priority,
			fromName: string,
		): Promise<DeliveryResult>;
	};

	/**
	 * Interrupts the session's current turn (what Esc does) without ending
	 * the session. `canInterrupt` is cheap and synchronous (it runs for every
	 * row the app shows); `interrupt` does the work. Extension hosts (pi, omp)
	 * are interrupted through the extension by the service, not here.
	 */
	canInterrupt?(agent: Agent): boolean;
	interrupt?(agent: Agent): Promise<InterruptOutcome>;

	/**
	 * The tmux pane (`%12`) the session runs in, when the harness records it
	 * (src/tmux.ts `paneOf`, after `agent.meta.tmux`); null when not in tmux.
	 */
	tmuxPane?(agent: Agent): Promise<string | null>;

	/**
	 * pi-style hosts that load pulsar's extension, which pushes from inside the
	 * session (the daemon talks to it directly).
	 */
	extension?: {
		/**
		 * True when the extension's process (its argv) is this harness. The
		 * first match in DRIVERS wins; pi accepts anything that is not omp.
		 */
		isHost(argv: string): boolean;
		/** Host events that mean the agent finished its turn. */
		idleEvents: string[];
	};

	/** The session's model, for harnesses whose scan does not report it. */
	model?(agent: SessionRef): string | null | Promise<string | null>;

	/** Recent text of the session log, for offline PR detection ("" when unknown). */
	sessionLog?(agent: SessionRef): string | Promise<string>;

	/**
	 * Live transcript: where the session's log is and how to read it into
	 * `TranscriptEvent`s (the shared tailer in src/transcripts/ does the rest).
	 */
	transcript?: TranscriptSupport<SessionRef>;
	/** Look up an exact saved native session without starting it or claiming presence. */
	readSession?(
		sessionId: string,
	): Promise<{ cwd: string | null; name?: string; lastSeen: number } | null>;
	/** The native CLI argv that reopens this exact session. Never use latest or fork. */
	resumeArgs?(sessionId: string): string[] | null;

	/**
	 * Permission prompts relayed by the harness's hook (approvals): how the
	 * daemon learns that the local prompt was answered first.
	 */
	approvals?: {
		watch(
			agent: Pick<Agent, "sessionId" | "pid" | "cwd">,
			prompt: PromptRef,
		): LocalAnswerCheck;
	};

	/**
	 * Interactive tools that ask through the permission hook (Claude's
	 * AskUserQuestion, ExitPlanMode): what the call asks, and the hook
	 * decision that carries the app's answer back. Calls for which `classify`
	 * returns null stay plain permission prompts.
	 */
	interactions?: {
		classify(
			tool: string,
			input: Record<string, unknown>,
		): InteractionPrompt | null;
		decide(
			prompt: InteractionPrompt,
			input: Record<string, unknown>,
			answer: InteractionAnswer,
		): HookDecision;
	};

	/**
	 * Prompts a harness keeps on its own server (OpenCode): listed by polling
	 * and answered through its API. A prompt that leaves the list was
	 * answered on the agent's own screen.
	 */
	serverInteractions?: {
		intervalMs: number;
		/** Pending prompts now (`agents`: this harness's live agents); throws when unreadable. */
		pending(agents: Agent[]): Promise<ServerPrompt[]>;
		/** Answers one; false when that failed (it may be gone). */
		reply(prompt: ServerPrompt, reply: ServerReply): Promise<boolean>;
	};

	/** `pulsar setup` / `doctor` / `--uninstall`. */
	setup?: {
		/**
		 * Found on this machine. `path`: the PATH to look on (this process's
		 * by default; doctor under the service passes the login shell's).
		 */
		detect(path?: string): boolean;
		/** True when pulsar is already wired into this harness. */
		configured(): boolean;
		/** The changes setup would make. Must not change anything itself. */
		plan(ctx: SetupContext): Action[];
	};
}
