import type { AgentRow, AskRequest, AskResponse } from "../http/wire.ts";
import type { TranscriptEvent } from "../transcripts/types.ts";
import { type AgentWork, parseQuestion, rank, workFrom } from "./ask-core.ts";
import type { Transcripts } from "./transcripts.ts";
import type { Views } from "./views.ts";

/** Agents whose logs one question may read. */
const MAX_READ = 150;
/** Transcript pages read per agent (newest first). */
const PAGES = 2;
/** Agents kept in the index. */
const MAX_CACHED = 300;
const CONCURRENCY = 8;

/**
 * Ask, answered locally: who works on a file, a PR, a branch or a project,
 * from the registry and a touched-files index built from session logs.
 * Nobody is woken. The index is lazy: an agent's log is read only when a
 * question needs it, and re-read only when its fingerprint (size + mtime)
 * changed. Local agents only; federation serves `local()` to peers and merges.
 */
export class Lookup {
	private readonly views: Views;
	private readonly transcripts: Transcripts;
	/** Agent id → its work at a transcript fingerprint; Map order is LRU. */
	private cache = new Map<string, { stamp: string; work: AgentWork }>();
	/** Log reads done so far (tests check the cache). */
	reads = 0;

	constructor(deps: { views: Views; transcripts: Transcripts }) {
		this.views = deps.views;
		this.transcripts = deps.transcripts;
	}

	/** Answers a question from this node's agents. */
	async local(
		q: AskRequest,
		opts: { localOnly?: boolean } = {},
	): Promise<AskResponse> {
		const matched = this.views.matching(q.selector?.trim() || "*");
		// `localOnly`: this machine's agents (what federation serves to peers).
		const rows = opts.localOnly
			? matched.filter((r) => !r.id.includes("/"))
			: matched;
		const intent = parseQuestion(q.question, rows);
		const needsLogs =
			intent.paths.length +
				intent.numbers.length +
				intent.agents.length +
				intent.words.length >
			0;
		const work = new Map<string, AgentWork>();
		if (needsLogs) {
			const named = intent.agents;
			const candidates = rows
				.filter((r) => r.hasTranscript)
				.sort(
					(a, b) =>
						Number(named.includes(b.name.toLowerCase())) -
							Number(named.includes(a.name.toLowerCase())) ||
						b.lastSeen - a.lastSeen,
				)
				.slice(0, MAX_READ);
			let next = 0;
			await Promise.all(
				Array.from({ length: CONCURRENCY }, async () => {
					while (next < candidates.length) {
						const r = candidates[next++]!;
						const w = await this.workFor(r);
						if (w) work.set(r.id, w);
					}
				}),
			);
		}
		return rank(q.question, intent, rows, (r) => work.get(r.id) ?? null);
	}

	/** What an agent's recent log says it touched; cached by fingerprint. */
	async workFor(row: AgentRow): Promise<AgentWork | null> {
		const stamp = await this.transcripts.stamp(row.id);
		if (!stamp) return null;
		const hit = this.cache.get(row.id);
		if (hit?.stamp === stamp) {
			this.cache.delete(row.id);
			this.cache.set(row.id, hit);
			return hit.work;
		}
		const events: TranscriptEvent[] = [];
		try {
			let cursor: string | null = null;
			for (let i = 0; i < PAGES; i++) {
				this.reads++;
				const page = await this.transcripts.page(row.id, cursor);
				if (!page.available) return null;
				events.push(...page.events);
				cursor = page.cursor;
				if (!cursor) break;
			}
		} catch {
			return null;
		}
		const work = workFrom(events, row.cwd);
		this.cache.delete(row.id);
		this.cache.set(row.id, { stamp, work });
		while (this.cache.size > MAX_CACHED) {
			const oldest = this.cache.keys().next().value;
			if (oldest === undefined) break;
			this.cache.delete(oldest);
		}
		return work;
	}
}
