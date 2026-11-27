/**
 * The phone's message results: the search (debounced, cancelled when the
 * query changes) and the rows, shared by Home's "In messages" section
 * (HomeResults.tsx) and the search page (SearchPage.tsx).
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { AgentAvatar } from "../../ds/index.ts";
import { ago } from "../../lib/format.ts";
import { navigate } from "../../lib/router.ts";
import { GroupedList, ListItem } from "../../mobile/ui/GroupedList.tsx";
import {
	type MessageHit,
	type MessageSearchResponse,
	savedSessions,
	searchable,
	searchMessages,
} from "./api.ts";
import { Snippet } from "./Snippet.tsx";
import { openHit } from "./state.ts";
import "./search.css";

export type Result =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "done"; res: MessageSearchResponse };

/** The pool's message hits for `q` (idle under 3 letters or when `off`). */
export function useMessageSearch(q: string, off: boolean): Result {
	const [result, setResult] = useState<Result>({ kind: "idle" });
	useEffect(() => {
		if (off || !searchable(q)) {
			setResult({ kind: "idle" });
			return;
		}
		const ctrl = new AbortController();
		setResult({ kind: "loading" });
		const t = setTimeout(() => {
			searchMessages(q, { signal: ctrl.signal })
				.then((res) => {
					if (!ctrl.signal.aborted) setResult({ kind: "done", res });
				})
				.catch(() => {
					if (!ctrl.signal.aborted) setResult({ kind: "error" });
				});
		}, 200);
		return () => {
			clearTimeout(t);
			ctrl.abort();
		};
	}, [q, off]);
	return result;
}

/** One hit: the agent's mark, its name and when, then the snippet. Opens its session at the match. */
export function HitRow({
	hit,
	res,
	q,
}: {
	hit: MessageHit;
	res: MessageSearchResponse;
	q: string;
}) {
	const a = res.agents.find((x) => x.id === hit.agentId);
	return (
		<ListItem
			className="msr-row"
			link
			linkComponent="button"
			chevron={false}
			media={
				a ? (
					<span className="msr-avatar">
						<AgentAvatar harness={a.harness} size="sm" />
					</span>
				) : undefined
			}
			title={<strong className="msr-name">{a?.name ?? hit.agentId}</strong>}
			after={
				<time dateTime={new Date(hit.ts).toISOString()}>{ago(hit.ts)}</time>
			}
			text={<Snippet hit={hit} />}
			onClick={() => openHit(hit, q)}
		/>
	);
}

export function SavedSessions({ query }: { query: string }) {
	const q = query.trim();
	const saved = useQuery({
		queryKey: ["savedSessions", q],
		queryFn: ({ signal }) => savedSessions(q, signal),
		retry: false,
		staleTime: 5000,
	});
	if (!saved.data?.length) return null;
	return (
		<GroupedList title="Saved conversations on this machine">
			{saved.data.map((s) => (
				<ListItem
					link
					linkComponent="button"
					key={s.id}
					title={s.name}
					text={s.project ?? s.harness}
					after={ago(s.lastSeen)}
					onClick={() => navigate({ view: "agent", id: s.id })}
				/>
			))}
		</GroupedList>
	);
}
