/**
 * Dictation into the composer's draft (src/features/voice/dictation.ts),
 * with a fake recognizer and a fake text field.
 */
import { describe, expect, test } from "bun:test";
import {
	Dictation,
	type DictationState,
	type DraftField,
	errorText,
	type Recognition,
	type RecognitionResultEvent,
	recognitionCtor,
} from "../src/features/voice/dictation.ts";

class FakeRecognition implements Recognition {
	static last: FakeRecognition | null = null;
	static failStart = false;
	lang = "";
	continuous = false;
	interimResults = false;
	onresult: ((e: RecognitionResultEvent) => void) | null = null;
	onerror: ((e: { error: string }) => void) | null = null;
	onend: (() => void) | null = null;
	calls: string[] = [];
	constructor() {
		FakeRecognition.last = this;
	}
	start() {
		if (FakeRecognition.failStart) throw new Error("InvalidStateError");
		this.calls.push("start");
	}
	stop() {
		this.calls.push("stop");
	}
	abort() {
		this.calls.push("abort");
	}
	/** The recognizer's results so far, one transcript each. */
	say(...pieces: string[]) {
		this.onresult?.({ results: pieces.map((t) => [{ transcript: t }]) });
	}
}

class Field implements DraftField {
	constructor(
		public value = "",
		public selectionStart = value.length,
		public selectionEnd = selectionStart,
	) {}
	replace(value: string, caret: number) {
		this.value = value;
		this.selectionStart = this.selectionEnd = caret;
	}
}

function setup(field = new Field()) {
	const states: DictationState[] = [];
	const errors: string[] = [];
	const d = new Dictation(
		FakeRecognition,
		() => field,
		{ state: (s) => states.push(s), error: (e) => errors.push(e.message) },
		"en-GB",
		() => 1000,
	);
	FakeRecognition.failStart = false;
	return { d, field, states, errors, rec: () => FakeRecognition.last! };
}

describe("dictation", () => {
	test("finds the browser's recognizer, prefixed or not", () => {
		const W = FakeRecognition;
		expect(recognitionCtor({})).toBeNull();
		expect(recognitionCtor({ webkitSpeechRecognition: W })).toBe(W);
		expect(recognitionCtor({ SpeechRecognition: W })).toBe(W);
	});

	test("listens continuously with interim words in the operator's language", () => {
		const { d, rec, states } = setup();
		expect(d.start()).toBe(true);
		expect(rec().calls).toEqual(["start"]);
		expect(rec().continuous).toBe(true);
		expect(rec().interimResults).toBe(true);
		expect(rec().lang).toBe("en-GB");
		expect(d.startedAt).toBe(1000);
		expect(states).toEqual(["listening"]);
		expect(d.start()).toBe(false);
	});

	test("interim words show live, then the final words replace them", () => {
		const { d, rec, field } = setup();
		d.start();
		rec().say("fix the");
		expect(field.value).toBe("fix the");
		rec().say("fix the bug", " in");
		expect(field.value).toBe("fix the bug in");
		rec().say("fix the bug", " in login");
		expect(field.value).toBe("fix the bug in login");
		expect(field.selectionStart).toBe(field.value.length);
	});

	test("words go in at the caret, spaced from the text around them", () => {
		const f = new Field("Please now", 6);
		const { d, rec, field } = setup(f);
		d.start();
		rec().say("check the tests");
		expect(field.value).toBe("Please check the tests now");
		expect(field.selectionStart).toBe("Please check the tests".length);
	});

	test("a selection is replaced by the words", () => {
		const { d, rec, field } = setup(new Field("one two three", 4, 7));
		d.start();
		rec().say("2");
		expect(field.value).toBe("one 2 three");
	});

	test("Stop waits for the last words, then ends", () => {
		const { d, rec, field, states } = setup();
		d.start();
		rec().say("hello");
		d.stop();
		expect(rec().calls).toEqual(["start", "stop"]);
		expect(d.state).toBe("finishing");
		rec().say("hello world");
		rec().onend?.();
		expect(field.value).toBe("hello world");
		expect(states).toEqual(["listening", "finishing", "idle"]);
	});

	test("commit while finishing ends a stop that never ends", () => {
		const { d, rec, field } = setup();
		d.start();
		const r = rec();
		r.say("almost");
		d.stop();
		d.commit();
		expect(r.calls).toEqual(["start", "stop", "abort"]);
		expect(d.state).toBe("idle");
		expect(field.value).toBe("almost");
	});

	test("the recognizer ending on its own (silence) keeps the words", () => {
		const { d, rec, field } = setup();
		d.start();
		const r = rec();
		r.say("done");
		r.onend?.();
		expect(d.state).toBe("idle");
		r.say("late");
		expect(field.value).toBe("done");
	});

	test("cancel puts the draft back as it was", () => {
		const { d, rec, field } = setup(new Field("Draft: ", 7));
		d.start();
		const r = rec();
		r.say("something wrong");
		expect(field.value).toBe("Draft: something wrong");
		d.cancel();
		expect(r.calls).toEqual(["start", "abort"]);
		expect(field.value).toBe("Draft: ");
		expect(field.selectionStart).toBe(7);
		expect(d.state).toBe("idle");
	});

	test("commit keeps what is shown and ignores later words", () => {
		const { d, rec, field } = setup();
		d.start();
		const r = rec();
		r.say("send this");
		d.commit();
		expect(r.calls).toEqual(["start", "abort"]);
		r.say("send this and more");
		expect(field.value).toBe("send this");
	});

	test("the draft changing under it (typed or sent) stops it without writing", () => {
		const { d, rec, field } = setup();
		d.start();
		const r = rec();
		r.say("first");
		field.replace("", 0);
		r.say("first second");
		expect(field.value).toBe("");
		expect(d.state).toBe("idle");
		expect(r.calls).toEqual(["start", "abort"]);
		// Cancel after that has nothing to put back.
		d.cancel();
		expect(field.value).toBe("");
	});

	test("errors read plainly, keep the words and end; abort says nothing", () => {
		const { d, rec, errors, field } = setup();
		d.start();
		rec().say("partial");
		rec().onerror?.({ error: "not-allowed" });
		expect(errors).toEqual(["Microphone access was denied"]);
		expect(field.value).toBe("partial");
		expect(d.state).toBe("idle");
		d.start();
		rec().onerror?.({ error: "aborted" });
		expect(errors).toHaveLength(1);
		expect(d.state).toBe("idle");
	});

	test("a recognizer that refuses to start says so", () => {
		const { d, errors, states } = setup();
		FakeRecognition.failStart = true;
		expect(d.start()).toBe(false);
		expect(errors).toEqual(["Couldn't start dictation"]);
		expect(states).toEqual([]);
	});

	test("error wording", () => {
		expect(errorText("aborted")).toBeNull();
		expect(errorText("not-allowed")?.message).toBe(
			"Microphone access was denied",
		);
		expect(errorText("service-not-allowed")?.message).toBe(
			"Dictation is turned off",
		);
		expect(errorText("audio-capture")?.message).toBe("No microphone found");
		expect(errorText("network")?.message).toBe(
			"Dictation needs a network connection",
		);
		expect(errorText("no-speech")?.message).toBe("Didn't hear anything");
		expect(errorText("something-new")?.message).toBe("Dictation stopped");
	});
});
