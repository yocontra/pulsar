/**
 * What the permission card and the interaction card share: the passkey
 * signing flow with its states, and the pieces of the phone sheet that look
 * the same for both.
 */
import { CircleCheckIcon, CircleXIcon, TimerIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ApiError, ProveCancelled } from "../api/client.ts";
import type {
	Approval,
	ApprovalDecision,
	InteractionAnswer,
} from "../api/types.ts";
import { CloseX } from "../components/CloseX.tsx";
import { useInFlight } from "../lib/inflight.ts";
import { back } from "../lib/router.ts";
import { approvals } from "../lib/store.ts";
import { proveHuman } from "../prove/state.ts";
import { machineUrl } from "./machine.ts";
import {
	NeedsProof,
	RemoteNeedsProof,
	type Support,
	signAndDecide,
	support,
} from "./passkey.ts";

/** Seconds left until `until`, ticking once a second. */
function useSecondsLeft(until: number) {
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, []);
	return Math.max(0, Math.round((until - now) / 1000));
}

/**
 * One relayed prompt's card state: passkey support, the signing phase, the
 * outcome (also when another device or the agent's own screen answers
 * first) and the seconds left. `sign` signs one answer with the passkey and
 * sends it; `done` names the outcome when the daemon reports none.
 */
export function usePromptCard(ap: Approval, autofocus: boolean | undefined) {
	const [sup, setSup] = useState<Support | null>(null);
	const [phase, setPhase] = useState<"idle" | "prove" | "sign" | "send">(
		"idle",
	);
	// Closing the card mid-ceremony would drop the answer. ("prove" waits on
	// Prove Human, which sits on top with its own X.)
	useInFlight(phase === "sign" || phase === "send");
	const [outcome, setOutcome] = useState<string | null>(ap.outcome ?? null);
	/** The answer being sent, for "Allowing…" / "Denying…" / "Answering…". */
	const [deciding, setDeciding] = useState<ApprovalDecision | null>(null);
	const [error, setError] = useState<string | null>(null);
	/** The prompt is on a machine that doesn't know this device yet. */
	const [elsewhere, setElsewhere] = useState(false);
	const s = useSecondsLeft(ap.expiresAt);
	const ref = useRef<HTMLElement>(null);

	useEffect(() => {
		support().then(setSup);
	}, []);
	useEffect(() => {
		const sync = () => {
			const live = approvals.peek().get(ap.requestId)?.approval;
			if (live?.outcome && live.state !== "pending") setOutcome(live.outcome);
		};
		sync();
		return approvals.subscribe(sync);
	}, [ap.requestId]);
	useEffect(() => {
		if (ap.outcome) setOutcome(ap.outcome);
	}, [ap.outcome]);
	useEffect(() => {
		if (autofocus) ref.current?.scrollIntoView({ block: "center" });
	}, [autofocus]);

	const sign = async (
		decision: ApprovalDecision,
		extra: { note?: string; answer?: InteractionAnswer },
		done: string,
		proved = false,
	): Promise<void> => {
		setError(null);
		setDeciding(decision);
		// "sign" shows only when a passkey check really runs (another machine's prompt).
		// Never optimistic: the first answer wins, so the card says "Allowing…"
		// until the daemon says who won (data/mutations.ts decideConfirmed).
		setPhase("send");
		try {
			const { decide } = await import("../data/index.ts");
			const res = await decide(
				{
					requestId: ap.requestId,
					decision,
					...extra,
					card: ap,
					onStep: setPhase,
				},
				signAndDecide,
			);
			setOutcome(
				res.won
					? (res.approval.outcome ?? done)
					: `Already answered: ${res.approval.outcome ?? `${done.toLowerCase()} elsewhere`}`,
			);
		} catch (err) {
			if (err instanceof RemoteNeedsProof) {
				setElsewhere(true);
				setPhase("idle");
				return;
			}
			if (err instanceof NeedsProof && !proved) {
				// No passkey here yet: Prove Human makes one, then this answer goes on.
				setPhase("prove");
				const r = await proveHuman("approve");
				setPhase("idle");
				if (r === "proven") return sign(decision, extra, done, true);
				setError("Not proven, so nothing was sent.");
				return;
			}
			if (err instanceof ProveCancelled) {
				setError("Not proven, so nothing was sent.");
				setPhase("idle");
				return;
			}
			if (err instanceof ApiError) {
				const already = (err.body as { approval?: { outcome?: string } } | null)
					?.approval?.outcome;
				if (already) setOutcome(`Already answered: ${already}`);
				else setError(err.message);
			} else if (proved)
				// Some browsers need a fresh tap for a second Face ID in a row.
				setError("You're proven. Tap your answer again to sign it.");
			else if (err instanceof Error && err.name !== "NotAllowedError")
				setError(err.message);
			else setError("Face ID / Touch ID was cancelled.");
		}
		setPhase("idle");
	};

	const pending =
		deciding === "deny"
			? "Denying…"
			: deciding === "answer"
				? "Answering…"
				: deciding
					? "Allowing…"
					: "Sending…";
	return { sup, phase, outcome, error, elsewhere, s, ref, sign, pending };
}

/** The phone sheet's header: the countdown, the title and Close. */
export function MobileSheetHead({
	title,
	s,
	label,
	outcome,
	expired,
}: {
	title: string;
	s: number;
	label: string;
	outcome: string | null;
	expired: boolean;
}) {
	return (
		<header className="m-sheet-head">
			<span
				className={`countdown m-countdown${s < 30 ? " soon" : ""}${outcome ? " done" : ""}`}
				role="timer"
				aria-label={`Expires in ${label}`}
			>
				{outcome ? null : expired ? (
					"Expired"
				) : (
					<>
						<TimerIcon className="size-3.5" /> {label}
					</>
				)}
			</span>
			<h2>{title}</h2>
			<CloseX onClick={() => back()} />
		</header>
	);
}

/** The phone sheet's answered state: the outcome (the X closes it). */
export function MobileOutcome({
	outcome,
	denied,
}: {
	outcome: string;
	denied: boolean;
}) {
	return (
		<div className={`m-outcome${denied ? " denied" : ""}`} role="status">
			{denied ? (
				<CircleXIcon className="size-9" />
			) : (
				<CircleCheckIcon className="size-9" />
			)}
			<p className="outcome">{outcome}</p>
		</div>
	);
}

/** The prompt is another machine's: where to prove first. */
export function ElsewhereNote({
	machine,
	className,
}: {
	machine: string;
	className: string;
}) {
	const url = machineUrl(machine);
	return (
		<p className={className} role="alert">
			This prompt is on {machine}, which doesn't know this device yet.{" "}
			{url ? (
				<a href={url} target="_blank" rel="noreferrer">
					Prove you're human on {machine}
				</a>
			) : (
				`Open Pulsar on ${machine} and prove you're human there`
			)}
			, then answer here.
		</p>
	);
}
