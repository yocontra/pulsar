import { ScanFaceIcon } from "lucide-react";
import { Fragment, lazy, Suspense, useId, useState } from "react";
import type { ApprovalDecision, AttentionItem } from "../api/types.ts";
import { Shield } from "../components/icons.tsx";
import { can } from "../lib/store.ts";
import { ApprovalDetails, Exact } from "./ApprovalDetails.tsx";
import { faceIdLabel, useAsksFaceId } from "./faceid.ts";
import { OutcomeLine } from "./OutcomeLine.tsx";
import {
	ElsewhereNote,
	MobileOutcome,
	MobileSheetHead,
	usePromptCard,
} from "./promptCard.tsx";

// Questions, plans and host dialogs: their own card (web/src/interactions/).
const InteractionCard = lazy(
	() => import("../interactions/InteractionCard.tsx"),
);

/** Why "Allow for session" is off: the harness offered no rule to remember. */
const NO_RULE =
	"The agent offers no session rule for this prompt, so it can only be allowed once.";

interface CardProps {
	item: AttentionItem;
	mobile: boolean;
	autofocus?: boolean;
	/** In the conversation: the card layout on both platforms (no sheet). */
	inline?: boolean;
}

/** A relayed prompt: the permission card, or the interaction card for its kind. */
export default function ApprovalCard(props: CardProps) {
	const ap = props.item.approval!;
	if (ap.readOnly || ((ap.kind ?? "permission") !== "permission" && ap.prompt))
		return (
			<Suspense fallback={<div className="d-approval-loading" />}>
				<InteractionCard key={ap.requestId} {...props} />
			</Suspense>
		);
	return <PermissionCard key={ap.requestId} {...props} />;
}

function PermissionCard({ item, mobile, autofocus, inline }: CardProps) {
	const ap = item.approval!;
	const a = item.agent;
	const [note, setNote] = useState("");
	const [denying, setDenying] = useState(false);
	const { sup, phase, outcome, error, elsewhere, s, ref, sign, pending } =
		usePromptCard(ap, autofocus);
	const label = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
	const decide = (decision: ApprovalDecision) =>
		sign(decision, decision === "deny" && note ? { note } : {}, "Decided");

	const expired = s === 0 && !outcome;
	const canSession = Boolean(ap.sessionRules?.length);
	const noRuleId = useId();
	const asks = useAsksFaceId(ap);
	const canApprove = sup === "platform";
	const busy = phase !== "idle";
	// In the conversation, an answered card collapses to its outcome line.
	if (inline && outcome) return <OutcomeLine outcome={outcome} />;
	if (mobile && !inline) {
		const denied = outcome ? /^Denied|deny/i.test(outcome) : false;
		return (
			<article
				ref={ref}
				className="approval-card mobile m-approval"
				aria-label={`Approval: ${a.name} wants to run ${ap.tool}`}
			>
				<MobileSheetHead
					title="Approval"
					s={s}
					label={label}
					outcome={outcome}
					expired={expired}
				/>
				<div className="m-sheet-scroll m-ap-body">
					<ApprovalDetails
						approval={ap}
						agent={a}
						variant="phone"
						showRules={canSession && !outcome}
					/>
				</div>
				<footer className="m-ap-actions">
					{outcome ? (
						<MobileOutcome outcome={outcome} denied={denied} />
					) : expired ? (
						<p className="m-ap-note">
							This request expired. The agent's own prompt decides now.
						</p>
					) : !can("approvals") ? (
						<p className="m-ap-note" role="note">
							Read only: this Pulsar can't approve from the app yet. Answer on{" "}
							{a.machine}'s screen.
						</p>
					) : (
						<>
							{sup && !canApprove && (
								<p className="m-ap-note warn" role="note">
									{sup === "unsupported"
										? "This browser doesn't support passkeys, so it can't approve."
										: "This device has no Face ID / Touch ID, so it can't approve."}{" "}
									Approve from your phone or a Mac with Touch ID.
								</p>
							)}
							{busy && (
								<p className="passkey-step m-faceid" role="status">
									<ScanFaceIcon className="size-8" />
									{phase === "prove"
										? "Prove you're human to answer…"
										: phase === "send"
											? pending
											: "Confirm with Face ID"}
								</p>
							)}
							{denying ? (
								<div className="deny-note m-deny">
									<textarea
										rows={2}
										value={note}
										aria-label="Note for the agent"
										placeholder="Tell the agent why (optional)"
										onChange={(e) => setNote(e.target.value)}
									/>
									<div className="m-ap-row">
										<button
											type="button"
											className="m-btn gray"
											onClick={() => setDenying(false)}
										>
											Cancel
										</button>
										<button
											type="button"
											className="m-btn danger filled"
											disabled={busy}
											onClick={() => decide("deny")}
										>
											{asks && <ScanFaceIcon className="size-5 faceid-mark" />}{" "}
											Deny
										</button>
									</div>
								</div>
							) : (
								<>
									<button
										type="button"
										className="m-btn wide m-allow"
										disabled={!canApprove || busy}
										onClick={() => decide("allow-once")}
										aria-label={faceIdLabel("Allow once", asks)}
									>
										{asks && <ScanFaceIcon className="size-5 faceid-mark" />}{" "}
										Allow Once
									</button>
									<div className="m-ap-row">
										<button
											type="button"
											className="m-btn tinted"
											disabled={!canApprove || !canSession || busy}
											onClick={() => decide("allow-session")}
											aria-describedby={canSession ? undefined : noRuleId}
										>
											{canSession ? "Allow for Session" : "No Session Rule"}
										</button>
										<button
											type="button"
											className="m-btn danger"
											disabled={!canApprove || busy}
											onClick={() => setDenying(true)}
											aria-label="Deny + note…"
										>
											Deny…
										</button>
									</div>
									{!canSession && (
										<p className="m-ap-note" id={noRuleId}>
											{NO_RULE}
										</p>
									)}
								</>
							)}
							{elsewhere && (
								<ElsewhereNote machine={ap.machine} className="warn" />
							)}
							{error && (
								<p className="error m-ap-note" role="alert">
									{error}
								</p>
							)}
						</>
					)}
				</footer>
			</article>
		);
	}
	return (
		<article
			ref={ref}
			className={`approval-card${mobile ? " phone" : ""}`}
			aria-label={`Approval: ${a.name} wants to run ${ap.tool}`}
		>
			<header>
				<Shield size={16} />
				<strong>Approval</strong>
				<span
					className={`countdown${s < 30 ? " soon" : ""}`}
					role="timer"
					aria-label={`Expires in ${label}`}
				>
					{outcome ? "" : expired ? "Expired" : `Expires ${label}`}
				</span>
			</header>
			<ApprovalDetails
				approval={ap}
				agent={a}
				variant="desktop"
				showRules={false}
			/>
			{outcome ? (
				<p className="outcome" role="status">
					{outcome}
				</p>
			) : expired ? (
				<p className="muted">
					This request expired. The agent's own prompt decides now.
				</p>
			) : !can("approvals") ? (
				<p className="muted" role="note">
					Read only: this Pulsar can't approve from the app yet. Answer on{" "}
					{a.machine}'s screen.
				</p>
			) : (
				<>
					{sup && !canApprove && (
						<p className="warn" role="note">
							{sup === "unsupported"
								? "This browser doesn't support passkeys, so it can't approve."
								: "This device has no Face ID / Touch ID, so it can't approve."}{" "}
							Approve from your phone or a Mac with Touch ID.
						</p>
					)}
					{busy && (
						<p className="passkey-step" role="status">
							<span className="spinner" aria-hidden="true" />{" "}
							{phase === "prove"
								? "Prove you're human to answer…"
								: phase === "send"
									? pending
									: "Confirm with Face ID / Touch ID…"}
						</p>
					)}
					<div className="approval-actions">
						<button
							type="button"
							className="btn primary wide"
							disabled={!canApprove || busy}
							onClick={() => decide("allow-once")}
						>
							{faceIdLabel("Allow once", asks)}
						</button>
						<div className="row2">
							<button
								type="button"
								className="btn"
								disabled={!canApprove || !canSession || busy}
								title={
									canSession
										? `Adds for this session: ${ap.sessionRules!.join(", ")}`
										: undefined
								}
								aria-describedby={canSession ? undefined : noRuleId}
								onClick={() => decide("allow-session")}
							>
								{canSession ? "Allow for session" : "No session rule"}
							</button>
							<button
								type="button"
								className="btn danger-outline"
								disabled={!canApprove || busy}
								onClick={() => setDenying(!denying)}
							>
								Deny + note…
							</button>
						</div>
						{canSession ? (
							<p className="muted mono small session-rules">
								For session:{" "}
								{ap.sessionRules!.map((r, i) => (
									<Fragment key={i}>
										{i ? ", " : ""}
										<Exact value={r} />
									</Fragment>
								))}
							</p>
						) : (
							<p className="muted small" id={noRuleId}>
								{NO_RULE}
							</p>
						)}
						{denying && (
							<div className="deny-note">
								<textarea
									rows={2}
									value={note}
									aria-label="Note for the agent"
									placeholder="Tell the agent why (optional)"
									onChange={(e) => setNote(e.target.value)}
								/>
								<button
									type="button"
									className="btn danger"
									disabled={busy}
									onClick={() => decide("deny")}
								>
									{faceIdLabel("Deny", asks)}
								</button>
							</div>
						)}
					</div>
					{elsewhere && <ElsewhereNote machine={ap.machine} className="warn" />}
					{error && (
						<p className="error" role="alert">
							{error}
						</p>
					)}
				</>
			)}
		</article>
	);
}
