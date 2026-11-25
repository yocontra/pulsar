import { readChanges, readFileDiff } from "../changes/read.ts";
import type { Lane } from "../exec.ts";
import type { ChangesMode, ChangesSummary, FileDiff } from "../http/wire.ts";
import { RpcError } from "../rpc.ts";
import type { Store } from "../store.ts";
import type { ResolvedTranscript } from "../transcripts/tailer.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import { hasHistoricalEdits } from "./changes-history.ts";
import type { RemoteChanges } from "./pool.ts";

const HISTORY_RETRY_MS = 60_000;

export interface ChangesOptions {
	store: Pick<Store, "metaGet" | "metaSet">;
	/** How often a watched worktree is re-read without activity (ms). */
	pollMs?: number;
	/** Quiet time after agent activity before a re-read (ms). */
	debounceMs?: number;
	/**
	 * Calls `fn` when the agent does something (a transcript event: an edit,
	 * a command); returns the unsubscribe function.
	 */
	activity?: (agentId: string, fn: () => void) => () => void;
	transcript?: (
		agent: Agent,
	) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
}

/**
 * Worktree changes of agents, for the app's diff viewer: a summary of what
 * the agent's git worktree has dirty and one file's diff at a time, read
 * from the agent's folder (src/changes/read.ts). Remote agents are read
 * through their home node. Callers authorize `transcript.read` first (the
 * same rule as transcripts); these methods do not check who is asking.
 */
export class Changes {
	/** Agents on other machines, read through their home node. */
	remote: RemoteChanges | null = null;
	private readonly store: ChangesOptions["store"];
	private readonly lookup: (agentId: string) => Agent | undefined;
	private readonly pollMs: number;
	private readonly debounceMs: number;
	private readonly activity: ChangesOptions["activity"];
	private readonly transcript: ChangesOptions["transcript"];
	private readonly history = new WeakMap<
		Agent,
		{ identity: string; until: number; result: Promise<boolean | null> }
	>();

	constructor(
		lookup: (agentId: string) => Agent | undefined,
		opts: ChangesOptions,
	) {
		this.lookup = lookup;
		this.store = opts.store;
		this.pollMs = opts.pollMs ?? 4000;
		this.debounceMs = opts.debounceMs ?? 400;
		this.activity = opts.activity;
		this.transcript = opts.transcript;
	}

	private historical(
		agent: Agent,
		cwd: string,
		root: string,
		identity: string,
	): Promise<boolean | null> {
		const cached = this.history.get(agent);
		const now = Date.now();
		if (cached?.identity === identity && cached.until > now)
			return cached.result;
		const result = (async () =>
			hasHistoricalEdits(
				(await this.transcript?.(agent)) ?? null,
				cwd,
				root,
			))().catch(() => false);
		this.history.set(agent, {
			identity,
			until: now + HISTORY_RETRY_MS,
			result,
		});
		return result;
	}

	private remoteId(agentId: string): boolean {
		return (
			Boolean(this.remote) && agentId.includes("/") && !this.lookup(agentId)
		);
	}

	private agent(agentId: string): Agent {
		const agent = this.lookup(agentId);
		if (!agent) throw new RpcError("not_found", `no agent ${agentId}`);
		return agent;
	}

	async summary(
		agentId: string,
		mode: ChangesMode,
		as?: Principal,
		lane: Lane = "user",
	): Promise<ChangesSummary> {
		if (this.remoteId(agentId)) return this.remote!.summary(agentId, mode, as);
		const agent = this.agent(agentId);
		if (!agent.cwd)
			return {
				agent: agentId,
				mode,
				available: false,
				reason: "no_cwd",
				repo: null,
				root: null,
				branch: null,
				head: null,
				upstream: null,
				base: null,
				files: [],
				total: 0,
				truncated: false,
				added: 0,
				removed: 0,
				stamp: "no_cwd",
			};
		const cwd = agent.cwd;
		const key = `changes.seen:${agent.id}:${agent.sessionId ?? agent.meta.gen ?? agent.createdAt}`;
		const resumeKey = agent.meta.resumeKey;
		const { summary } = await readChanges(cwd, mode, lane);
		let hasChanges = this.store.metaGet(key) !== null;
		let historyIncomplete = false;
		if (!hasChanges && summary.available) {
			hasChanges = summary.total > 0;
			// A clean worktree may already have committed its changes.
			if (!hasChanges && mode === "worktree" && (summary.base?.ahead ?? 0) > 0)
				hasChanges = (await readChanges(cwd, "base", lane)).summary.total > 0;
			if (!hasChanges && this.transcript && summary.root) {
				const identity = JSON.stringify([key, resumeKey, cwd, summary.root]);
				const history = await this.historical(
					agent,
					cwd,
					summary.root,
					identity,
				);
				if (agent.cwd === cwd && agent.meta.resumeKey === resumeKey) {
					hasChanges = history === true;
					historyIncomplete = history === null;
				}
			}
			if (hasChanges) this.store.metaSet(key, "1");
		}
		return {
			agent: agentId,
			...summary,
			hasChanges,
			...(historyIncomplete ? { changesHistoryIncomplete: true } : {}),
		};
	}

	/** One file's diff; not_found unless the current summary lists the path. */
	async file(
		agentId: string,
		mode: ChangesMode,
		path: string,
		as?: Principal,
	): Promise<FileDiff> {
		if (this.remoteId(agentId))
			return this.remote!.file(agentId, mode, path, as);
		const agent = this.agent(agentId);
		const diff = agent.cwd
			? await readFileDiff(agent.cwd, mode, path, "user")
			: null;
		if (!diff) throw new RpcError("not_found", `no change to ${path}`);
		return diff;
	}

	/**
	 * Live summaries while someone watches: re-read after the agent's
	 * activity (debounced) and on a slow poll; `fn` gets the first summary,
	 * then each one whose stamp moved. Returns the unsubscribe function.
	 */
	watch(
		agentId: string,
		mode: ChangesMode,
		fn: (s: ChangesSummary) => void,
		/** `pollMs`: this watch's re-read with no activity (default: the service's). */
		opts: { pollMs?: number } = {},
	): () => void {
		if (this.remoteId(agentId)) return this.remote!.watch(agentId, mode, fn);
		this.agent(agentId);
		let stopped = false;
		let running = false;
		let again = false;
		let last: string | null = null;
		let debounce: ReturnType<typeof setTimeout> | undefined;
		const run = async () => {
			if (stopped) return;
			if (running) {
				again = true;
				return;
			}
			running = true;
			try {
				const s = await this.summary(agentId, mode, undefined, "background");
				const stamp = `${s.stamp}:${s.hasChanges ?? ""}:${s.changesHistoryIncomplete ?? ""}`;
				if (!stopped && stamp !== last) {
					last = stamp;
					fn(s);
				}
			} catch {
				// The agent left: the viewer keeps its last answer.
			} finally {
				running = false;
				if (again && !stopped) {
					again = false;
					void run();
				}
			}
		};
		const poll = setInterval(() => void run(), opts.pollMs ?? this.pollMs);
		poll.unref?.();
		let offActivity: (() => void) | null = null;
		try {
			offActivity =
				this.activity?.(agentId, () => {
					clearTimeout(debounce);
					debounce = setTimeout(() => void run(), this.debounceMs);
					debounce.unref?.();
				}) ?? null;
		} catch {
			// No transcript to follow: the poll alone keeps it live.
		}
		void run();
		return () => {
			stopped = true;
			clearInterval(poll);
			clearTimeout(debounce);
			offActivity?.();
		};
	}
}
