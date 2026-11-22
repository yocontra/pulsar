/**
 * The composer's mic (lib/registry.tsx slot `composer.left`): dictation
 * into the draft with the browser's own recognizer (dictation.ts). Tap to
 * start, tap again to stop; Esc puts the draft back; typing or sending keeps
 * what is there and stops.
 */
import { MicIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ComposerSlotProps } from "../../lib/registry.tsx";
import { toast } from "../../lib/toast.ts";
import {
	Dictation,
	type DictationState,
	type DraftField,
	recognitionCtor,
} from "./dictation.ts";
import "./voice.css";

/** The draft's textarea as dictation's field (React sees an input event). */
function fieldOf(ta: HTMLTextAreaElement | null): DraftField | null {
	if (!ta) return null;
	return {
		get value() {
			return ta.value;
		},
		get selectionStart() {
			return ta.selectionStart;
		},
		get selectionEnd() {
			return ta.selectionEnd;
		},
		replace(value, caret) {
			ta.setRangeText(value, 0, ta.value.length);
			ta.setSelectionRange(caret, caret);
			ta.dispatchEvent(new Event("input", { bubbles: true }));
		},
	};
}

const clock = (ms: number) => {
	const s = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Keys that don't change the text: they don't end dictation. */
const QUIET_KEYS = new Set([
	"Shift",
	"Control",
	"Alt",
	"Meta",
	"CapsLock",
	"Tab",
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
]);

export function MicButton(p: ComposerSlotProps) {
	const Ctor = recognitionCtor(window);
	const [state, setState] = useState<DictationState>("idle");
	const [now, setNow] = useState(0);
	const dictation = useRef<Dictation | null>(null);
	const ta = p.textarea;

	if (Ctor && !dictation.current)
		dictation.current = new Dictation(
			Ctor,
			() => fieldOf(ta.current),
			{
				state: setState,
				error: ({ message, description }) =>
					void toast(message, { tone: "error", description }),
			},
			navigator.language,
		);

	// Leaving the composer keeps the words and stops listening.
	useEffect(() => () => dictation.current?.commit(), []);

	const active = state !== "idle";
	useEffect(() => {
		if (!active) return;
		const d = dictation.current!;
		setNow(Date.now());
		const tick = setInterval(() => setNow(Date.now()), 1000);
		const el = ta.current;
		// Esc anywhere cancels (before a layer or the page takes it).
		const esc = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.isComposing) return;
			e.preventDefault();
			e.stopPropagation();
			d.cancel();
			ta.current?.focus();
		};
		const typed = (e: KeyboardEvent) => {
			if (e.key !== "Escape" && !QUIET_KEYS.has(e.key)) d.commit();
		};
		const sent = () => d.commit();
		window.addEventListener("keydown", esc, true);
		el?.addEventListener("keydown", typed);
		el?.form?.addEventListener("submit", sent, true);
		return () => {
			clearInterval(tick);
			window.removeEventListener("keydown", esc, true);
			el?.removeEventListener("keydown", typed);
			el?.form?.removeEventListener("submit", sent, true);
		};
	}, [active, ta]);

	if (!Ctor) return null;
	const d = dictation.current!;
	const toggle = () => {
		if (d.state === "listening") d.stop();
		// Still waiting for the last words: a second tap keeps what's there.
		else if (d.state === "finishing") d.commit();
		else {
			// The words go where the caret is (the end when the field isn't focused).
			const el = ta.current;
			if (el && document.activeElement !== el)
				el.setSelectionRange(el.value.length, el.value.length);
			d.start();
		}
	};
	const label =
		state === "listening"
			? "Stop dictation"
			: state === "finishing"
				? "Finish dictation now"
				: "Dictate";
	return (
		<button
			type="button"
			className={`${p.compact ? "m-prio-btn" : "att-btn"} mic-btn`}
			data-state={state}
			aria-label={label}
			aria-pressed={active}
			title={p.busy && !active ? "Sending…" : label}
			disabled={p.busy && !active}
			// Keep the caret (and the phone's keyboard) where it is.
			onMouseDown={(e) => e.preventDefault()}
			onClick={toggle}
		>
			<MicIcon aria-hidden="true" />
			{active && (
				<span className="mic-time" role="status">
					{clock(now - d.startedAt)}
				</span>
			)}
		</button>
	);
}
