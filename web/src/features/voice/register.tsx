/**
 * Dictation in the composer (voice.tsx, a lazy chunk). Only where the
 * browser has a speech recognizer: elsewhere there is no mic at all.
 */
import { lazy } from "../../lib/lazy.tsx";
import { registerSlot } from "../../lib/registry.tsx";

// The same check as dictation.ts recognitionCtor, without loading it here.
if (
	typeof window !== "undefined" &&
	("SpeechRecognition" in window || "webkitSpeechRecognition" in window)
)
	registerSlot("composer.left", {
		id: "composer.voice",
		order: -5,
		component: lazy(
			() => import("./voice.tsx").then((m) => ({ default: m.MicButton })),
			() => <></>,
		),
	});
