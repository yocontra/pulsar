import { ChevronRightIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { ApiError } from "../api/client.ts";
import type { SubagentRow } from "../api/types.ts";
import { Composer } from "../components/Composer.tsx";
import { kindWord, SubagentStateWord } from "../components/SubagentRows.tsx";
import { harnessName } from "../components/ui/agent-avatar.tsx";
import { useNow } from "../data/clock.ts";
import { useAgent, useSubagent, useTranscript } from "../data/index.ts";
import { AgentAvatar } from "../ds/index.ts";
import { age } from "../lib/format.ts";
import { navigate } from "../lib/router.ts";
import { findAgent } from "../lib/store.ts";
import { ConversationView, TranscriptSkeleton } from "./ConversationView.tsx";
import { Transcript } from "./Transcript.tsx";

/** At most this many events in the DOM; older ones behind "load earlier". */
const WINDOW = 300;

/**
 * A subagent's page (`#/s/<id>`): a breadcrumb back to its parent agent,
 * its own transcript, live, and a composer that says plainly where a
 * message goes (into the subagent, or to the parent naming it). Desktop
 * main pane and the phone's pushed page share it; the phone draws its own
 * header (`bare`).
 */
export function SubagentView({
	id,
	mobile,
	bare,
}: {
	id: string;
	mobile: boolean;
	bare?: boolean;
}) {
	const q = useSubagent(id);
	const sub = q.data;
	const parentId = sub?.parentId ?? null;
	const parent = useAgent(parentId).data;
	const parentName =
		parent?.name ?? (parentId ? findAgent(parentId)?.name : null) ?? "agent";
	const t = useTranscript(sub ? id : null);
	const [shown, setShown] = useState(WINDOW);
	const windowed = useMemo(
		() => t.events.slice(Math.max(0, t.events.length - shown)),
		[t.events, shown],
	);
	const missing =
		q.error instanceof ApiError && q.error.code === "not_found" && !sub;
	const variant = mobile ? "phone" : "desktop";

	const loadEarlier = async () => {
		if (t.events.length > shown) setShown(shown + 100);
		else if (await t.loadEarlier()) setShown(shown + 100);
	};

	return (
		<section
			className={`session subagent${mobile ? " mobile" : ""}`}
			aria-label={`Subagent ${sub?.name ?? ""}`}
			data-subagent-page={id}
		>
			{!bare && <SubagentHeader sub={sub} parentName={parentName} id={id} />}
			<ConversationView
				variant={variant}
				label={`Transcript of subagent ${sub?.name ?? ""}`}
			>
				{(t.events.length > shown || t.cursor) && (
					<button
						type="button"
						className="ds-load-earlier load-earlier"
						onClick={loadEarlier}
					>
						Load earlier messages
					</button>
				)}
				{missing && (
					<div className="ds-banner banner" role="status">
						This subagent is gone (its parent ended or its log was removed).
					</div>
				)}
				{sub && t.isPending && <TranscriptSkeleton variant={variant} />}
				{sub && !t.isPending && (!sub.hasTranscript || !t.available) && (
					<div className="ds-banner banner" role="status">
						{harnessName(sub.harness)} doesn't share this subagent's transcript
						with Pulsar.
					</div>
				)}
				<Transcript
					events={windowed}
					variant={variant}
					agent={
						sub
							? {
									name: sub.name,
									harness: sub.harness,
									// A running subagent's last turn has no change summary yet.
									state: sub.state === "running" ? "busy" : undefined,
								}
							: null
					}
					working={sub?.state === "running" && windowed.at(-1)?.role === "user"}
				/>
			</ConversationView>
			{sub && (
				<>
					<p className="sub-note" data-messaging={sub.messaging.mode}>
						{sub.messaging.note}
					</p>
					<Composer
						key={sub.id}
						target={{
							kind: "ids",
							ids: [sub.id],
							label:
								sub.messaging.mode === "direct"
									? sub.name
									: `${parentName}, for ${sub.name}`,
						}}
						viaParent={sub.messaging.mode === "parent"}
						showTo={!mobile}
						compact={mobile}
						placeholder={
							sub.messaging.mode === "direct"
								? `Message ${sub.name}…`
								: `Message ${parentName} about ${sub.name}…`
						}
					/>
				</>
			)}
		</section>
	);
}

/** Breadcrumb (parent › Subagents), name and live state, one meta line. */
export function SubagentHeader({
	sub,
	parentName,
	id,
}: {
	sub: SubagentRow | undefined;
	parentName: string;
	id: string;
}) {
	const now = useNow();
	return (
		<header className="sub-head">
			<nav className="sub-crumbs" aria-label="Breadcrumb">
				<button
					type="button"
					disabled={!sub}
					onClick={() => sub && navigate({ view: "agent", id: sub.parentId })}
				>
					{parentName}
				</button>
				<ChevronRightIcon aria-hidden="true" />
				<span>Subagents</span>
			</nav>
			<div className="sub-title">
				<AgentAvatar harness={sub?.harness} size="sm" />
				<h1>{sub?.name ?? "Subagent"}</h1>
				{sub && <SubagentStateWord sub={sub} now={now} />}
			</div>
			{sub && (
				<div className="sub-meta">
					{[
						sub.agentType,
						kindWord(sub),
						`started ${age(sub.startedAt, now)} ago`,
						sub.description,
					]
						.filter(Boolean)
						.join(" · ")}
				</div>
			)}
			{!sub && <span className="sr-only">{id}</span>}
		</header>
	);
}

export default SubagentView;
