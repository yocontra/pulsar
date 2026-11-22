import { stat } from "node:fs/promises";
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

export interface TranscriptPageResult extends TranscriptPage {
	/** False when the agent's harness keeps no transcript pulsar can read. */
	available: boolean;
}

/** An agent's transcript through its harness driver. */
export async function driverTranscript(
	agent: Agent,
): Promise<ResolvedTranscript | null> {
	const support = driverFor(agent.harness)?.transcript;
	const source = await support?.locate(agent);
	return support && source
		? {
				source,
				parse: support.parse,
				cwd: agent.cwd,
				...(support.turnFailed ? { turnFailed: support.turnFailed } : {}),
			}
		: null;
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
	private remoteId(agentId: string): boolean {
		return (
			Boolean(this.remote) &&
			agentId.includes("/") &&
			!isLocalSubagentId(agentId) &&
			!this.lookup(agentId)
		);
	}
	/** Finds a local subagent its parent has not listed yet (set by the service). */
	private readonly ensure: (agentId: string) => Promise<unknown>;

	constructor(
		lookup: (agentId: string) => Agent | undefined,
		opts: {
			pollMs?: number;
			resolve?: (
				agent: Agent,
			) => ResolvedTranscript | null | Promise<ResolvedTranscript | null>;
			ensure?: (agentId: string) => Promise<unknown>;
		} = {},
	) {
		this.lookup = lookup;
		this.ensure = opts.ensure ?? (async () => {});
		const resolve = opts.resolve ?? driverTranscript;
		this.resolve = resolve;
		this.tailer = new TranscriptTailer({
			resolve: (id) => {
				const agent = this.lookup(id);
				return agent ? resolve(agent) : null;
			},
			...(opts.pollMs ? { pollMs: opts.pollMs } : {}),
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
			return { events: [], cursor: null, available: false };
		if (isLocalSubagentId(agentId) && !this.lookup(agentId))
			await this.ensure(agentId);
		this.agent(agentId);
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
			: { events: [], cursor: null, available: false };
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
		if (isLocalSubagentId(agentId) && !this.lookup(agentId))
			await this.ensure(agentId);
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
		if (isLocalSubagentId(agentId) && !this.lookup(agentId)) {
			// Not listed yet (a fresh daemon): list its parent, then follow.
			let off: (() => void) | null = null;
			let closed = false;
			void this.ensure(agentId).then(() => {
				if (!closed && this.lookup(agentId))
					off = this.tailer.subscribe(agentId, fn);
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
