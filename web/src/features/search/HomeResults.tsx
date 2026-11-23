/**
 * Home's "In messages" section (the home.search slot): while the search
 * field has a query, the best message hits under the filtered tree, and
 * "See all" to the search page with the same query.
 */
import { LoaderCircleIcon } from "lucide-react";
import { navigate } from "../../lib/router.ts";
import { observer } from "../../lib/signals.ts";
import { can } from "../../lib/store.ts";
import { GroupedList, ListItem } from "../../mobile/ui/GroupedList.tsx";
import { HitRow, useMessageSearch } from "./results.tsx";

const SHOWN = 4;

function HomeResults({ query }: { query: string }) {
	const q = query.trim();
	const result = useMessageSearch(q, !can("search"));
	if (result.kind === "idle") return null;
	const hits = result.kind === "done" ? result.res.hits : [];
	return (
		<div className="msr-home" data-testid="home-messages">
			<GroupedList title="In messages" label="In messages">
				{result.kind === "loading" && (
					<ListItem
						title={
							<span className="msr-state is-row" role="status">
								<LoaderCircleIcon className="msr-spin" aria-hidden="true" />
								Searching messages…
							</span>
						}
					/>
				)}
				{result.kind === "error" && (
					<ListItem
						title={
							<span className="msr-state is-row is-error" role="alert">
								Couldn't search messages
							</span>
						}
					/>
				)}
				{result.kind === "done" && hits.length === 0 && (
					<ListItem
						title={
							<span className="msr-state is-row" role="status">
								No messages match
							</span>
						}
					/>
				)}
				{result.kind === "done" &&
					hits
						.slice(0, SHOWN)
						.map((hit) => (
							<HitRow
								key={`${hit.agentId}#${hit.eventId}`}
								hit={hit}
								res={result.res}
								q={q}
							/>
						))}
				{result.kind === "done" && hits.length > 0 && (
					<ListItem
						className="msr-all"
						link
						linkComponent="button"
						title={
							hits.length > SHOWN
								? `See all ${hits.length} messages`
								: "Open in search"
						}
						onClick={() =>
							navigate({ view: "page", name: "search", params: { q } })
						}
					/>
				)}
			</GroupedList>
		</div>
	);
}

export default observer(HomeResults);
