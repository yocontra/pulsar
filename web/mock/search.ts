/**
 * Message search for the mock API (`GET /search/messages`), with the
 * daemon's own rules: the same event filter, query parsing, scoring and
 * snippets (src/search, src/service/message-search.ts), over the mock
 * transcripts. Agents on a machine that is asleep or down are left out and
 * the machine is named in `missing`, like a peer that did not answer.
 */
import type {
	AgentRow,
	MessageHit,
	MessageSearchResponse,
} from "../../src/http/wire.ts";
import { redactSecrets } from "../../src/search/redact.ts";
import {
	parseQuery,
	type Query,
	score,
	snippet,
	words,
} from "../../src/search/text.ts";
import {
	AGENT_HITS,
	MAX_HITS,
	pick,
} from "../../src/service/message-search.ts";
import type { TranscriptEvent } from "../../src/transcripts/types.ts";
import type { MockAgent } from "./data.ts";
import { logFor } from "./transcript.ts";

/** Events on the newest page of a mock transcript (`page()`'s default). */
const NEWEST_PAGE = 150;
const PER_AGENT = 5;

/** What search keeps of one event, worked out once (replaced events are new objects). */
interface Indexed {
	role: MessageHit["role"];
	text: string;
	words: Set<string>;
}
const cache = new WeakMap<TranscriptEvent, Indexed | null>();

function indexed(e: TranscriptEvent): Indexed | null {
	const hit = cache.get(e);
	if (hit !== undefined) return hit;
	const picked = e.sidechain ? null : pick(e);
	const text = picked ? redactSecrets(picked.text).trim() : "";
	const out =
		picked && text
			? { role: picked.role, text, words: new Set(words(text)) }
			: null;
	cache.set(e, out);
	return out;
}

/** True when `ws` has every term (the last one as a prefix while typing), like `matches()`. */
function hasAll(query: Query, ws: Set<string>): boolean {
	const last = query.terms.length - 1;
	return query.terms.every(
		(t, i) =>
			ws.has(t) ||
			(query.prefix && i === last && [...ws].some((w) => w.startsWith(t))),
	);
}

/**
 * Builds every transcript and its words before the server listens, so a
 * search costs set lookups, never minutes of parsing on a loaded machine.
 */
export function warmSearch(agents: MockAgent[]) {
	for (const a of agents)
		if (a.hasTranscript) for (const e of logFor(a).events) indexed(e);
}

export function searchMessages(
	q: string,
	agents: MockAgent[],
	opts: {
		row: (a: MockAgent) => AgentRow;
		unreachable: (a: MockAgent) => boolean;
		/** The find bar: this agent's hits only, oldest first. */
		agent?: string;
	},
): MessageSearchResponse {
	const query = parseQuery(q);
	if (!query) return { q, hits: [], agents: [] };
	const now = Date.now();
	const missing = new Set<string>();
	const found: { hit: MessageHit; agent: MockAgent }[] = [];
	for (const a of agents) {
		if (!a.hasTranscript) continue;
		if (opts.agent !== undefined && a.id !== opts.agent) continue;
		if (opts.unreachable(a)) {
			missing.add(a.machine);
			continue;
		}
		const events = logFor(a).events;
		const mine: { hit: MessageHit; agent: MockAgent }[] = [];
		events.forEach((e, i) => {
			const picked = indexed(e);
			if (!picked || !hasAll(query, picked.words)) return;
			const text = picked.text;
			const snip = snippet(query, text);
			mine.push({
				agent: a,
				hit: {
					agentId: a.id,
					eventId: e.id,
					ts: e.ts,
					role: picked.role,
					...(e.from ? { from: e.from } : {}),
					snippet: snip.text,
					marks: snip.marks,
					// `page(agent, String(i + 1))` ends with this event.
					cursor: i >= events.length - NEWEST_PAGE ? null : String(i + 1),
					score: score(query, { text, ts: e.ts, role: picked.role }, now),
				},
			});
		});
		if (opts.agent !== undefined) {
			const hits = mine.map((m) => m.hit).slice(-AGENT_HITS);
			return { q, hits, agents: hits.length ? [opts.row(a)] : [] };
		}
		mine.sort((x, y) => y.hit.score - x.hit.score || y.hit.ts - x.hit.ts);
		found.push(...mine.slice(0, PER_AGENT));
	}
	if (opts.agent !== undefined)
		return {
			q,
			hits: [],
			agents: [],
			...(missing.size
				? { partial: true as const, missing: [...missing] }
				: {}),
		};
	found.sort((x, y) => y.hit.score - x.hit.score || y.hit.ts - x.hit.ts);
	const top = found.slice(0, MAX_HITS);
	const rows = new Map<string, AgentRow>();
	for (const { agent } of top)
		if (!rows.has(agent.id)) rows.set(agent.id, opts.row(agent));
	return {
		q,
		hits: top.map((f) => f.hit),
		agents: [...rows.values()],
		...(missing.size ? { partial: true as const, missing: [...missing] } : {}),
	};
}
