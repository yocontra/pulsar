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
import { matches, parseQuery, score, snippet } from "../../src/search/text.ts";
import {
	AGENT_HITS,
	MAX_HITS,
	pick,
} from "../../src/service/message-search.ts";
import type { MockAgent } from "./data.ts";
import { logFor } from "./transcript.ts";

/** Events on the newest page of a mock transcript (`page()`'s default). */
const NEWEST_PAGE = 150;
const PER_AGENT = 5;

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
			const picked = e.sidechain ? null : pick(e);
			if (!picked) return;
			const text = redactSecrets(picked.text).trim();
			if (!text || !matches(query, text)) return;
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
