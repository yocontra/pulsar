/**
 * Cmd-K's "In messages" group: transcript messages that match the query,
 * across the pool. Choosing one opens its session at that message, with the
 * find bar prefilled.
 */
import { AgentAvatar } from "../../ds/index.ts";
import { ago } from "../../lib/format.ts";
import type { PaletteResult } from "../../lib/registry.tsx";
import { can } from "../../lib/store.ts";
import { searchable, searchMessages } from "./api.ts";
import { Snippet } from "./Snippet.tsx";
import { openHit } from "./state.ts";
import "./search.css";

export async function messageResults(
	q: string,
	signal: AbortSignal,
): Promise<PaletteResult[]> {
	if (!can("search") || !searchable(q)) return [];
	const res = await searchMessages(q, { signal });
	const rows = new Map(res.agents.map((a) => [a.id, a]));
	return res.hits.map((hit) => {
		const a = rows.get(hit.agentId);
		return {
			key: `${hit.agentId}#${hit.eventId}`,
			label: a?.name ?? hit.agentId,
			sub: <Snippet hit={hit} />,
			...(a ? { icon: <AgentAvatar harness={a.harness} size="sm" /> } : {}),
			trail: (
				<time className="msr-time" dateTime={new Date(hit.ts).toISOString()}>
					{ago(hit.ts)}
				</time>
			),
			run: () => openHit(hit, q),
		};
	});
}
