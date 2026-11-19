/**
 * The phone's message search (`#/search`): transcript messages that match,
 * across the pool, with the same snippets as Cmd-K on the desktop. Tapping
 * one opens its session at that message, with the find bar on top.
 */
import { LoaderCircleIcon, MessageSquareTextIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentAvatar } from "../../ds/index.ts";
import { ago } from "../../lib/format.ts";
import type { PageProps } from "../../lib/registry.tsx";
import { BackButton } from "../../mobile/BackButton.tsx";
import {
	IonButtons,
	IonContent,
	IonHeader,
	IonItem,
	IonTitle,
	IonToolbar,
} from "../../mobile/ionic.ts";
import { IonLabel, IonList, IonSearchbar } from "../../mobile/ionic-lazy.tsx";
import {
	type MessageSearchResponse,
	searchable,
	searchMessages,
} from "./api.ts";
import { Snippet } from "./Snippet.tsx";
import { openHit } from "./state.ts";
import "./search.css";

type Result =
	| { kind: "idle" }
	| { kind: "loading" }
	| { kind: "error" }
	| { kind: "done"; res: MessageSearchResponse };

export default function SearchPage({ params }: PageProps) {
	const [q, setQ] = useState(params.q ?? "");
	const [result, setResult] = useState<Result>({ kind: "idle" });
	useEffect(() => {
		if (!searchable(q)) {
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
	}, [q]);

	const rows =
		result.kind === "done"
			? new Map(result.res.agents.map((a) => [a.id, a]))
			: new Map();
	return (
		<>
			<IonHeader translucent>
				<IonToolbar>
					<IonButtons slot="start">
						<BackButton route={{ view: "page", name: "search" }} />
					</IonButtons>
					<IonTitle>Search</IonTitle>
				</IonToolbar>
			</IonHeader>
			<IonContent fullscreen className="p-search-page">
				<IonHeader collapse="condense">
					<IonToolbar>
						<IonTitle size="large">Search</IonTitle>
					</IonToolbar>
					<IonToolbar>
						<IonSearchbar
							className="p-search"
							placeholder="Search messages"
							aria-label="Search messages"
							value={q}
							debounce={0}
							enterkeyhint="search"
							onIonInput={(e) => setQ(e.detail.value ?? "")}
						/>
					</IonToolbar>
				</IonHeader>
				{result.kind === "idle" && (
					<div className="p-empty msr-empty">
						<MessageSquareTextIcon />
						<h3>Search Messages</h3>
						<p>
							Find what you and your agents wrote. Type a word of 3 letters or
							more.
						</p>
					</div>
				)}
				{result.kind === "loading" && (
					<p className="msr-state" role="status">
						<LoaderCircleIcon className="msr-spin" aria-hidden="true" />{" "}
						Searching messages…
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
					<IonList inset aria-label="Messages">
						{result.res.hits.map((hit, i) => {
							const a = rows.get(hit.agentId);
							return (
								<IonItem
									key={`${hit.agentId}#${hit.eventId}`}
									button
									detail={false}
									lines={i === result.res.hits.length - 1 ? "none" : "inset"}
									className="msr-row"
									onClick={() => openHit(hit, q)}
								>
									{a && (
										<span slot="start" className="msr-avatar">
											<AgentAvatar harness={a.harness} size="sm" />
										</span>
									)}
									<IonLabel>
										<span className="msr-row-head">
											<strong>{a?.name ?? hit.agentId}</strong>
											<time dateTime={new Date(hit.ts).toISOString()}>
												{ago(hit.ts)}
											</time>
										</span>
										<Snippet hit={hit} />
									</IonLabel>
								</IonItem>
							);
						})}
					</IonList>
				)}
				{result.kind === "done" && result.res.partial && (
					<p className="msr-state is-partial">
						{result.res.missing?.join(", ")} didn't answer
					</p>
				)}
			</IonContent>
		</>
	);
}
