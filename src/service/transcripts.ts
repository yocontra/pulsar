import { stat } from "node:fs/promises";
import { acpTranscript } from "../harnesses/acp-transcript.ts";
import { driverFor } from "../harnesses/index.ts";
import { RpcError } from "../rpc.ts";
import {
	type ResolvedTranscript,
	type TranscriptListener,
	TranscriptTailer,
} from "../transcripts/tailer.ts";
import type { MediaType, TranscriptPage } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import { OPERATOR_ID } from "./caller.ts";
import { isLocalSubagentId, type RemoteTranscripts } from "./pool.ts";

/**
 * Why a page has no transcript behind it:
 * - `unsupported`: the harness keeps none Pulsar can read (it never will).
 * - `no_session`: the harness keeps one per session, and the agent has no
 *   session id yet (a Codex app-server before it learns its thread).
 * - `not_found`: no file for the session yet (not written, or a lookup
 *   that missed); it shows once found.
 */
export type TranscriptMissing = "unsupported" | "no_session" | "not_found";

export const TRANSCRIPT_MISSING: readonly TranscriptMissing[] = [
	"unsupported",
	"no_session",
	"not_found",
];

export interface TranscriptPageResult extends TranscriptPage {
	/** False when no transcript was found; `missing` says why. */
	available: boolean;
	/** Set when `available` is false. */
	missing?: TranscriptMissing;
}

/** Why a local agent has no transcript, from its harness driver. */
export function driverMissing(agent: Agent): TranscriptMissing {
	const support =
		agent.meta.acp === "1"
			? acpTranscript
			: driverFor(agent.harness)?.transcript;
	if (!support) return "unsupported";
	if (support.needsSession && !agent.sessionId) return "no_session";
	return "not_found";
}

/** An agent's transcript through its harness driver. */
export async function driverTranscript(
	agent: Agent,
): Promise<ResolvedTranscript | null> {
	const support =
		agent.meta.acp === "1"
			? acpTranscript
			: driverFor(agent.harness)?.transcript;
	const source = await support?.locate(agent);
	if (agent.status === "gone" && source?.kind === "file" && source.guess)
		return null;
	return support && source
		? {
				source,
				parse: support.parse,
				cwd: agent.cwd,
				...(support.turnFailed ? { turnFailed: support.turnFailed } : {}),
			}
		: null;
}

/** Why a local subagent has no transcript: its parent's harness keeps none, or not found yet. */
export function subagentMissing(agent: Agent): TranscriptMissing {
	const driver = driverFor(agent.harness);
	return driver?.subagents?.transcript || driver?.transcript
		? "not_found"
		: "unsupported";
}

/**
 * Live transcripts for the service: history pages and live subscriptions by
 * agent id, over one shared tailer. Callers authorize `transcript.read`
 * first; these methods do not check who is asking.
 */
export class Transcripts {
	readonly tailer: TranscriptTailer;
	private readonly lookup: (agentId: string) => Agent | undefined;
	private readonly resolve: (
		agent: Agent,
	) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
	/** Agents on other machines (pool addresses), read through their home node. */
	remote: RemoteTranscripts | null = null;
	/** True when an id belongs to another machine: the local lookup misses and it is a pool address. */
	private readonly isHomeAddress: (id: string) => boolean;
	private remoteId(agentId: string): boolean {
		return (
			Boolean(this.remote) &&
			agentId.includes("/") &&
			!this.isHomeAddress(agentId) &&
			!isLocalSubagentId(agentId) &&
			!this.lookup(agentId)
		);
	}
	/** Finds a local subagent its parent has not listed yet (set by the service). */
	private readonly ensure: (agentId: string) => Promise<unknown>;
	/** Why an agent with no transcript found has none. */
	private readonly missing: (agent: Agent) => TranscriptMissing;

	constructor(
		lookup: (agentId: string) => Agent | undefined,
		opts: {
			pollMs?: number;
			resolveMs?: number;
			/** Why an agent has no transcript; the driver's answer by default. */
			missing?: (agent: Agent) => TranscriptMissing;
			resolve?: (
				agent: Agent,
			) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
			isHomeAddress?: (agentId: string) => boolean;
			ensure?: (agentId: string) => Promise<unknown>;
		} = {},
	) {
		this.lookup = lookup;
		this.isHomeAddress = opts.isHomeAddress ?? (() => false);
		this.ensure = opts.ensure ?? (async () => {});
		const resolve = opts.resolve ?? driverTranscript;
		// A custom resolver (tests, subagents) knows no harness: not found yet.
		this.missing =
			opts.missing ?? (opts.resolve ? () => "not_found" : driverMissing);
		this.resolve = resolve;
		this.tailer = new TranscriptTailer({
			resolve: (id) => {
				const agent = this.lookup(id);
				return agent ? resolve(agent) : null;
			},
			...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
			...(opts.resolveMs ? { resolveMs: opts.resolveMs } : {}),
		});
	}

	private agent(agentId: string): Agent {
		const agent = this.lookup(agentId);
		if (!agent) throw new RpcError("not_found", `no agent ${agentId}`);
		return agent;
	}

	/**
	 * A cheap fingerprint of an agent's transcript, for caches: size and mtime
	 * of a log file, or a 30-second bucket for harness APIs. Null when it has
	 * none.
	 */
	async stamp(agentId: string): Promise<string | null> {
		const agent = this.lookup(agentId);
		const r = agent ? await this.resolve(agent) : null;
		if (!r) return null;
		if (r.source.kind === "poll")
			return `poll:${Math.floor(Date.now() / 30_000)}`;
		try {
			const st = await stat(r.source.path);
			return `${st.size}:${st.mtimeMs}`;
		} catch {
			return null;
		}
	}

	/**
	 * Where a local agent's transcript is: a log file and its size, or a
	 * harness API. Null when it has none (the search backfill's view).
	 */
	async source(
		agentId: string,
	): Promise<
		{ kind: "file"; path: string; size: number } | { kind: "poll" } | null
	> {
		const agent = this.lookup(agentId);
		const r = agent ? await this.resolve(agent) : null;
		if (!r) return null;
		if (r.source.kind === "poll") return { kind: "poll" };
		try {
			const st = await stat(r.source.path);
			return { kind: "file", path: r.source.path, size: st.size };
		} catch {
			return null;
		}
	}

	/** One page of history (newest first; pass `cursor` for the page before). */
	async page(
		agentId: string,
		cursor?: string | null,
		as?: Principal,
	): Promise<TranscriptPageResult> {
		if (this.remoteId(agentId))
			return this.remote!.page(agentId, cursor ?? null, as);
		// The operator (a presence check from a terminal) has no transcript.
		if (agentId === OPERATOR_ID)
			return {
				events: [],
				cursor: null,
				available: false,
				missing: "unsupported",
			};
		if (!this.lookup(agentId)) await this.ensure(agentId);
		const agent = this.agent(agentId);
		// Subscribe first, then page: a live watcher's offset is set first, so
		// nothing falls between the page and the stream.
		await this.tailer.ready(agentId);
		let page: TranscriptPage | null;
		try {
			page = await this.tailer.read(agentId, cursor);
		} catch (e) {
			if (e instanceof RangeError) throw new RpcError("bad_cursor", e.message);
			throw e;
		}
		return page
			? { ...page, available: true }
			: {
					events: [],
					cursor: null,
					available: false,
					missing: this.missing(agent),
				};
	}

	/**
	 * The bytes of an image an event of this agent named (`images[].id`).
	 * not_found for an id this daemon has not parsed (or no longer
	 * remembers): re-read the page and use the new URL.
	 */
	async image(
		agentId: string,
		imageId: string,
		as?: Principal,
	): Promise<{ mediaType: MediaType; data: Buffer }> {
		if (this.remoteId(agentId)) return this.remote!.image(agentId, imageId, as);
		if (!this.lookup(agentId)) await this.ensure(agentId);
		this.agent(agentId);
		const r = await this.tailer.image(agentId, imageId);
		if (r.ok) return { mediaType: r.mediaType, data: r.data };
		if (r.reason === "too_large")
			throw new RpcError(
				"too_large",
				"the image is over 10 MB (a PDF: over 32 MB)",
			);
		if (r.reason === "unsupported")
			throw new RpcError(
				"unsupported_media",
				"only PNG, JPEG, GIF and WebP images and PDFs are served",
			);
		throw new RpcError("not_found", `no image ${imageId}`);
	}

	/** Live events for an agent; returns the unsubscribe function. */
	subscribe(agentId: string, fn: TranscriptListener): () => void {
		if (this.remoteId(agentId)) return this.remote!.subscribe(agentId, fn);
		if (!this.lookup(agentId)) {
			// Resolve a saved conversation or discover a child before following it.
			let off: (() => void) | null = null;
			let closed = false;
			void this.ensure(agentId)
				.then(() => {
					if (!closed && this.lookup(agentId))
						off = this.tailer.subscribe(agentId, fn);
				})
				.catch(() => {
					/* The transcript page reports lookup errors. */
				});
			return () => {
				closed = true;
				off?.();
			};
		}
		this.agent(agentId);
		return this.tailer.subscribe(agentId, fn);
	}

	/** Resolves once a local agent's live watcher is attached. */
	ready(agentId: string): Promise<void> {
		return this.tailer.ready(agentId);
	}

	close() {
		this.tailer.close();
	}
}
