/**
 * The phone's message search (`#/search`, "See all" from Home's "In
 * messages"): transcript messages that match, across the pool, with the
 * same snippets as Cmd-K on the desktop. Tapping one opens its session at
 * that message, with the find bar on top.
 */
import { Searchbar } from "konsta/react";
import { LoaderCircleIcon, MessageSquareTextIcon } from "lucide-react";
import { useState } from "react";
import type { PageProps } from "../../lib/registry.tsx";
import { can } from "../../lib/store.ts";
import { GroupedList } from "../../mobile/ui/GroupedList.tsx";
import { PageShell } from "../../mobile/ui/PageShell.tsx";
import { HitRow, useMessageSearch } from "./results.tsx";
import "../../mobile/home.css";

export default function SearchPage({ params }: PageProps) {
	const [q, setQ] = useState(params.q ?? "");
	const off = !can("search");
	const result = useMessageSearch(q, off);
	return (
		<PageShell
			title="Search"
			route={{ view: "page", name: "search" }}
			className="p-search-page"
			below={
				<div role="search" className="p-home-search" data-testid="page-search">
					<label htmlFor="p-search-q" className="sr-only">
						Search messages
					</label>
					<Searchbar
						inputId="p-search-q"
						placeholder="Search messages"
						value={q}
						onInput={(e: React.FormEvent<HTMLInputElement>) =>
							setQ(e.currentTarget.value)
						}
						onClear={() => setQ("")}
					/>
				</div>
			}
		>
			{result.kind === "idle" && (
				<div className="p-empty msr-empty">
					<MessageSquareTextIcon />
					<h3>Search Messages</h3>
					<p>
						{off
							? "Message search is off on this machine."
							: "Find what you and your agents wrote. Type a word of 3 letters or more."}
					</p>
				</div>
			)}
			{result.kind === "loading" && (
				<p className="msr-state" role="status">
					<LoaderCircleIcon className="msr-spin" aria-hidden="true" /> Searching
					messages…
				</p>
			)}
			{result.kind === "error" && (
				<p className="msr-state is-error" role="alert">
					Couldn't search messages
				</p>
			)}
			{result.kind === "done" && result.res.hits.length === 0 && (
				<p className="msr-state" role="status">
					No matches
				</p>
			)}
			{result.kind === "done" && result.res.hits.length > 0 && (
				<GroupedList label="Messages">
					{result.res.hits.map((hit) => (
						<HitRow
							key={`${hit.agentId}#${hit.eventId}`}
							hit={hit}
							res={result.res}
							q={q}
						/>
					))}
				</GroupedList>
			)}
			{result.kind === "done" && result.res.partial && (
				<p className="msr-state is-partial">
					{result.res.missing?.join(", ")} didn't answer
				</p>
			)}
		</PageShell>
	);
}
