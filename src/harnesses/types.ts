import type { Action, SetupContext } from "../setup/actions.ts";
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
}

/** The parts of an agent a driver reads to find its model or session log. */
export type SessionRef = Pick<Agent, "harness" | "sessionId" | "cwd">;

export interface DeliveryResult {
	ok: boolean;
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

	/** What the MCP server (or CLI) learns about its session at start. */
	identify?(ctx: IdentifyContext): Identity;

	/**
	 * For harnesses that name the session only after the MCP server starts
	 * (Codex creates its thread later). Consulted before each tool call while the
	 * registration has no session id, and when the daemon says the id is
	 * already served by another connection.
	 */
	lateSession?: {
		/** The best session guess for this process, skipping ids in `exclude`. */
		find(reg: Registration, exclude: ReadonlySet<string>): string | null;
		/** Points the registration at a session (id, folder, git tags); null clears it. */
		adopt(reg: Registration, sessionId: string | null): void;
	};

	/**
	 * For harnesses that run one MCP process for many sessions and name the
	 * session in each tool call's `_meta` (OpenCode). Each session gets its own
	 * daemon connection; the shared process does not register itself.
	 */
	toolSessions?: {
		/** The session id in a tool call's `_meta`, or null. */
		sessionId(meta: Record<string, unknown> | undefined): string | null;
		/** The session's folder, or null when unknown. */
		cwd(sessionId: string): string | null;
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

	/** Pushes text into a running session from outside it. */
	push?: {
		/** True when this driver can reach the agent. False for other harnesses. */
		canPush(agent: Agent): boolean;
		deliver(
			agent: Agent,
			text: string,
			priority: Priority,
			fromName: string,
		): Promise<DeliveryResult>;
	};

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

	/** `pulsar setup` / `doctor` / `--uninstall`. */
	setup?: {
		detect(): boolean;
		/** True when pulsar is already wired into this harness. */
		configured(): boolean;
		/** The changes setup would make. Must not change anything itself. */
		plan(ctx: SetupContext): Action[];
	};
}
