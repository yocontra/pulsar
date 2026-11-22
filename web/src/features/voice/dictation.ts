/**
 * Dictation into the composer's draft with the browser's own speech
 * recognizer (SpeechRecognition / webkitSpeechRecognition). No audio or text
 * goes to Pulsar: the browser hears the microphone and gives back words,
 * which land in the draft at the caret like typing.
 *
 * DOM-free so tests can drive it with a fake recognizer and field.
 */

/** The part of a SpeechRecognition result event used here. */
export interface RecognitionResultEvent {
	results: ArrayLike<ArrayLike<{ transcript: string }>>;
}

/** The part of SpeechRecognition used here. */
export interface Recognition {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	onresult: ((e: RecognitionResultEvent) => void) | null;
	onerror: ((e: { error: string }) => void) | null;
	onend: (() => void) | null;
	start(): void;
	stop(): void;
	abort(): void;
}

export type RecognitionCtor = new () => Recognition;

/** The browser's recognizer, or null where there is none (hide the mic). */
export function recognitionCtor(
	w: object = globalThis,
): RecognitionCtor | null {
	const g = w as {
		SpeechRecognition?: RecognitionCtor;
		webkitSpeechRecognition?: RecognitionCtor;
	};
	return g.SpeechRecognition ?? g.webkitSpeechRecognition ?? null;
}

/** The draft's text field. */
export interface DraftField {
	readonly value: string;
	readonly selectionStart: number;
	readonly selectionEnd: number;
	/** Set the whole text and put the caret at `caret`, as typing would. */
	replace(value: string, caret: number): void;
}

/** What the operator reads for a recognizer error (`null`: say nothing). */
export function errorText(
	code: string,
): { message: string; description?: string } | null {
	switch (code) {
		case "aborted":
			return null;
		case "not-allowed":
			return {
				message: "Microphone access was denied",
				description: "Allow the microphone for this site in the browser.",
			};
		case "service-not-allowed":
			return {
				message: "Dictation is turned off",
				description: "Turn on Dictation in the device's settings.",
			};
		case "audio-capture":
			return { message: "No microphone found" };
		case "network":
			return { message: "Dictation needs a network connection" };
		case "no-speech":
			return { message: "Didn't hear anything" };
		case "language-not-supported":
			return { message: "Dictation doesn't support this language" };
		default:
			return { message: "Dictation stopped" };
	}
}

export type DictationState = "idle" | "listening" | "finishing";

export interface DictationEvents {
	state(s: DictationState): void;
	error(e: { message: string; description?: string }): void;
}

/** Joins a recognizer's pieces into one line of words. */
function spokenOf(e: RecognitionResultEvent): string {
	const parts: string[] = [];
	for (let i = 0; i < e.results.length; i++) {
		const t = e.results[i]?.[0]?.transcript.trim();
		if (t) parts.push(t);
	}
	return parts.join(" ");
}

/**
 * One dictation at a time. The words so far (interim ones too) replace the
 * caret's selection as they come, spaced from the text around them. Stop
 * waits for the recognizer's last words; `commit` keeps what is shown and
 * ends now; `cancel` puts the draft back as it was.
 */
export class Dictation {
	state: DictationState = "idle";
	/** When listening began (ms), for the timer. */
	startedAt = 0;
	private rec: Recognition | null = null;
	private original = "";
	private before = "";
	private after = "";
	/** The text this wrote last: anything else means the draft changed under it. */
	private written: string | null = null;

	constructor(
		private readonly Ctor: RecognitionCtor,
		private readonly field: () => DraftField | null,
		private readonly on: DictationEvents,
		private readonly lang = "",
		private readonly now: () => number = Date.now,
	) {}

	start(): boolean {
		if (this.state !== "idle") return false;
		const f = this.field();
		if (!f) return false;
		this.original = f.value;
		this.before = f.value.slice(0, f.selectionStart);
		this.after = f.value.slice(f.selectionEnd);
		this.written = null;
		const rec = new this.Ctor();
		rec.lang = this.lang;
		rec.continuous = true;
		rec.interimResults = true;
		// Events from an earlier recognizer (ended or aborted) change nothing.
		rec.onresult = (e) => this.rec === rec && this.render(spokenOf(e));
		rec.onerror = (e) => {
			if (this.rec !== rec) return;
			const text = errorText(e.error);
			if (text) this.on.error(text);
			this.end();
		};
		rec.onend = () => this.rec === rec && this.end();
		this.rec = rec;
		try {
			rec.start();
		} catch {
			this.rec = null;
			this.on.error({ message: "Couldn't start dictation" });
			return false;
		}
		this.startedAt = this.now();
		this.set("listening");
		return true;
	}

	/** Stop listening; the last words still land, then it ends. */
	stop() {
		if (this.state !== "listening") return;
		this.set("finishing");
		this.rec?.stop();
	}

	/** End now and keep the draft as shown (typing, sending, leaving). */
	commit() {
		if (this.state === "idle") return;
		this.end(true);
	}

	/** End now and put the draft back as it was before dictation. */
	cancel() {
		if (this.state === "idle") return;
		const f = this.field();
		const changed = f && this.written !== null && f.value !== this.written;
		this.end(true);
		if (f && !changed) f.replace(this.original, this.before.length);
	}

	private render(spoken: string) {
		const f = this.field();
		if (!f) return;
		// The operator typed, or the draft was sent: keep it and stop.
		if (f.value !== (this.written ?? this.original)) return this.end(true);
		const pre = this.before && spoken && !/\s$/.test(this.before) ? " " : "";
		const post = this.after && spoken && !/^\s/.test(this.after) ? " " : "";
		const value = `${this.before}${pre}${spoken}${post}${this.after}`;
		this.written = value;
		f.replace(value, this.before.length + pre.length + spoken.length);
	}

	private end(abort = false) {
		const rec = this.rec;
		this.rec = null;
		if (rec) {
			rec.onresult = rec.onerror = rec.onend = null;
			if (abort) rec.abort();
		}
		this.set("idle");
	}

	private set(s: DictationState) {
		if (this.state === s) return;
		this.state = s;
		this.on.state(s);
	}
}
