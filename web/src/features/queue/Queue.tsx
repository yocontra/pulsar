/**
 * The queue strip above the composer (slot `composer.top`): messages to
 * this agent that are not in its conversation yet, from the operator and
 * from other agents, with why each one waits and what can be done:
 * Cancel (withdraw), Send now, Edit (the operator's own). Desktop and phone
 * share it; the phone starts folded.
 */
import {
	ChevronDownIcon,
	ChevronRightIcon,
	LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, ProveCancelled } from "../../api/client.ts";
import type {
	QueueActResult,
	QueueItem,
	QueueList,
	QueueState,
} from "../../api/types.ts";
import { useNow } from "../../data/clock.ts";
import { useLive } from "../../data/hooks.ts";
import { keys } from "../../data/keys.ts";
import type { LiveDef } from "../../data/queries.ts";
import { queryClient } from "../../data/runtime.ts";
import { ago } from "../../lib/format.ts";
import type { ComposerSlotProps } from "../../lib/registry.tsx";
import { toast } from "../../lib/toast.ts";
import "./queue.css";

export const STATE_LABEL: Record<QueueState, string> = {
	idle: "Waiting for idle",
	"next-turn": "Next turn",
	held: "Held",
	retrying: "Retrying",
	offline: "Machine offline",
	sending: "Sending",
};

type Action = "withdraw" | "promote" | "edit";

const queueDef = (agentId: string): LiveDef<QueueList> => ({
	queryKey: keys.queue(agentId),
	queryFn: () => api.queue(agentId),
	poll: 5000,
});

/**
 * Runs one action. The operator's own message: as a send. Anyone else's:
 * Prove Human here, or the home node's own passkey check for exactly this
 * action and message (`api.acting`).
 */
async function run(
	item: QueueItem,
	action: Action,
	body?: string,
): Promise<QueueActResult> {
	const extra = body !== undefined ? { body } : {};
	if (item.mine || action === "edit")
		return api.queueAct(item.agentId, item.messageId, action, extra);
	const op = action === "withdraw" ? "queue.withdraw" : "queue.promote";
	// Waiting in this node's outbox: the check is this node's.
	const target = item.where === "outbox" ? {} : { agent: item.agentId };
	return api.acting(op, target, { messageId: item.messageId }, (assertion) =>
		api.queueAct(item.agentId, item.messageId, action, {
			...(assertion !== undefined ? { assertion } : {}),
		}),
	);
}

function errorText(e: unknown): string {
	if (e instanceof ApiError) return e.message;
	return e instanceof Error ? e.message : String(e);
}

/** The strip; nothing at all for a composer that writes to many agents or an empty queue. */
export function QueueStrip(p: ComposerSlotProps) {
	if (p.target.kind !== "agent") return null;
	return <Strip agentId={p.target.agent.id} compact={p.compact} />;
}

function Strip({ agentId, compact }: { agentId: string; compact: boolean }) {
	const q = useLive(queueDef(agentId));
	const [open, setOpen] = useState(!compact);
	const items = q.data?.items ?? [];
	if (items.length === 0 && !q.data?.partial) return null;
	const first = items[0];
	return (
		<section
			className="q-strip"
			aria-label="Queued messages"
			data-testid="queue-strip"
		>
			<button
				type="button"
				className="q-head"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
			>
				{open ? (
					<ChevronDownIcon aria-hidden="true" />
				) : (
					<ChevronRightIcon aria-hidden="true" />
				)}
				<span className="q-title">Queued ({items.length})</span>
				{!open && first && (
					<span className="q-peek">
						{STATE_LABEL[first.state]} · {first.body}
					</span>
				)}
			</button>
			{open && (
				<ul className="q-list">
					{items.map((i) => (
						<Row key={i.messageId} item={i} />
					))}
				</ul>
			)}
			{open && q.data?.partial && (
				<p className="q-note" role="note">
					{q.data.partial}
				</p>
			)}
		</section>
	);
}

function Row({ item }: { item: QueueItem }) {
	const now = useNow();
	const [busy, setBusy] = useState<Action | null>(null);
	const [draft, setDraft] = useState<string | null>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (draft !== null) area.current?.focus();
	}, [draft !== null]);

	const act = async (action: Action, body?: string) => {
		setBusy(action);
		try {
			const r = await run(item, action, body);
			if (action === "withdraw") toast("Message withdrawn");
			else if (action === "edit") {
				setDraft(null);
				toast("Message updated");
			} else if (r.receipt && r.receipt.state === "queued")
				toast("Couldn't send it now", {
					tone: "warning",
					description: r.receipt.detail ?? undefined,
				});
			else toast("Sent now");
		} catch (e) {
			if (!(e instanceof ProveCancelled))
				toast("That didn't work", { tone: "error", description: errorText(e) });
		} finally {
			setBusy(null);
			void queryClient.invalidateQueries({
				queryKey: keys.queue(item.agentId),
			});
		}
	};

	const button = (
		action: Action,
		label: string,
		enabled: boolean,
		why: string | undefined,
		onClick: () => void,
	) =>
		busy === action ? (
			<span className="q-progress" role="status">
				<LoaderCircleIcon className="q-spin" aria-hidden="true" />
				{action === "withdraw"
					? "Cancelling"
					: action === "promote"
						? "Sending"
						: "Saving"}
			</span>
		) : (
			<span className="q-tip" title={enabled ? undefined : why}>
				<button
					type="button"
					className={`q-btn${action === "withdraw" ? " is-danger" : ""}`}
					disabled={!enabled || busy !== null}
					aria-label={`${label}: ${item.body.slice(0, 40)}`}
					onClick={onClick}
				>
					{label}
				</button>
			</span>
		);

	return (
		<li className="q-row" data-state={item.state}>
			<div className="q-meta">
				<span className="q-from">{item.from.name}</span>
				<span className={`q-chip is-${item.state}`} title={item.detail ?? ""}>
					{STATE_LABEL[item.state]}
					{item.state === "retrying" && item.attempt > 1
						? ` (try ${item.attempt})`
						: ""}
				</span>
				{item.priority !== "normal" && (
					<span className="q-prio">
						{item.priority === "urgent" ? "Urgent" : "Don't wake"}
					</span>
				)}
				<span className="q-age">{ago(item.createdAt, now)}</span>
			</div>
			{draft === null ? (
				<p className="q-body">{item.body}</p>
			) : (
				// Inside the composer's own form: no nested <form>.
				<div className="q-edit">
					<textarea
						ref={area}
						className="q-area"
						aria-label="Edit message"
						value={draft}
						rows={3}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") setDraft(null);
							if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								if (draft.trim()) void act("edit", draft);
							}
						}}
					/>
					<div className="q-actions">
						{busy === "edit" ? (
							<span className="q-progress" role="status">
								<LoaderCircleIcon className="q-spin" aria-hidden="true" />
								Saving
							</span>
						) : (
							<>
								<button
									type="button"
									className="q-btn"
									onClick={() => setDraft(null)}
								>
									Don't save
								</button>
								<button
									type="button"
									className="q-btn is-primary"
									disabled={!draft.trim() || draft.trim() === item.body}
									onClick={() => void act("edit", draft)}
								>
									Save
								</button>
							</>
						)}
					</div>
				</div>
			)}
			{draft === null && (
				<div className="q-actions">
					{button(
						"promote",
						"Send now",
						item.canPromote,
						item.why.promote,
						() => void act("promote"),
					)}
					{item.mine &&
						button("edit", "Edit", item.canEdit, item.why.edit, () =>
							setDraft(item.body),
						)}
					{button(
						"withdraw",
						"Cancel",
						item.canWithdraw,
						item.why.withdraw,
						() => void act("withdraw"),
					)}
				</div>
			)}
		</li>
	);
}
