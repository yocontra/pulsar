import { MessageCircleQuestionIcon, ScanFaceIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AttentionItem, InteractionAnswer } from "../api/types.ts";
import { ApprovalDetails, WhereLine } from "../approval/ApprovalDetails.tsx";
import { OutcomeLine } from "../approval/OutcomeLine.tsx";
import {
	ElsewhereNote,
	MobileOutcome,
	MobileSheetHead,
	usePromptCard,
} from "../approval/promptCard.tsx";
import { can } from "../lib/store.ts";
import { interactionTitle, rendererFor } from "./registry.ts";

/** "m:ss", or "h:mm:ss" from an hour up. */
function clock(s: number) {
	const m = Math.floor(s / 60);
	return m >= 60
		? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
		: `${m}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * An interaction that is not a permission prompt (question, plan, confirm,
 * select, input): the harness's renderer for its body, inside one shell
 * that signs the answer with the passkey (a proven human answers), shows
 * the countdown and, once answered anywhere, the outcome. Phone: the Ionic
 * sheet's layout; desktop: a dialog or inline card.
 */
export default function InteractionCard({
	item,
	mobile,
	autofocus,
	inline,
}: {
	item: AttentionItem;
	mobile: boolean;
	autofocus?: boolean;
	/** In the conversation: the card layout on both platforms (no sheet). */
	inline?: boolean;
}) {
	const ap = item.approval!;
	const prompt = ap.prompt ?? null;
	/** Shown only: the harness takes the answer on its own screen (Codex). */
	const readOnly = ap.readOnly === true;
	const a = item.agent;
	const { sup, phase, outcome, error, elsewhere, s, ref, sign, pending } =
		usePromptCard(ap, autofocus);
	const label = clock(s);
	const submit = (answer: InteractionAnswer) =>
		sign("answer", { answer }, "Answered");

	const expired = s === 0 && !outcome;
	const canAnswer = sup === "platform";
	const busy = phase !== "idle";
	const title = interactionTitle(a.harness, ap);
	const Renderer = prompt ? rendererFor(a.harness, prompt) : null;
	const declined = outcome ? /^(Declined|Keep|Denied)/i.test(outcome) : false;

	let body: ReactNode = null;
	if (!outcome && readOnly)
		body = (
			<>
				<p className={mobile ? "m-ap-note" : "warn"} role="note">
					Waiting for an answer in the terminal on {a.machine}. {a.harness}{" "}
					takes this answer only there.
				</p>
				{Renderer && prompt ? (
					<Renderer
						approval={ap}
						prompt={prompt}
						agent={a}
						mobile={mobile}
						disabled
						submit={() => {}}
					/>
				) : (
					<ApprovalDetails
						approval={ap}
						agent={a}
						variant={mobile ? "phone" : "desktop"}
						showRules={false}
					/>
				)}
			</>
		);
	else if (!outcome && !expired && can("approvals") && Renderer && prompt)
		body = (
			<Renderer
				approval={ap}
				prompt={prompt}
				agent={a}
				mobile={mobile}
				disabled={!canAnswer || busy}
				submit={(answer) => void submit(answer)}
			/>
		);

	const status = (
		<>
			{outcome ? (
				mobile ? (
					<MobileOutcome outcome={outcome} denied={declined} />
				) : (
					<p className="outcome" role="status">
						{outcome}
					</p>
				)
			) : expired ? (
				<p className={mobile ? "m-ap-note" : "muted"}>
					This expired here. Answer on {a.machine}'s screen.
				</p>
			) : !can("approvals") ? (
				<p className={mobile ? "m-ap-note" : "muted"} role="note">
					Read only: this Pulsar can't answer from the app yet. Answer on{" "}
					{a.machine}'s screen.
				</p>
			) : null}
			{!outcome && !expired && !readOnly && sup && !canAnswer && (
				<p className={mobile ? "m-ap-note warn" : "warn"} role="note">
					{sup === "unsupported"
						? "This browser doesn't support passkeys, so it can't answer."
						: "This device has no Face ID / Touch ID, so it can't answer."}{" "}
					Answer from your phone or a Mac with Touch ID.
				</p>
			)}
			{busy && (
				<p className={`passkey-step${mobile ? " m-faceid" : ""}`} role="status">
					{mobile ? (
						<ScanFaceIcon className="size-8" />
					) : (
						<span className="spinner" aria-hidden="true" />
					)}{" "}
					{phase === "prove"
						? "Prove you're human first…"
						: phase === "send"
							? pending
							: "Confirm with Face ID / Touch ID…"}
				</p>
			)}
			{elsewhere && !outcome && (
				<ElsewhereNote
					machine={ap.machine}
					className={mobile ? "m-ap-note warn" : "warn"}
				/>
			)}
			{error && (
				<p className={`error${mobile ? " m-ap-note" : ""}`} role="alert">
					{error}
				</p>
			)}
		</>
	);

	const who = (
		<div className="ix-who">
			<p className="ix-who-name">
				<strong>{a.name}</strong> on {a.machine}
			</p>
			<WhereLine project={a.project} cwd={ap.cwd} branch={ap.branch} />
		</div>
	);

	// In the conversation, an answered card collapses to its outcome line.
	if (inline && outcome) return <OutcomeLine outcome={outcome} />;
	if (mobile && !inline)
		return (
			<article
				ref={ref}
				className="approval-card mobile m-approval interaction-card"
				data-kind={prompt?.kind ?? ap.kind}
				aria-label={`${title}: ${a.name}`}
			>
				<MobileSheetHead
					title={title}
					s={s}
					label={label}
					outcome={outcome}
					expired={expired}
				/>
				<div className="m-sheet-scroll m-ap-body">
					{who}
					{body}
				</div>
				<footer className="m-ap-actions">{status}</footer>
			</article>
		);

	return (
		<article
			ref={ref}
			className={`approval-card interaction-card${mobile ? " phone" : ""}`}
			data-kind={prompt?.kind ?? ap.kind}
			aria-label={`${title}: ${a.name}`}
		>
			<header>
				<MessageCircleQuestionIcon size={16} />
				<strong>{title}</strong>
				<span
					className={`countdown${s < 30 ? " soon" : ""}`}
					role="timer"
					aria-label={`Expires in ${label}`}
				>
					{outcome ? "" : expired ? "Expired" : `Expires ${label}`}
				</span>
			</header>
			{who}
			{body}
			{status}
		</article>
	);
}
