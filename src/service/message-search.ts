import type {
	AgentRow,
	MessageHit,
	MessageSearchResponse,
} from "../http/wire.ts";
import { debugLog } from "../log.ts";
import { RpcError } from "../rpc.ts";
import { type Doc, type DocRole, MessageIndex } from "../search/index.ts";
import { redactSecrets } from "../search/redact.ts";
import { parseQuery, type Query, score, snippet } from "../search/text.ts";
import type { Store } from "../store.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import type { Agent } from "../types.ts";
import type { Principal } from "./caller.ts";
import { isAddress } from "./pool.ts";
import type { Registry } from "./registry.ts";
import type { Transcripts } from "./transcripts.ts";
import type { Views } from "./views.ts";

/** How often the backfill looks for what live tails missed. */
export const BACKFILL_MS = 60_000;
/** Events older than this are not kept (nor backfilled). */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Pages read back the first time an agent is indexed (about 200 events each). */
export const FIRST_PASS_PAGES = 25;
/** Rows the backfill writes per transaction. */
const WRITE_CHUNK = 25;
/** Longest text kept for one event. */
const TEXT_CAP = 8000;
/** Hits one search returns. */
export const MAX_HITS = 20;
/** Hits one agent may take of them. */
const PER_AGENT = 5;
/** Hits a search in one agent's transcript returns (the find bar). */
export const AGENT_HITS = 200;

/** What one machine found (agent ids are its own). */
export interface LocalHits {
	hits: MessageHit[];
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * Full-text search over transcripts. Indexes what people and agents wrote
 * (prompts, replies, peer messages, tool call titles; never tool output or
 * thinking), redacted, from two feeds: every live batch the transcript tailer
 * reads, and a low-priority backfill that reads each local agent's log from
 * where it stopped. Answers for this machine; the service merges the pool.
 */
export class MessageSearch {
	readonly index: MessageIndex;
	/** `PULSAR_NO_SEARCH`: nothing is indexed and every search finds nothing. */
	readonly off: boolean;
	private readonly transcripts: Transcripts;
	private readonly registry: Registry;
	private readonly views: Views;
	private readonly redact: (text: string) => string;
	private readonly now: () => number;

	constructor(deps: {
		store: Store;
		transcripts: Transcripts;
		registry: Registry;
		views: Views;
		engine?: "fts5" | "memory";
		off?: boolean;
		redact?: (text: string) => string;
		now?: () => number;
	}) {
		this.index = new MessageIndex(
			deps.store.db,
			deps.engine ? { engine: deps.engine } : {},
		);
		this.off = deps.off ?? false;
		this.transcripts = deps.transcripts;
		this.registry = deps.registry;
		this.views = deps.views;
		this.redact = deps.redact ?? redactSecrets;
		this.now = deps.now ?? Date.now;
	}

	/** The index rows for a batch of events (cursor: the page that held them). */
	docsFrom(
		agentId: string,
		events: TranscriptEvent[],
		cursor: string | null,
	): Doc[] {
		const cutoff = this.now() - RETENTION_MS;
		const docs: Doc[] = [];
		for (const e of events) {
			// A missing or bad time fails this too.
			if (e.sidechain || !(e.ts >= cutoff)) continue;
			const picked = pick(e);
			if (!picked) continue;
			// Redact before the cut, so a secret across the cap still matches.
			const text = this.redact(picked.text.slice(0, TEXT_CAP + 1024))
				.slice(0, TEXT_CAP)
				.trim();
			if (!text) continue;
			docs.push({
				agentId,
				eventId: e.id,
				ts: e.ts,
				role: picked.role,
				from: e.from ?? null,
				text,
				cursor,
			});
		}
		return docs;
	}

	/** The tailer's live feed: this machine's agents only. */
	tap = (agentId: string, events: TranscriptEvent[]) => {
		if (agentId.includes("/")) return;
		this.index.upsert(this.docsFrom(agentId, events, null));
	};

	/**
	 * One backfill pass over this machine's agents. A log file is read from
	 * its end back to where the last pass stopped (the first time: at most
	 * `FIRST_PASS_PAGES` pages), so a restart resumes instead of starting
	 * over. A file that shrank or moved is indexed again from scratch.
	 */
	async backfill(): Promise<number> {
		let n = 0;
		for (const agent of this.registry.all()) {
			if (agent.id.includes("/")) continue;
			try {
				n += await this.backfillAgent(agent.id, agent.status !== "gone");
			} catch (e) {
				debugLog(`search backfill ${agent.id}: ${(e as Error).message}`);
			}
			await yieldLoop();
		}
		return n;
	}

	/** Writes a page's rows a few at a time, yielding between (FTS5 inserts add up). */
	private async write(docs: Doc[]) {
		for (let i = 0; i < docs.length; i += WRITE_CHUNK) {
			this.index.upsert(docs.slice(i, i + WRITE_CHUNK));
			await yieldLoop();
		}
	}

	/** Indexes what is new in one agent's transcript; returns events read. */
	async backfillAgent(agentId: string, live = true): Promise<number> {
		const src = await this.transcripts.source(agentId);
		if (!src) return 0;
		if (src.kind === "poll") {
			// A harness API answers only while its session runs.
			if (!live) return 0;
			// A harness API: its newest page, as the live poll would see it.
			const page = await this.transcripts.page(agentId, null);
			if (!page.available) return 0;
			await this.write(this.docsFrom(agentId, page.events, null));
			return page.events.length;
		}
		let state = this.index.state(agentId);
		if (state && (state.path !== src.path || src.size < state.top)) {
			await this.index.forgetAgent(agentId);
			state = null;
		}
		if (state && state.top === src.size) return 0;
		const top = state?.top ?? 0;
		const cutoff = this.now() - RETENTION_MS;
		// Explicit cursors only: a page asked for by byte offset is the same
		// page later (the log only grows), so a hit can open it again.
		let cursor = String(src.size);
		let read = 0;
		for (let pages = 1; ; pages++) {
			const page = await this.transcripts.page(agentId, cursor);
			// Not readable now: keep where we were, so the next pass reads it all.
			if (!page.available) return read;
			read += page.events.length;
			await this.write(this.docsFrom(agentId, page.events, cursor));
			const begin = page.cursor;
			if (!begin || Number(begin) <= top) break;
			if (!state && pages >= FIRST_PASS_PAGES) break;
			const newest = page.events.reduce((m, e) => Math.max(m, e.ts), 0);
			if (page.events.length > 0 && newest < cutoff) break;
			cursor = begin;
			await yieldLoop();
		}
		this.index.setState(agentId, { path: src.path, top: src.size });
		return read;
	}

	/** Forgets events past retention. */
	prune(): Promise<number> {
		return this.index.prune(this.now() - RETENTION_MS);
	}

	/**
	 * This machine's hits for `q`, best first (at most `PER_AGENT` per agent).
	 * With `agentId`: that agent's hits only, oldest first, up to
	 * `AGENT_HITS` (the find bar steps through them in reading order).
	 */
	local(q: string, opts: { agentId?: string; limit?: number } = {}): LocalHits {
		const query = parseQuery(q);
		if (!query || this.off) return { hits: [] };
		const now = this.now();
		if (opts.agentId) {
			const limit = clamp(opts.limit ?? AGENT_HITS, AGENT_HITS);
			const docs = this.registry.find(opts.agentId)
				? this.index.find(query, { agentId: opts.agentId, limit })
				: [];
			return {
				hits: docs
					.sort((a, b) => a.ts - b.ts)
					.map((d) => toHit(query, d, score(query, d, now))),
			};
		}
		const limit = clamp(opts.limit ?? MAX_HITS, MAX_HITS);
		const scored = this.index
			.find(query)
			.filter((d) => this.registry.find(d.agentId))
			.map((d) => ({ d, s: score(query, d, now) }))
			.sort((a, b) => b.s - a.s || b.d.ts - a.d.ts);
		const perAgent = new Map<string, number>();
		const hits: MessageHit[] = [];
		for (const { d, s } of scored) {
			const n = perAgent.get(d.agentId) ?? 0;
			if (n >= PER_AGENT) continue;
			perAgent.set(d.agentId, n + 1);
			hits.push(toHit(query, d, s));
			if (hits.length >= limit) break;
		}
		return { hits };
	}

	/**
	 * Search for the app: this machine's hits and every reachable peer's
	 * (their ids made pool addresses), merged by score. With `agent`: that
	 * agent's hits, oldest first, from its home node. An agent finds only its
	 * own transcript's events, like `transcript.read`.
	 */
	async search(
		q: string,
		as: Principal,
		opts: { limit?: number; agent?: string } = {},
	): Promise<MessageSearchResponse> {
		const agent = opts.agent ?? (as.kind === "agent" ? as.agentId : undefined);
		const pool = this.registry.pool;
		let hits: MessageHit[] = [];
		let missing: string[] = [];
		if (agent !== undefined) {
			const limit = clamp(opts.limit ?? AGENT_HITS, AGENT_HITS);
			if (isAddress(agent) && pool?.get(agent)) {
				if (pool.searchAgentMessages && parseQuery(q)) {
					const machineId = agent.slice(0, agent.indexOf("/"));
					const theirs = await pool
						.searchAgentMessages(agent, q, limit, as)
						.catch((e: unknown) => {
							// An older home node has no message search: nothing to find there.
							if (
								e instanceof RpcError &&
								(e.code === "unsupported" || e.code === "bad_request")
							)
								return [];
							throw e;
						});
					for (const h of theirs) {
						const hit = cleanHit(h, machineId);
						if (hit?.agentId === agent) hits.push(hit);
					}
					hits.sort((a, b) => a.ts - b.ts);
				}
			} else hits = this.local(q, { agentId: agent, limit }).hits;
		} else {
			const limit = clamp(opts.limit ?? MAX_HITS, MAX_HITS);
			hits = this.local(q, { limit }).hits;
			if (pool?.searchMessages && parseQuery(q)) {
				const remote = await pool.searchMessages(q, limit, as);
				missing = remote.missing;
				for (const { machineId, hits: theirs } of remote.answers)
					for (const h of theirs) {
						const hit = cleanHit(h, machineId);
						if (hit && this.registry.find(hit.agentId)) hits.push(hit);
					}
			}
			hits.sort((a, b) => b.score - a.score || b.ts - a.ts);
			hits = hits.slice(0, limit);
		}
		const agents = new Map<string, AgentRow>();
		for (const h of hits) {
			if (agents.has(h.agentId)) continue;
			const row = this.registry.find(h.agentId) as Agent | undefined;
			if (row) agents.set(h.agentId, this.views.row(row));
		}
		return {
			q,
			hits,
			agents: [...agents.values()],
			...(missing.length ? { partial: true as const, missing } : {}),
		};
	}
}

const clamp = (n: number, max: number) =>
	Math.max(1, Math.min(Math.floor(n) || 1, max));

/** What of an event the index keeps, and as whose words (null: nothing). */
export function pick(
	e: TranscriptEvent,
): { role: DocRole; text: string } | null {
	if (e.subtype === "hidden") return null;
	if (e.kind === "tool_call") {
		const title = e.tool?.summary ?? e.tool?.name;
		return title ? { role: "tool", text: title } : null;
	}
	if (e.kind === "peer" || e.role === "peer")
		return e.kind === "peer" || e.kind === "text"
			? { role: "peer", text: e.text }
			: null;
	if (e.kind !== "text") return null;
	// A team or task notice is never the operator's own words.
	if (e.notice) return { role: "peer", text: e.text };
	if (e.role === "user") return { role: "user", text: e.text };
	if (e.role === "assistant") return { role: "agent", text: e.text };
	return null;
}

function toHit(
	query: Query,
	d: {
		agentId: string;
		eventId: string;
		ts: number;
		role: DocRole;
		from: string | null;
		text: string;
		cursor: string | null;
	},
	s: number,
): MessageHit {
	const snip = snippet(query, d.text);
	return {
		agentId: d.agentId,
		eventId: d.eventId,
		ts: d.ts,
		role: d.role,
		...(d.from ? { from: d.from } : {}),
		snippet: snip.text,
		marks: snip.marks,
		cursor: d.cursor,
		score: s,
	};
}

const ROLES: ReadonlySet<string> = new Set(["user", "agent", "peer", "tool"]);

/** A peer's hit, checked field by field, its agent id made a pool address. */
function cleanHit(raw: unknown, machineId: string): MessageHit | null {
	if (!raw || typeof raw !== "object") return null;
	const h = raw as Record<string, unknown>;
	if (typeof h.agentId !== "string" || h.agentId.includes("/")) return null;
	if (typeof h.eventId !== "string" || typeof h.snippet !== "string")
		return null;
	const role = typeof h.role === "string" && ROLES.has(h.role) ? h.role : null;
	if (!role) return null;
	const text = h.snippet.slice(0, 1000);
	const marks = Array.isArray(h.marks)
		? h.marks
				.filter(
					(m): m is [number, number] =>
						Array.isArray(m) &&
						Number.isInteger(m[0]) &&
						Number.isInteger(m[1]) &&
						m[0] >= 0 &&
						m[0] < m[1] &&
						m[1] <= text.length,
				)
				.slice(0, 50)
				.map((m) => [m[0], m[1]] as [number, number])
		: [];
	return {
		agentId: `${machineId}/${h.agentId}`,
		eventId: h.eventId.slice(0, 500),
		ts: Number(h.ts) || 0,
		role: role as MessageHit["role"],
		...(typeof h.from === "string" ? { from: h.from.slice(0, 200) } : {}),
		snippet: text,
		marks,
		cursor: typeof h.cursor === "string" ? h.cursor.slice(0, 2000) : null,
		score: Math.min(Number(h.score) || 0, 10),
	};
}
