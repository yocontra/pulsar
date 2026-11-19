import {
	ArrowUpIcon,
	CheckIcon,
	CornerDownRightIcon,
	MoonIcon,
	ZapIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, api, ProveCancelled } from "../api/client.ts";
import type {
	AgentRow,
	Priority,
	ReceiptRow,
	ReceiptState,
	ReceiptsPage,
	SendRequest,
	SendResult,
	Wake,
} from "../api/types.ts";
import type { ChatStatus } from "../lib/ai-types.ts";
import {
	num,
	plural,
	RECEIPT_WORDS,
	sentence,
	WAKE_LABEL,
	wakeFor,
} from "../lib/format.ts";
import { useInFlight } from "../lib/inflight.ts";
import { navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { onReceipts, watchReceipts } from "../lib/store.ts";
import { proveAsk } from "../prove/state.ts";
import {
	PromptInput,
	PromptInputBody,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
} from "./ai-elements/prompt-input.tsx";
import { Layer } from "./desktop/Layer.tsx";
import { Kbd } from "./ui/kbd.tsx";

/**
 * The composer sends text only: a paste is the browser's own. (PromptInput
 * would take a clipboard file as a hidden attachment and drop the text that
 * came with it, as Excel, Numbers and Word copy both.)
 */
const pasteText = () => {};

export type Target =
	| { kind: "agent"; agent: AgentRow }
	| { kind: "selector"; selector: string; label: string }
	| { kind: "ids"; ids: string[]; label: string };

/**
 * Who a composer writes to: a change drops the dry run and errors. Callers
 * also key each composer by its agent or node, so a draft or a late send
 * result never carries over to the next one.
 */
function targetKey(t: Target): string {
	if (t.kind === "agent") return `agent:${t.agent.id}`;
	if (t.kind === "ids") return `ids:${t.ids.join(",")}`;
	return `selector:${t.selector}`;
}

export function targetRequest(t: Target): Pick<SendRequest, "to" | "ids"> {
	if (t.kind === "agent") return { ids: [t.agent.id] };
	if (t.kind === "ids") return { ids: t.ids };
	return { to: t.selector };
}

const PRIORITIES: { value: Priority; label: string; hint: string }[] = [
	{ value: "urgent", label: "Interrupt now", hint: "Lands mid-turn" },
	{
		value: "normal",
		label: "Next turn",
		hint: "Arrives on the next turn; wakes an idle agent",
	},
	{ value: "fyi", label: "Don't wake", hint: "Waits in the inbox" },
];

function PriorityPickerImpl({
	value,
	onChange,
}: {
	value: Priority;
	onChange: (p: Priority) => void;
}) {
	return (
		<div className="seg d-seg" role="radiogroup" aria-label="Priority">
			{PRIORITIES.map((p) => (
				<button
					type="button"
					key={p.value}
					role="radio"
					aria-checked={value === p.value}
					className={value === p.value ? "on" : ""}
					title={p.hint}
					onClick={() => onChange(p.value)}
				>
					{p.label}
				</button>
			))}
		</div>
	);
}

const PRIORITY_ICON = {
	urgent: ZapIcon,
	normal: CornerDownRightIcon,
	fyi: MoonIcon,
} as const;

/**
 * Phone: priority and expect-reply behind one round button, as an iOS
 * pull-down menu (the composer row stays one line).
 */
function PriorityMenuImpl({
	value,
	onChange,
	expectReply,
	onExpectReply,
}: {
	value: Priority;
	onChange: (p: Priority) => void;
	expectReply: boolean;
	onExpectReply: (v: boolean) => void;
}) {
	const [open, setOpen] = useState(false);
	const Icon = PRIORITY_ICON[value];
	const current = PRIORITIES.find((p) => p.value === value)!;
	return (
		<div className="m-prio">
			<button
				type="button"
				className={`m-prio-btn p-${value}`}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={`Priority: ${current.label}${expectReply ? ", expect reply" : ""}`}
				onClick={() => setOpen(!open)}
			>
				<Icon className="size-[18px]" strokeWidth={2.2} />
				{expectReply && <span className="m-prio-dot" aria-hidden="true" />}
			</button>
			{open && (
				<>
					<div
						className="m-menu-shade"
						onClick={() => setOpen(false)}
						aria-hidden="true"
					/>
					<div className="m-menu" role="menu" aria-label="Priority">
						{PRIORITIES.map((p) => {
							const I = PRIORITY_ICON[p.value];
							return (
								<button
									type="button"
									key={p.value}
									role="menuitemradio"
									aria-checked={value === p.value}
									className="m-menu-item"
									onClick={() => {
										onChange(p.value);
										setOpen(false);
									}}
								>
									<span className="m-menu-check">
										{value === p.value && <CheckIcon className="size-4" />}
									</span>
									<span className="m-menu-text">
										{p.label}
										<small>{p.hint}</small>
									</span>
									<I className="size-[18px]" />
								</button>
							);
						})}
						<div className="m-menu-sep" />
						<button
							type="button"
							role="menuitemcheckbox"
							aria-checked={expectReply}
							className="m-menu-item"
							onClick={() => {
								onExpectReply(!expectReply);
								setOpen(false);
							}}
						>
							<span className="m-menu-check">
								{expectReply && <CheckIcon className="size-4" />}
							</span>
							<span className="m-menu-text">
								Expect a reply
								<small>Track who answers</small>
							</span>
						</button>
					</div>
				</>
			)}
		</div>
	);
}

/**
 * Send that was already confirmed by the operator (retry failed, message
 * non-repliers): when the daemon answers 409 `confirm`, resend with its token.
 * A new send, so it drops the first send's client id (the daemon answers a
 * repeated id with the first result and delivers nothing).
 */
export async function sendConfirmed(
	req: SendRequest,
	send: (r: SendRequest) => Promise<SendResult> = (r) => api.send(r),
): Promise<SendResult> {
	const { clientId: _first, ...fresh } = req;
	const r = await send(fresh);
	if (r.reconfirm === "confirm" && r.resolveToken)
		return send({ ...fresh, resolveToken: r.resolveToken });
	return r;
}

/** Why the daemon asked to confirm again (a 409 from /send). */
export function reconfirmText(r: SendResult) {
	if (r.reconfirm === "stale_token")
		return `The confirmation expired. Check the recipients again: ${plural(r.total, "agent")}.`;
	if (r.reconfirm === "confirm")
		return `The daemon wants a confirmation for ${plural(r.total, "agent")}.`;
	return `The recipients changed by more than 5% since you checked: now ${plural(r.total, "agent")}.`;
}

export type Tier = "direct" | "inline" | "dialog";
/**
 * Confirmation tiers: one recipient sends at once, a few on one machine
 * confirm inline, anything wider (everyone, 250+) in the dialog with the
 * breakdown. One click: no type-the-count friction.
 */
export function tierFor(
	total: number,
	machines: number,
	everyone: boolean,
): Tier {
	if (everyone || total >= 250) return "dialog";
	if (total <= 1) return "direct";
	if (total <= 25 && machines <= 1) return "inline";
	return "dialog";
}

/**
 * The confirmation a dry run (or a 409 from /send) shows. A reconfirm
 * always asks, even for one recipient: the text is out of the box, and
 * without a confirmation it would be lost unsent.
 */
export function confirmTier(
	dry: SendResult,
	drift: boolean,
	everyone: boolean,
): Tier {
	const tier = tierFor(dry.total, dry.machines, everyone);
	return drift && tier === "direct" ? "inline" : tier;
}

interface ComposerProps {
	target: Target;
	defaultPriority?: Priority;
	placeholder?: string;
	/** Header line ("To: apparish-auth @ studio"). */
	showTo?: boolean;
	onSent?: (r: SendResult, req: SendRequest) => void;
	autofocus?: boolean;
	/** Keep the receipts of the last send under the composer. */
	inlineReceipts?: boolean;
	/** Phone: one row (priority menu, text field, round send button). */
	compact?: boolean;
	/** In a sheet: a send in flight keeps the sheet from closing. */
	inSheet?: boolean;
	/**
	 * A subagent that can't take messages: the send goes to its parent,
	 * naming it (`SendRequest.viaParent`).
	 */
	viaParent?: boolean;
	/**
	 * The conversation shows our sent bubble (a live transcript): the bubble
	 * carries Delivered / Read / Replied, and the composer only failures.
	 */
	bubbleReceipts?: boolean;
}

function ComposerImpl({
	target,
	defaultPriority = "normal",
	placeholder,
	showTo = true,
	onSent,
	autofocus,
	inlineReceipts = true,
	compact = false,
	inSheet = false,
	viaParent = false,
	bubbleReceipts = false,
}: ComposerProps) {
	const [hasText, setHasText] = useState(false);
	const [priority, setPriority] = useState<Priority>(defaultPriority);
	const [expectReply, setExpectReply] = useState(false);
	const [phase, setPhase] = useState<
		"idle" | "checking" | "confirm" | "sending"
	>("idle");
	// Prove Human, when the send asks for it, sits on top with its own X.
	useInFlight(inSheet && phase === "sending" && !proveAsk.value);
	const [dry, setDry] = useState<SendResult | null>(null);
	const [drift, setDrift] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The send that failed (same client id), for Retry. */
	const [failed, setFailed] = useState<SendRequest | null>(null);
	const [last, setLast] = useState<{
		id: string;
		req: SendRequest;
		total: number;
	} | null>(null);
	const ta = useRef<HTMLTextAreaElement>(null);
	/** The text being sent; PromptInput clears its form on submit. */
	const pendingBody = useRef("");
	const key = targetKey(target);

	useEffect(() => {
		setPhase("idle");
		setDry(null);
		setLast(null);
		setError(null);
		setFailed(null);
		setPriority(defaultPriority);
	}, [key]);
	useEffect(() => {
		if (autofocus) ta.current?.focus();
	}, [key, autofocus]);

	const everyone = target.kind === "selector" && target.selector.trim() === "*";
	const base = (): SendRequest => ({
		...targetRequest(target),
		body: pendingBody.current.trim(),
		priority,
		expectReply,
		...(viaParent ? { viaParent: true } : {}),
	});

	/** Put unsent text back in the box (after a failure or a cancel). */
	const restore = () => {
		if (ta.current && !ta.current.value) {
			ta.current.value = pendingBody.current;
			setHasText(!!pendingBody.current.trim());
		}
	};

	/**
	 * Sends (or retries `again` with its client id). In the open session the
	 * message shows at once as a sending bubble (data/mutations.ts) and the
	 * box is free for the next one; a failure stays on that bubble with
	 * Retry. Anything else (several recipients, a subagent's parent) shows
	 * "Sending…" here, and a failure an error with Retry.
	 */
	const doSend = async (token?: string, again?: SendRequest) => {
		setError(null);
		setFailed(null);
		const data = await import("../data/index.ts");
		const req: SendRequest = again ?? {
			...base(),
			resolveToken: token,
			clientId: data.newClientId(),
		};
		const body = req.body ?? "";
		const p = data.sendMessage({
			req,
			...(target.kind === "agent" ? { agentId: target.agent.id } : {}),
		});
		const shown = data.localSend(data.localId(req.clientId!)) !== null;
		if (shown) {
			pendingBody.current = "";
			setDry(null);
			setPhase("idle");
		} else setPhase("sending");
		try {
			const r = await p;
			if (r.drift) {
				pendingBody.current = body;
				setDry(r);
				setDrift(true);
				setPhase("confirm");
				return;
			}
			setLast({ id: r.messageId!, req, total: r.total });
			// The data layer notes it as sent here (lib/sent.ts), retries too.
			if (!shown) {
				pendingBody.current = "";
				setDry(null);
				setPhase("idle");
			}
			setDrift(false);
			onSent?.(r, req);
		} catch (err) {
			if (!shown) setPhase("idle");
			pendingBody.current = body;
			if (err instanceof ProveCancelled) {
				restore();
				return;
			}
			// The bubble says it failed and offers Retry.
			if (shown) return;
			setError(err instanceof ApiError ? err.message : "Send failed");
			setFailed(req);
			restore();
		}
	};

	const start = async (text: string) => {
		if (!text.trim() || phase === "sending" || phase === "checking") return;
		pendingBody.current = text;
		setHasText(false);
		// One recipient (an agent, a subagent): no confirmation to show.
		if (
			target.kind === "agent" ||
			(target.kind === "ids" && target.ids.length === 1)
		)
			return doSend();
		setPhase("checking");
		try {
			const r = await api.send({ ...base(), dryRun: true });
			setDry(r);
			setDrift(false);
			const tier = tierFor(r.total, r.machines, everyone);
			if (r.total === 0) {
				setError("No agents match.");
				setPhase("idle");
				restore();
			} else if (tier === "direct") await doSend(r.resolveToken);
			else setPhase("confirm");
		} catch (err) {
			setError(
				err instanceof ApiError ? err.message : "Couldn't check the recipients",
			);
			setPhase("idle");
			restore();
		}
	};

	const cancel = () => {
		setPhase("idle");
		restore();
	};

	const tier = dry ? confirmTier(dry, drift, everyone) : null;
	const agentWake =
		target.kind === "agent" ? wakeFor(target.agent, priority) : null;
	const status: ChatStatus =
		phase === "checking" || phase === "sending"
			? "submitted"
			: error
				? "error"
				: "ready";

	const form = compact ? (
		<PromptInput
			onSubmit={(msg) => void start(msg.text)}
			className="prompt m-prompt"
		>
			<PriorityMenu
				value={priority}
				onChange={setPriority}
				expectReply={expectReply}
				onExpectReply={setExpectReply}
			/>
			<PromptInputBody>
				<PromptInputTextarea
					ref={ta}
					className="composer-input"
					placeholder={placeholder ?? "Message"}
					aria-label="Message"
					enterKeyHint="send"
					onChange={(e) => setHasText(!!e.currentTarget.value.trim())}
					onPaste={pasteText}
				/>
			</PromptInputBody>
			<PromptInputSubmit
				className="send-btn m-send"
				status={status}
				aria-label="Send"
				disabled={!hasText || phase === "sending" || phase === "checking"}
			>
				{status === "ready" || status === "error" ? (
					<ArrowUpIcon className="size-[18px]" strokeWidth={2.6} />
				) : undefined}
			</PromptInputSubmit>
		</PromptInput>
	) : null;

	return (
		<div className={`composer${compact ? " m-composer" : ""}`}>
			{compact && agentWake && agentWake !== "wakes" && (
				<p className={`m-wake-note w-${agentWake}`}>
					{agentWake === "queued"
						? `${target.kind === "agent" ? target.agent.machine : ""} is offline: this waits until it's back`
						: `Won't wake it: ${WAKE_LABEL[agentWake]}`}
				</p>
			)}
			{form}
			{!compact && showTo && (
				<div className="composer-to">
					<span className="muted">To</span>{" "}
					<span className="composer-to-who">
						{target.kind === "agent"
							? `${target.agent.name} on ${target.agent.machine}`
							: target.label}
					</span>
					{agentWake && (
						<span className={`wake-note w-${agentWake}`}>
							{agentWake === "wakes"
								? "Wakes it if idle"
								: agentWake === "queued"
									? `Waits: ${target.kind === "agent" ? target.agent.machine : ""} is offline`
									: `Won't wake it (${WAKE_LABEL[agentWake]})`}
						</span>
					)}
				</div>
			)}
			{!compact && (
				<PromptInput
					onSubmit={(msg) => void start(msg.text)}
					className="prompt"
				>
					<PromptInputBody>
						<PromptInputTextarea
							ref={ta}
							className="composer-input"
							placeholder={placeholder ?? "Message…"}
							aria-label="Message"
							onChange={(e) => setHasText(!!e.currentTarget.value.trim())}
							onPaste={pasteText}
						/>
					</PromptInputBody>
					<PromptInputFooter className="composer-bar">
						<PromptInputTools className="composer-tools">
							<PriorityPicker value={priority} onChange={setPriority} />
							<label className="check d-toggle">
								<input
									type="checkbox"
									className="d-check"
									checked={expectReply}
									onChange={(e) => setExpectReply(e.currentTarget.checked)}
								/>
								Expect a reply
							</label>
						</PromptInputTools>
						<span className="composer-hint hide-mobile">
							<Kbd keys={["mod", "enter"]} /> Send
						</span>
						<PromptInputSubmit
							className="send-btn"
							status={status}
							aria-label="Send"
							disabled={!hasText || phase === "sending" || phase === "checking"}
						/>
					</PromptInputFooter>
				</PromptInput>
			)}
			{phase !== "idle" && phase !== "confirm" && (
				<p className="muted small" role="status">
					{phase === "checking" ? "Checking recipients…" : "Sending…"}
				</p>
			)}
			{error && (
				<p className="error" role="alert">
					{error}
					{failed && (
						<>
							{" "}
							<button
								type="button"
								className="link"
								onClick={() => {
									// The box holds the same text; Retry sends it once.
									if (ta.current) ta.current.value = "";
									setHasText(false);
									void doSend(undefined, failed);
								}}
							>
								Retry
							</button>
						</>
					)}
				</p>
			)}
			{phase === "confirm" && dry && tier === "inline" && (
				<div
					className="confirm-inline"
					role="alertdialog"
					aria-label="Confirm send"
				>
					{drift && <p className="warn">{reconfirmText(dry)}</p>}
					<span>
						Send to {plural(dry.total, "agent")} on {dry.breakdown[0]?.machine}?
					</span>
					<WakeSummary counts={dry.counts} />
					<button
						type="button"
						className="btn primary"
						onClick={() => doSend(dry.resolveToken)}
					>
						Confirm send to {num(dry.total)}
					</button>
					<button type="button" className="btn" onClick={cancel}>
						Cancel
					</button>
				</div>
			)}
			{phase === "confirm" && dry && tier === "dialog" && (
				<ConfirmDialog
					result={dry}
					drift={drift}
					everyone={everyone}
					onCancel={cancel}
					onConfirm={() => doSend(dry.resolveToken)}
				/>
			)}
			{inlineReceipts && last && (
				<Receipts
					messageId={last.id}
					total={last.total}
					expectReply={last.req.expectReply ?? false}
					// One agent: its bubble shows Delivered / Read / Replied
					// (session/DeliveryNote.tsx); here only a failure, with Retry.
					// (No live transcript means no bubble: the line stays.)
					failuresOnly={bubbleReceipts}
					onResend={(ids) =>
						sendConfirmed({
							...last.req,
							to: undefined,
							ids,
							resolveToken: undefined,
						}).then(
							(r) =>
								r.messageId &&
								setLast({
									id: r.messageId,
									req: { ...last.req, ids },
									total: r.total,
								}),
						)
					}
				/>
			)}
		</div>
	);
}

function WakeSummaryImpl({
	counts,
}: {
	counts: Partial<Record<Wake | ReceiptState, number>>;
}) {
	const order: Wake[] = ["wakes", "inbox-only", "held", "refuses", "queued"];
	const words: Record<Wake, string> = {
		wakes: "wake now",
		"inbox-only": "to inbox",
		held: "held",
		refuses: "refuse",
		queued: "queued",
	};
	const parts = order
		.filter((k) => counts[k])
		.map((k) => `${num(counts[k]!)} ${words[k]}`);
	if (!parts.length) return null;
	return <span className="wake-summary">{parts.join(" · ")}</span>;
}

function ConfirmDialogImpl({
	result,
	drift,
	everyone,
	onCancel,
	onConfirm,
}: {
	result: SendResult;
	drift: boolean;
	everyone: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<Layer
			title="Confirm broadcast"
			hideTitle
			role="alertdialog"
			onClose={onCancel}
			className="d-confirm confirm-dialog"
			initialFocus={() => {}}
		>
			<div className="d-confirm-body">
				<h2>
					Send to {plural(result.total, "agent")} on{" "}
					{plural(result.machines, "machine")}?
				</h2>
				{drift && <p className="warn">{reconfirmText(result)}</p>}
				{everyone && <p className="warn">This is everyone in the pool.</p>}
				<p>
					<WakeSummary counts={result.counts} />
				</p>
				<table className="breakdown">
					<tbody>
						{result.breakdown.slice(0, 8).map((b) => (
							<tr key={b.machine}>
								<td>{b.machine}</td>
								<td className="num">{num(b.count)}</td>
							</tr>
						))}
						{result.breakdown.length > 8 && (
							<tr>
								<td className="muted">
									{plural(result.breakdown.length - 8, "more machine")}
								</td>
								<td className="num">
									{num(
										result.breakdown.slice(8).reduce((s, b) => s + b.count, 0),
									)}
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>
			<div className="d-pop-foot">
				<button type="button" className="d-btn" onClick={onCancel}>
					Cancel
				</button>
				<button type="button" className="d-btn primary" onClick={onConfirm}>
					Send to {num(result.total)}
				</button>
			</div>
		</Layer>
	);
}

const STATE_ORDER: ReceiptState[] = [
	"replied",
	"done",
	"acked",
	"read",
	"delivered",
	"sent",
	"queued",
	"held",
	"refused",
	"nacked",
	"failed",
	"expired",
	"dead",
];

/** Receipts in plain words, live from the stream. */
function ReceiptsImpl({
	messageId,
	total,
	expectReply,
	onResend,
	full = false,
	failuresOnly = false,
}: {
	messageId: string;
	total: number;
	expectReply: boolean;
	onResend?: (ids: string[]) => void;
	full?: boolean;
	/** Show nothing unless the send failed (the bubble carries the rest). */
	failuresOnly?: boolean;
}) {
	const [r, setR] = useState<ReceiptsPage | null>(null);
	useEffect(() => {
		let live = true;
		api
			.receipts(messageId)
			.then((x) => live && setR(x))
			.catch(() => {});
		const unwatch = watchReceipts(messageId);
		const off = onReceipts((x) => {
			if (x.message.id === messageId) setR(x);
		});
		return () => {
			live = false;
			unwatch();
			off();
		};
	}, [messageId]);

	const counts = r?.totals ?? { queued: total };
	const n = r?.total ?? total;
	const items = r?.items ?? [];
	const failed = items.filter((i) => i.state === "failed");
	const nonRepliers = items.filter((i) => i.state !== "replied");
	const replies = items.filter((i) => i.state === "replied" && i.reply);

	if (n === 1 && !full && failuresOnly) {
		const one = items[0];
		if (one?.state !== "failed" && one?.state !== "refused") return null;
		return (
			<p className="send-failed" role="alert">
				<span>Not delivered to {one.agentName}</span>
				{one.state === "failed" && onResend && (
					<button
						type="button"
						className="link"
						onClick={() => onResend([one.agentId])}
					>
						Retry
					</button>
				)}
			</p>
		);
	}
	if (n === 1 && !full) {
		const one = items[0];
		return (
			<p className="receipt-line" aria-live="polite">
				<span className="r-name">{one?.agentName ?? "…"}</span>:{" "}
				<ReceiptWords row={one} />
				{one?.reply && <span className="reply">“{one.reply}”</span>}
				{one?.state === "failed" && onResend && (
					<button
						type="button"
						className="link"
						onClick={() => onResend([one.agentId])}
					>
						Retry
					</button>
				)}
			</p>
		);
	}
	const delivered =
		(counts.delivered ?? 0) + (counts.read ?? 0) + (counts.replied ?? 0);
	const cantWake = (counts.held ?? 0) + (counts.refused ?? 0);
	const summary = [
		delivered && `${num(delivered)} delivered`,
		counts.sent && `${num(counts.sent)} handed over`,
		counts.queued && `${num(counts.queued)} waiting`,
		cantWake && `${num(cantWake)} can't be woken`,
		counts.failed && `${num(counts.failed)} failed`,
		expectReply && `${num(counts.replied ?? 0)} replied`,
	].filter(Boolean);
	return (
		<div className={`receipts${full ? " full" : ""}`} aria-live="polite">
			<div className="progress" role="img" aria-label={summary.join(", ")}>
				{STATE_ORDER.map((s) =>
					counts[s] ? (
						<span
							key={s}
							className={`seg-${s}`}
							style={{ width: `${(counts[s]! / Math.max(1, n)) * 100}%` }}
						/>
					) : null,
				)}
			</div>
			<p className="receipt-summary">{summary.join(" · ") || "Waiting…"}</p>
			<div className="receipt-actions">
				{failed.length > 0 && onResend && (
					<button
						type="button"
						className="btn small d-btn sm"
						onClick={() => onResend(failed.map((f) => f.agentId))}
					>
						Retry {num(failed.length)} failed
					</button>
				)}
				{expectReply && nonRepliers.length > 0 && r && (
					<button
						type="button"
						className="btn small d-btn sm"
						onClick={() =>
							navigate({ view: "ids", ids: nonRepliers.map((x) => x.agentId) })
						}
					>
						Message {num(nonRepliers.length)} non-repliers
					</button>
				)}
			</div>
			{replies.length > 0 && (
				<ul className="replies">
					{replies.slice(0, full ? 50 : 5).map((x) => (
						<li key={x.agentId}>
							<span className="r-name">{x.agentName}</span>{" "}
							<span className="muted r-machine">{x.machine}</span>
							<div className="reply">{x.reply}</div>
						</li>
					))}
				</ul>
			)}
			{full && (
				<ul className="receipt-rows">
					{items.slice(0, 100).map((x) => (
						<li key={x.agentId}>
							<span className="r-name">{x.agentName}</span>{" "}
							<span className="muted r-machine">{x.machine}</span>{" "}
							<ReceiptWords row={x} />
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

function ReceiptWordsImpl({ row }: { row?: ReceiptRow }) {
	if (!row) return <span className="muted">Waiting</span>;
	const word =
		(row.state === "queued" || row.state === "sent") && row.detail
			? sentence(row.detail)
			: RECEIPT_WORDS[row.state];
	return <span className={`rstate r-${row.state}`}>{word}</span>;
}

export const PriorityPicker = observer(PriorityPickerImpl);
const PriorityMenu = observer(PriorityMenuImpl);
export const Composer = observer(ComposerImpl);
export const WakeSummary = observer(WakeSummaryImpl);
export const ConfirmDialog = observer(ConfirmDialogImpl);
export const Receipts = observer(ReceiptsImpl);
const ReceiptWords = observer(ReceiptWordsImpl);
