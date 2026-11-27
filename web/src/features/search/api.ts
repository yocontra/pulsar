/**
 * Message search over the daemon's `GET /search/messages` (src/service/
 * message-search.ts): the pool's best hits, or one agent's hits oldest first
 * (the find bar). Queries need a word of 3 letters; shorter ones never reach
 * the server.
 */

import { parseQuery } from "../../../../src/search/text.ts";
import { request } from "../../api/client.ts";
import type {
	MessageHit,
	MessageSearchResponse,
	SavedSessionHit,
} from "../../api/types.ts";

export type { MessageHit, MessageSearchResponse };

/** True when `q` has a word the server searches for (3 letters or more). */
export function searchable(q: string): boolean {
	return parseQuery(q) !== null;
}

/** The query's words, as the server matched them (for marking text in the page). */
export function queryWords(q: string): { terms: string[]; prefix: boolean } {
	const p = parseQuery(q);
	return p
		? { terms: p.terms, prefix: p.prefix }
		: { terms: [], prefix: false };
}

export function searchMessages(
	q: string,
	opts: { agent?: string; signal?: AbortSignal } = {},
): Promise<MessageSearchResponse> {
	const params = new URLSearchParams({ q });
	if (opts.agent) {
		params.set("agent", opts.agent);
		params.set("limit", "200");
	}
	return request<MessageSearchResponse>(`/search/messages?${params}`, {
		...(opts.signal ? { signal: opts.signal } : {}),
	});
}

export async function savedSessions(q: string, signal?: AbortSignal) {
	const res = await request<{ items: SavedSessionHit[] }>(
		`/sessions/saved?${new URLSearchParams({ q })}`,
		{ signal },
	);
	return res.items;
}
