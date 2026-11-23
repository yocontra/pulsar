/**
 * Dictation in the composer (voice.tsx, a lazy chunk). Only where the
 * browser has a speech recognizer: elsewhere there is no mic at all.
 */
import type { ComponentType } from "react";
import { lazy } from "../../lib/lazy.tsx";
import { type ComposerSlotProps, registerSlot } from "../../lib/registry.tsx";

const Mic = lazy<ComposerSlotProps>(
	() =>
		import("./voice.tsx").then((m) => ({
			default: m.MicButton as ComponentType<ComposerSlotProps>,
		})),
	() => <></>,
);

// The same check as dictation.ts recognitionCtor, without loading it here.
if (
	typeof window !== "undefined" &&
	("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
) {
	// Desktop: in the toolbar's left end. Phone: the row's right end, after Send
	// (attach and commands are in the + menu there).
	registerSlot("composer.left", {
		id: "composer.voice",
		order: -5,
		component: (p: ComposerSlotProps) => (p.compact ? null : <Mic {...p} />),
	});
	registerSlot("composer.end", {
		id: "composer.voice-phone",
		component: (p: ComposerSlotProps) => (p.compact ? <Mic {...p} /> : null),
	});
}
