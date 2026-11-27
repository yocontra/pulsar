import { ArrowUpIcon, PlusIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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
	ComposerDraft,
	directDraftKey,
	openComposers,
	showsStop,
} from "../lib/composer-draft.ts";
import {
	ComposerActionsProvider,
	useComposerActions,
} from "../lib/composer-menu.tsx";
import { num, plural, RECEIPT_WORDS, sentence } from "../lib/format.ts";
import { useInFlight } from "../lib/inflight.ts";
import { lazy } from "../lib/lazy.tsx";
import { type ComposerSlotProps, Slot } from "../lib/registry.tsx";
import { navigate } from "../lib/router.ts";
import { observer } from "../lib/signals.ts";
import { commandLine } from "../lib/slash.ts";
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
import { Kbd, withKeys } from "./ui/kbd.tsx";

/**
 * A paste is the browser's own here. (PromptInput would take a clipboard
 * file as a hidden attachment and drop the text that came with it, as
 * Excel, Numbers and Word copy both.) Images and very long text become
 * attachments in the attach feature (features/composer), which listens on
 * the text field itself.
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

export const PRIORITY_HINT: Record<Priority, string> = {
	urgent:
		"Requests mid-turn delivery where supported. Other sessions queue the message.",
	normal:
		"Queues for the next turn. Wakes an idle session if it supports push.",
	fyi: "Waits in the inbox without waking the session.",
};

const PRIORITIES: { value: Priority; label: string; hint: string }[] = [
	{ value: "urgent", label: "Send now", hint: PRIORITY_HINT.urgent },
	{
		value: "normal",
		label: "Next turn",
		hint: PRIORITY_HINT.normal,
	},
	{ value: "fyi", label: "Don't wake", hint: PRIORITY_HINT.fyi },
];

function choicesFor(steer?: boolean) {
	return steer === false
		? PRIORITIES.map((p) =>
				p.value === "urgent"
					? {
							...p,
							label: "Urgent",
							hint: "This session controls when it reads urgent messages.",
						}
					: p,
			)
		: PRIORITIES;
}

function PriorityPickerImpl({
	choices = PRIORITIES,
	value,
	onChange,
}: {
	choices?: typeof PRIORITIES;
	value: Priority;
	onChange: (p: Priority) => void;
}) {
	return (
		<div className="seg d-seg" role="radiogroup" aria-label="Priority">
			{choices.map((p) => (
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
	describedBy?: string;
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
	describedBy,
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
	const [actions, actionsApi] = useComposerActions();
	const [phase, setPhase] = useState<
		"idle" | "checking" | "confirm" | "sending"
	>("idle");
	// Prove Human, when the send asks for it, sits on top with its own X.
	useInFlight(inSheet && phase === "sending" && !proveAsk.value);
	const [dry, setDry] = useState<SendResult | null>(null);
	const [drift, setDrift] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** The command that just ran in the agent's session (a note under the box). */
	const [ran, setRan] = useState<{ command: string; detail?: string } | null>(
		null,
	);
	/** The send that failed (same client id), for Retry. */
	const [failed, setFailed] = useState<SendRequest | null>(null);
	const [last, setLast] = useState<{
		id: string;
		req: SendRequest;
		total: number;
	} | null>(null);
	const ta = useRef<HTMLTextAreaElement>(null);
	const pending = useRef({ body: "", revision: "" });
	const legacyKey = targetKey(target);
	const key =
		target.kind === "selector"
			? legacyKey
			: directDraftKey(targetRequest(target).ids, viaParent);
	const draft = useMemo(
		() => new ComposerDraft(key, target.kind === "ids" ? null : legacyKey),
		[key, legacyKey, target.kind],
	);
	const active = useRef<ComposerDraft | null>(null);
	useEffect(() => {
		const field = ta.current;
		if (!field) return;
		const sync = () => {
			draft.text = field.value;
			setHasText(!!field.value.trim());
			draft.checkpoint();
		};
		const open = {
			draft,
			field: () => field,
			text: () => field.value,
			persistent: target.kind !== "selector",
			accept: (revision: string) => {
				if (draft.checkpoint().revision !== revision) return;
				field.value = "";
				draft.text = "";
				draft.clear();
				field.dispatchEvent(new Event("input", { bubbles: true }));
			},
		};
		active.current = draft;
		openComposers.set(key, open);
		field.value = draft.text;
		field.addEventListener("input", sync);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		const unwatch = draft.watch(() => draft.checkpoint());
		return () => {
			field.removeEventListener("input", sync);
			unwatch();
			if (active.current === draft) active.current = null;
			if (openComposers.get(key) === open) openComposers.delete(key);
			draft.clear();
		};
	}, [draft, key, target.kind]);

	const accept = (revision: string) => {
		openComposers.get(key)?.accept(revision);
		draft.accept(revision);
	};

	useEffect(() => {
		setPhase("idle");
		setDry(null);
		setLast(null);
		setError(null);
		setFailed(null);
		setRan(null);
		setPriority(defaultPriority);
	}, [key]);
	useEffect(() => {
		if (autofocus) ta.current?.focus();
	}, [key, autofocus]);

	const everyone = target.kind === "selector" && target.selector.trim() === "*";
	const base = (): SendRequest => ({
		...targetRequest(target),
		body: pending.current.body,
		priority,
		expectReply,
		...(viaParent ? { viaParent: true } : {}),
	});

	/**
	 * Sends (or retries `again` with its client id). In the open session the
	 * message shows at once as a sending bubble (data/mutations.ts) and a
	 * failure stays on that bubble with
	 * Retry. Anything else (several recipients, a subagent's parent) shows
	 * "Sending…" here, and a failure an error with Retry.
	 */
	const doSend = async (token?: string, again?: SendRequest) => {
		const attempt = pending.current;
		const { revision } = attempt;
		if (!again && draft.checkpoint().revision !== revision) {
			setPhase("idle");
			setDry(null);
			setError("The draft changed. Check the recipients again.");
			return;
		}
		setPhase("sending");
		setError(null);
		setFailed(null);
		const request = again ?? { ...base(), resolveToken: token };
		const data = await import("../data/index.ts");
		const req = {
			...request,
			clientId: request.clientId ?? data.newClientId(),
		};
		const p = data.sendMessage({
			req,
			settledDraft: () => accept(revision),
			...(target.kind === "agent" ? { agentId: target.agent.id } : {}),
		});
		const shown = data.localSend(data.localId(req.clientId!)) !== null;
		if (shown && active.current === draft) {
			const field = ta.current;
			if (field && draft.checkpoint().revision === revision) {
				field.value = "";
				draft.detach();
				draft.clear();
				field.dispatchEvent(new Event("input", { bubbles: true }));
			}
			setPhase("idle");
		}

		try {
			const r = await p;
			if (active.current !== draft || pending.current !== attempt) return;
			if (r.drift || r.reconfirm) {
				setDry(r);
				setDrift(true);
				setPhase("confirm");
				return;
			}
			setPhase("idle");
			setDry(null);
			setDrift(false);
			setLast({ id: r.messageId!, req, total: r.total });
			onSent?.(r, req);
		} catch (err) {
			if (active.current !== draft || pending.current !== attempt) return;
			setPhase("idle");
			if (err instanceof ProveCancelled && shown) {
				const field = ta.current;
				if (field && !field.value && !draft.files.peek().length) {
					draft.restoreDetached();
					field.value = draft.text;
					field.dispatchEvent(new Event("input", { bubbles: true }));
				}
				return;
			}
			if (err instanceof ProveCancelled || shown) return;
			setError(err instanceof ApiError ? err.message : "Send failed");
			setFailed(req);
		}
	};

	/**
	 * A `/name args` line to one agent runs in its session (typed into its
	 * terminal or through its harness's API): an acting op, so Prove Human
	 * first. The daemon chooses the delivery method for the command.
	 */
	const runSlash = async (line: string, fromDraft: boolean) => {
		if (target.kind !== "agent" || phase !== "idle") return;
		setError(null);
		setFailed(null);
		setRan(null);
		const { revision } = draft.checkpoint();
		setPhase("sending");
		try {
			const r = await api.runCommand(target.agent.id, line);
			if (r.result === "ok" && fromDraft) accept(revision);
			if (active.current !== draft) return;
			setPhase("idle");
			if (r.result === "ok") {
				setRan({ command: line.split(" ")[0]!, detail: r.detail });
				return;
			}
			setError(`${line.split(" ")[0]} didn't run: ${r.detail ?? r.result}`);
		} catch (err) {
			if (active.current !== draft) return;
			setPhase("idle");
			if (err instanceof ProveCancelled) return;
			setError(err instanceof ApiError ? err.message : "Couldn't run it");
		}
	};

	const start = async (text: string) => {
		if (!text.trim() && !draft.ready().length) return;
		if (draft.blocked() || phase !== "idle" || !ta.current) return;
		const line =
			target.kind === "agent" &&
			!draft.asText.value &&
			!draft.files.value.length
				? commandLine(text)
				: null;
		if (line && target.kind === "agent") return runSlash(line, true);
		setRan(null);
		// The files went to the agent's machine already: the message names them.
		pending.current = {
			body: draft.body(text),
			revision: draft.checkpoint().revision,
		};
		// One recipient (an agent, a subagent): no confirmation to show.
		if (
			target.kind === "agent" ||
			(target.kind === "ids" && target.ids.length === 1)
		)
			return doSend();
		setPhase("checking");
		try {
			const r = await api.send({ ...base(), dryRun: true });
			if (active.current !== draft) return;
			setDry(r);
			setDrift(false);
			const tier = tierFor(r.total, r.machines, everyone);
			if (r.total === 0) {
				setError("No agents match.");
				setPhase("idle");
			} else if (tier === "direct") await doSend(r.resolveToken);
			else setPhase("confirm");
		} catch (err) {
			if (active.current !== draft) return;
			setError(
				err instanceof ApiError ? err.message : "Couldn't check the recipients",
			);
			setPhase("idle");
		}
	};

	const cancel = () => {
		setPhase("idle");
		setDry(null);
	};

	const tier = dry ? confirmTier(dry, drift, everyone) : null;
	const status: ChatStatus =
		phase === "checking" || phase === "sending"
			? "submitted"
			: error
				? "error"
				: "ready";

	// What the toolbar slots (lib/registry.tsx) get.
	const slot: ComposerSlotProps = {
		runCommand: (line) => void runSlash(line, false),
		target,
		compact,
		busy: phase === "checking" || phase === "sending",
		hasText,
		textarea: ta,
		draft,
	};
	const blocked = draft.blocked();
	const canSend =
		(hasText || draft.ready().length > 0) && !blocked && phase === "idle";
	// The agent works and the draft is empty: Stop (composer.right) replaces Send.
	const stopMode = showsStop(
		target.kind === "agent" ? target.agent : null,
		hasText,
		draft,
	);
	const busyRecipient =
		target.kind === "agent" && target.agent.status === "busy"
			? target.agent
			: null;
	const choices = choicesFor(busyRecipient?.capabilities?.steer);
	const showTiming =
		!!busyRecipient &&
		(busyRecipient.capabilities?.steer ?? busyRecipient.reach === "push");
	const form = compact ? (
		<ComposerActionsProvider value={actionsApi}>
			<Slot name="composer.top" {...slot} />
			<PromptInput
				keepTextOnSubmit
				onSubmit={(msg) => void start(msg.text)}
				className="prompt m-prompt"
			>
				<ComposerPlus
					actions={actions}
					priorities={choices}
					hidePriorities={showTiming}
					priority={priority}
					onPriority={setPriority}
					expectReply={expectReply}
					onExpectReply={setExpectReply}
				/>
				{/* Attach and commands: their entries go in the + menu; what
				    outlives it (file inputs, the sheet) stays mounted here. */}
				<Slot name="composer.left" {...slot} />
				<PromptInputBody>
					<PromptInputTextarea
						ref={ta}
						className="composer-input"
						placeholder={placeholder ?? "Message"}
						aria-label="Message"
						aria-describedby={describedBy}
						enterKeyHint="send"
						onPaste={pasteText}
					/>
				</PromptInputBody>
				<Slot name="composer.right" {...slot} />
				{!stopMode && (
					<PromptInputSubmit
						className="send-btn m-send"
						status={status}
						aria-label="Send"
						title={blocked ?? "Send"}
						disabled={!canSend}
					>
						{status === "ready" || status === "error" ? (
							<ArrowUpIcon className="size-[18px]" strokeWidth={2.6} />
						) : undefined}
					</PromptInputSubmit>
				)}
				<Slot name="composer.end" {...slot} />
			</PromptInput>
		</ComposerActionsProvider>
	) : null;

	return (
		<div className={`composer${compact ? " m-composer" : ""}`}>
			{compact && showTiming && (
				<PriorityPicker
					value={priority}
					onChange={setPriority}
					choices={choices}
				/>
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
				</div>
			)}
			{!compact && (
				<PromptInput
					keepTextOnSubmit
					onSubmit={(msg) => void start(msg.text)}
					className="prompt"
				>
					<Slot name="composer.top" {...slot} />
					<PromptInputBody>
						<PromptInputTextarea
							ref={ta}
							className="composer-input"
							placeholder={placeholder ?? "Message…"}
							aria-label="Message"
							aria-describedby={describedBy}
							onPaste={pasteText}
						/>
					</PromptInputBody>
					<PromptInputFooter className="composer-bar">
						<PromptInputTools className="composer-tools">
							<Slot name="composer.left" {...slot} />
							<PriorityPicker
								value={priority}
								onChange={setPriority}
								choices={choices}
							/>
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
						<Slot name="composer.right" {...slot} />
						{!stopMode && (
							<PromptInputSubmit
								className="send-btn"
								status={status}
								aria-label="Send"
								title={blocked ?? withKeys("Send", ["mod", "enter"])}
								disabled={!canSend}
							>
								{status === "ready" || status === "error" ? (
									<ArrowUpIcon className="size-4" strokeWidth={2.6} />
								) : undefined}
							</PromptInputSubmit>
						)}
					</PromptInputFooter>
				</PromptInput>
			)}
			{phase !== "idle" && phase !== "confirm" && (
				<p className="muted small" role="status">
					{phase === "checking" ? "Checking recipients…" : "Sending…"}
				</p>
			)}
			{ran && !error && (
				<p className="composer-ran" role="status">
					{ran.detail || (
						<>
							Ran <code>{ran.command}</code> in{" "}
							{target.kind === "agent" ? target.agent.name : "the agent"}
							{"'"}s session
						</>
					)}
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
								onClick={() => void doSend(undefined, failed)}
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
	"withdrawn",
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
		(row.state === "queued" ||
			row.state === "sent" ||
			row.state === "nacked") &&
		row.detail
			? sentence(row.detail)
			: RECEIPT_WORDS[row.state];
	return <span className={`rstate r-${row.state}`}>{word}</span>;
}

export const PriorityPicker = observer(PriorityPickerImpl);
/** The phone's + button and menu (a phone-only chunk: Konsta's Menu). */
const ComposerPlus = lazy(
	() => import("../mobile/ComposerPlus.tsx"),
	() => (
		<div className="m-prio">
			<button
				type="button"
				className="m-prio-btn m-plus"
				aria-label="Message options"
				disabled
			>
				<PlusIcon className="size-5" strokeWidth={2.4} />
			</button>
		</div>
	),
);
export const Composer = observer(ComposerImpl);
export const WakeSummary = observer(WakeSummaryImpl);
export const ConfirmDialog = observer(ConfirmDialogImpl);
export const Receipts = observer(ReceiptsImpl);
const ReceiptWords = observer(ReceiptWordsImpl);
