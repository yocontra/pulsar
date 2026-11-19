/** Prove Human's choice between signing in and registering (prove/flow.ts). */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { hasPasskey, rememberPasskey } from "../src/approval/passkey.ts";
import { prove } from "../src/prove/flow.ts";

const store = new Map<string, string>();
const g = globalThis as { localStorage?: unknown };
const before = g.localStorage;
g.localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => store.set(k, v),
	removeItem: (k: string) => store.delete(k),
};
afterAll(() => {
	if (before === undefined) delete g.localStorage;
	else g.localStorage = before;
});

function steps(signInError?: Error) {
	const calls: string[] = [];
	return {
		calls,
		signIn: async () => {
			calls.push("signIn");
			if (signInError) throw signInError;
		},
		register: async () => {
			calls.push("register");
		},
	};
}

const notAllowed = () =>
	Object.assign(new Error("not allowed"), { name: "NotAllowedError" });

describe("prove", () => {
	beforeEach(() => store.clear());

	test("a device with the hint signs in", async () => {
		rememberPasskey();
		const s = steps();
		await prove(true, s);
		expect(s.calls).toEqual(["signIn"]);
	});

	test("a removed passkey does not lock the device out", async () => {
		rememberPasskey();
		const first = steps(notAllowed());
		await expect(prove(true, first)).rejects.toThrow("not allowed");
		expect(hasPasskey()).toBe(false);
		// The next try registers a new passkey.
		const next = steps();
		await prove(true, next);
		expect(next.calls).toEqual(["register"]);
	});

	test("a network error keeps the hint", async () => {
		rememberPasskey();
		await expect(prove(true, steps(new Error("offline")))).rejects.toThrow();
		expect(hasPasskey()).toBe(true);
	});
});
