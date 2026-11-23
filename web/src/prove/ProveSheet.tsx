/**
 * The Prove Human sheet. One check with the device's passkey (Face ID,
 * Touch ID, Windows Hello or the device PIN) proves the operator is a human
 * at a device signed in to their tailnet; then whatever asked for it
 * carries on. A device with a passkey here signs in with it; any other
 * device makes one right here.
 */
import { ScanFaceIcon, ShieldCheckIcon } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { api, hasSessionToken, setSessionToken } from "../api/client.ts";
import { hasPasskey, support } from "../approval/passkey.ts";
import { CloseX } from "../components/CloseX.tsx";
import { inFlight, useInFlight } from "../lib/inflight.ts";
import { observer } from "../lib/signals.ts";
import { hello, refreshAll } from "../lib/store.ts";
import { closeProve, type ProveReason, proveAsk } from "./state.ts";

const flow = () => import("./flow.ts");

const WHY: Record<ProveReason, string> = {
	approve: "To answer this prompt, prove you're human.",
	stop: "To stop an agent, prove you're human.",
	send: "Prove you're human and your message reaches agents as your own, tagged “human operator”, so they follow it.",
	notifications: "To turn on approval alerts, prove you're human.",
	remove: "To remove a device, prove you're human.",
	signout: "To sign out another device, prove you're human.",
	act: "To make changes on an agent's machine, prove you're human.",
	control:
		"To switch an agent's mode or run a command in its terminal, prove you're human.",
	manual:
		"Agents can't pass your device's passkey check. Proving you're human lets you approve prompts, stop agents and send as yourself.",
};

const HOW =
	"Your device's passkey: Face ID, Touch ID, Windows Hello, or your device PIN.";

function untilText(at: number) {
	return new Date(at).toLocaleString([], {
		dateStyle: "medium",
		timeStyle: "short",
	});
}

/** Tab and Shift+Tab cycle inside the phone's sheet (it is modal). */
function trapTab(e: React.KeyboardEvent, root: HTMLElement | null) {
	if (e.key !== "Tab" || !root) return;
	const all = [
		...root.querySelectorAll<HTMLElement>(
			"button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled])",
		),
	];
	const head = all[0];
	const tail = all.at(-1);
	if (!head || !tail) {
		e.preventDefault();
		return;
	}
	const at = document.activeElement;
	if (e.shiftKey && (at === head || at === root)) {
		e.preventDefault();
		tail.focus();
	} else if (!e.shiftKey && at === tail) {
		e.preventDefault();
		head.focus();
	}
}

function errorText(e: unknown): string {
	if (e instanceof Error && e.name === "NotAllowedError")
		return "The passkey check was cancelled.";
	return e instanceof Error ? e.message : "Something went wrong.";
}

function ProveSheetImpl({ mobile }: { mobile: boolean }) {
	const ask = proveAsk.value;
	const h = hello.value;
	const name = h?.you?.name ?? h?.you?.login ?? "you";
	const machine = h?.machine ?? "this machine";
	const [step, setStep] = useState<"start" | "busy" | "done">(
		hasSessionToken() && ask?.reason === "manual" ? "done" : "start",
	);
	const [error, setError] = useState<string | null>(null);
	const [noPasskeys, setNoPasskeys] = useState(false);
	const first = useRef<HTMLButtonElement>(null);
	const sheet = useRef<HTMLDivElement>(null);
	// A passkey ceremony in flight: the X, Esc and the backdrop wait for it.
	const busy = step === "busy";
	useInFlight(busy);

	const btn = (primary = false) =>
		mobile
			? `m-btn wide ${primary ? "" : "gray"}`
			: `d-btn ${primary ? "primary" : ""}`;

	useEffect(() => {
		support()
			.then((s) => setNoPasskeys(s !== "platform"))
			.catch(() => {});
	}, []);

	// The phone's sheet isn't a Radix dialog: focus and Esc by hand.
	useEffect(() => {
		if (!mobile) return;
		first.current?.focus();
		const esc = (e: KeyboardEvent) => {
			if (e.key === "Escape" && inFlight.peek() === 0) cancel();
		};
		addEventListener("keydown", esc);
		return () => removeEventListener("keydown", esc);
	}, []);
	// Proving removes the focused button: keep focus in the sheet.
	useEffect(() => {
		if (mobile && !sheet.current?.contains(document.activeElement))
			(first.current ?? sheet.current)?.focus();
	}, [step]);

	if (!ask) return null;

	function cancel() {
		closeProve(hasSessionToken() ? "proven" : "cancelled");
	}

	const finished = () => {
		void refreshAll();
		if (ask.reason === "manual") setStep("done");
		else closeProve("proven");
	};

	const run = async (fn: () => Promise<void>) => {
		setError(null);
		setStep("busy");
		try {
			await fn();
			finished();
		} catch (e) {
			setStep("start");
			setError(errorText(e));
		}
	};

	const prove = () =>
		run(async () => (await flow()).prove(h?.canSession === true));
	const signIn = () => run(async () => (await flow()).signIn());

	const signOut = async () => {
		const id = h?.session?.id;
		if (id) await api.revokeSession(id).catch(() => {});
		setSessionToken(null);
		void refreshAll();
		setStep("start");
	};

	const session = h?.session;
	let body: React.ReactNode;
	if (step === "done" || (hasSessionToken() && ask.reason === "manual")) {
		body = (
			<>
				<p className="prove-state ok" role="status">
					<ShieldCheckIcon className="size-5" /> Proven as {name}
				</p>
				<p className="prove-help">
					This device on {machine}
					{session ? ` · until ${untilText(session.expiresAt)}` : ""}. Your
					messages reach agents tagged “human operator - {name}”, and you can
					answer prompts and stop agents.
				</p>
				<div className="prove-actions">
					<button type="button" className={btn()} onClick={signOut}>
						Sign out this device
					</button>
				</div>
			</>
		);
	} else {
		body = (
			<>
				<p className="prove-lead">{WHY[ask.reason]}</p>
				<p className="prove-help muted">{HOW}</p>
				{noPasskeys && (
					<p className="prove-error" role="note">
						This browser can't use a device passkey. Use a browser with Face ID,
						Touch ID, Windows Hello or a device PIN set up.
					</p>
				)}
				{step === "busy" && (
					<p className="prove-help" role="status">
						<span className="spinner" aria-hidden="true" /> Waiting for your
						passkey…
					</p>
				)}
				{error && (
					<p className="prove-error" role="alert">
						{error}
					</p>
				)}
				<div className="prove-actions">
					{ask.allowSkip && (
						<button
							type="button"
							className={btn()}
							onClick={() => closeProve("skipped")}
						>
							Send without proving
						</button>
					)}
					<button
						ref={first}
						type="button"
						className={btn(true)}
						disabled={step === "busy"}
						onClick={prove}
					>
						<ScanFaceIcon className="size-4" /> Prove with passkey
					</button>
				</div>
				{!hasPasskey() && h?.canSession && (
					<button
						type="button"
						className="prove-link"
						disabled={step === "busy"}
						onClick={signIn}
					>
						I already have a passkey for {machine} on this device
					</button>
				)}
				{ask.allowSkip && (
					<p className="prove-help muted">
						Without proof, agents see your message as “not verified as your
						operator”.
					</p>
				)}
			</>
		);
	}

	const head = (title: React.ReactNode) => (
		<header className="prove-head">
			{/* No icon here: the proven state below carries the shield. */}
			{title}
		</header>
	);

	// Desktop: a Radix dialog, so it stacks over (and is usable above) the
	// approval, palette or confirm dialog that asked for it.
	if (!mobile)
		return (
			<Dialog.Root
				open
				onOpenChange={(open) => {
					if (!open && !busy) cancel();
				}}
			>
				<Dialog.Portal>
					<Dialog.Overlay className="prove-overlay" />
					<Dialog.Content
						className="prove-sheet prove-desktop"
						aria-describedby={undefined}
						onOpenAutoFocus={(e) => {
							e.preventDefault();
							// The proven state has no primary button: focus the sheet.
							(first.current ?? (e.currentTarget as HTMLElement)).focus();
						}}
					>
						{head(
							<Dialog.Title asChild>
								<h2>Prove Human</h2>
							</Dialog.Title>,
						)}
						{body}
						<Dialog.Close asChild>
							<CloseX />
						</Dialog.Close>
					</Dialog.Content>
				</Dialog.Portal>
			</Dialog.Root>
		);
	return (
		<div
			className="prove-backdrop mobile"
			data-backdrop
			onClick={(e) => {
				if (e.target === e.currentTarget && !busy) cancel();
			}}
		>
			<div
				ref={sheet}
				className="prove-sheet p-kit"
				role="dialog"
				aria-modal="true"
				aria-labelledby="prove-title"
				tabIndex={-1}
				onKeyDown={(e) => trapTab(e, sheet.current)}
			>
				{head(<h2 id="prove-title">Prove Human</h2>)}
				{body}
				<CloseX onClick={cancel} />
			</div>
		</div>
	);
}

export default observer(ProveSheetImpl);
