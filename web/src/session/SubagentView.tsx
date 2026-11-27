import { ChevronRightIcon, SquareIcon } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ApiError, api, ProveCancelled } from "../api/client.ts";
import type { AgentRow, SubagentRow } from "../api/types.ts";
import { focusPrompt } from "../approval/focus.ts";
import { PromptInline } from "../approval/PromptInline.tsx";
import { Composer } from "../components/Composer.tsx";
import { kindWord, SubagentStateWord } from "../components/SubagentRows.tsx";
import { useNow } from "../data/clock.ts";
import {
	useAgent,
	useApprovalItem,
	useSubagent,
	useTranscript,
} from "../data/index.ts";
import { AgentAvatar, AgentMark } from "../ds/index.ts";
import { agentColor } from "../lib/agent-color.ts";
import { age } from "../lib/format.ts";
import { navigate, route } from "../lib/router.ts";
import { findAgent, showToast } from "../lib/store.ts";
import { messagesViaParent } from "../lib/subagents.ts";
import { ConversationView, TranscriptSkeleton } from "./ConversationView.tsx";
import { Transcript } from "./Transcript.tsx";
import { TranscriptMissingNotice } from "./TranscriptMissing.tsx";
import { useSessionNotice } from "./use-session-notice.ts";

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
	const noteId = useId();
	const q = useSubagent(id);
	const sub = q.data;
	const parentId = sub?.parentId ?? null;
	const parent = useAgent(parentId).data;
	const parentName =
		parent?.name ?? (parentId ? findAgent(parentId)?.name : null) ?? "agent";
	// A finished subagent the daemon found no log for keeps none (a Codex
	// subagent with no rollout): final. A running one may still write it.
	const settled = sub?.hasTranscript === false && sub.state !== "running";
	useSessionNotice(id);
	const t = useTranscript(sub ? id : null, settled);
	const lastApprovalAgent = useRef<AgentRow | null>(null);
	const item = useApprovalItem(id, (agentId) =>
		lastApprovalAgent.current?.id === agentId
			? lastApprovalAgent.current
			: null,
	);
	useEffect(() => {
		if (item) lastApprovalAgent.current = item.agent;
	}, [item]);
	const pending = item?.approval?.state === "pending";
	useEffect(() => {
		const current = route.peek();
		if (pending && current.view === "approval" && current.id === id)
			focusPrompt(id);
	}, [id, pending]);
	const missing = t.missing && settled ? ("unsupported" as const) : t.missing;
	const [shown, setShown] = useState(WINDOW);
	const windowed = useMemo(
		() => t.events.slice(Math.max(0, t.events.length - shown)),
		[t.events, shown],
	);
	const gone =
		q.error instanceof ApiError && q.error.code === "not_found" && !sub;
	const messaging = sub?.messaging;
	const directFinished = messaging?.mode === "direct" && sub?.state === "done";
	const viaParent = sub ? messagesViaParent(sub) : false;

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
			{bare && sub?.conversationTitle && (
				<p className="session-conversation-title">{sub.conversationTitle}</p>
			)}
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
				{gone && (
					<div className="ds-banner banner" role="status">
						This subagent is gone (its parent ended or its log was removed).
					</div>
				)}
				{sub && t.isPending && <TranscriptSkeleton variant={variant} />}
				{sub && !t.isPending && missing && t.events.length === 0 && (
					<TranscriptMissingNotice
						key={id}
						missing={missing}
						harness={sub.harness}
						subject="subagent"
						variant={variant}
						onRetry={() => void t.refetch()}
					/>
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
					// Its siblings' names here take their colors from the parent's list.
					subagentsOf={parentId}
					fileWorkspace={parent}
				/>
				{item?.approval && <PromptInline item={item} mobile={mobile} />}
			</ConversationView>
			{sub && messaging && (
				<p
					id={noteId}
					className="sub-note"
					data-messaging={viaParent ? "parent" : "direct"}
				>
					{directFinished
						? `${sub.name} has finished. This message goes to the parent agent, ${parentName}.`
						: messaging.note}
				</p>
			)}
			{sub && messaging && (
				<Composer
					key={sub.id}
					target={{
						kind: "ids",
						ids: [sub.id],
						label: !viaParent ? sub.name : `${parentName}, for ${sub.name}`,
					}}
					viaParent={viaParent}
					showTo={!mobile}
					compact={mobile}
					describedBy={noteId}
					placeholder={
						!viaParent
							? `Message ${sub.name}…`
							: `Message ${parentName} about ${sub.name}…`
					}
				/>
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
				<AgentMark color={sub ? agentColor(sub) : null} />
				<h1>{sub?.name ?? "Subagent"}</h1>
				{sub && <SubagentStateWord sub={sub} now={now} />}
				{sub?.canStop && <SubagentStop sub={sub} />}
			</div>
			{sub && (
				<div className="sub-meta">
					{[
						sub.agentType,
						kindWord(sub),
						`started ${age(sub.startedAt, now)} ago`,
						sub.conversationTitle,
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

export function SubagentStop({ sub }: { sub: SubagentRow }) {
	const [pending, setPending] = useState(false);
	const label = `Stop ${sub.name}`;
	return (
		<button
			type="button"
			className="sub-stop"
			title={label}
			aria-label={label}
			disabled={pending}
			onClick={async () => {
				setPending(true);
				try {
					const result = await api.stop(sub.id);
					if (result.result === "interrupted")
						showToast(`Stopped ${sub.name}'s turn`);
					else if (result.result === "not-running")
						showToast(`${sub.name} is idle`);
					else showToast(result.detail ?? `Could not stop ${sub.name}`, "warn");
				} catch (error) {
					if (!(error instanceof ProveCancelled))
						showToast(
							error instanceof Error ? error.message : String(error),
							"warn",
						);
				} finally {
					setPending(false);
				}
			}}
		>
			<SquareIcon size={15} aria-hidden="true" />
		</button>
	);
}

export default SubagentView;
