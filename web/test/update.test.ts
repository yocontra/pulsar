/** When an open app reloads into the build its daemon serves (data/update.ts). */
import { describe, expect, test } from "bun:test";
import {
	sendsPending,
	setLocalSend,
	setStopping,
} from "../src/data/pending.ts";
import {
	type Activity,
	decide,
	isBusy,
	TYPING_MS,
} from "../src/data/update.ts";

const idle: Activity = {
	typedAgo: Number.POSITIVE_INFINITY,
	focusedField: false,
	unsaved: false,
	files: false,
	dialog: false,
	inFlight: false,
	dictating: false,
};

describe("isBusy", () => {
	test("an idle page is not busy", () => {
		expect(isBusy(idle, false)).toBe(false);
	});

	test("typing, a focused field or an open dialog is busy while visible", () => {
		expect(isBusy({ ...idle, typedAgo: TYPING_MS - 1 }, false)).toBe(true);
		expect(isBusy({ ...idle, typedAgo: TYPING_MS }, false)).toBe(false);
		expect(isBusy({ ...idle, focusedField: true }, false)).toBe(true);
		expect(isBusy({ ...idle, dialog: true }, false)).toBe(true);
		expect(isBusy({ ...idle, dictating: true }, false)).toBe(true);
	});

	test("a hidden page reloads over typing, focus and dialogs", () => {
		const a = { ...idle, typedAgo: 0, focusedField: true, dialog: true };
		expect(isBusy(a, true)).toBe(false);
	});

	test("what a reload would lose is busy, hidden or not", () => {
		for (const k of ["unsaved", "files", "inFlight"] as const) {
			expect(isBusy({ ...idle, [k]: true }, false)).toBe(true);
			expect(isBusy({ ...idle, [k]: true }, true)).toBe(true);
		}
	});
});

describe("sendsPending", () => {
	const send = (state: "sending" | "sent" | "failed") => ({
		state,
		retry: () => {},
		discard: () => {},
	});

	test("a send on its way or failed (text only in its bubble) holds a reload", () => {
		expect(sendsPending()).toBe(false);
		setLocalSend("local:a", send("sending"));
		expect(sendsPending()).toBe(true);
		setLocalSend("local:a", send("failed"));
		expect(sendsPending()).toBe(true);
		setLocalSend("local:a", send("sent"));
		expect(sendsPending()).toBe(false);
		setLocalSend("local:a", null);
	});

	test("a Stop in flight holds a reload", () => {
		setStopping("agent-1", true);
		expect(sendsPending()).toBe(true);
		setStopping("agent-1", false);
		expect(sendsPending()).toBe(false);
	});
});

describe("decide", () => {
	const base = { own: "aaa", served: "bbb", tried: null, busy: false };

	test("a new build on an idle page reloads", () => {
		expect(decide(base)).toBe("reload");
	});

	test("a busy page waits (toast, then the next quiet moment)", () => {
		expect(decide({ ...base, busy: true })).toBe("wait");
	});

	test("the same build does nothing", () => {
		expect(decide({ ...base, served: "aaa" })).toBe("none");
	});

	test("no build id (an older daemon, or the dev server) does nothing", () => {
		expect(decide({ ...base, served: undefined })).toBe("none");
		expect(decide({ ...base, served: "" })).toBe("none");
		expect(decide({ ...base, own: null })).toBe("none");
	});

	test("after one reload for a build, a mismatch shows the toast only", () => {
		expect(decide({ ...base, tried: "bbb" })).toBe("toast");
		expect(decide({ ...base, tried: "bbb", busy: true })).toBe("toast");
		// A later build gets its own automatic reload.
		expect(decide({ ...base, tried: "bbb", served: "ccc" })).toBe("reload");
	});
});
