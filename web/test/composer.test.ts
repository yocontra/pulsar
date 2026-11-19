/** Composer helpers that talk to /send. */
import { describe, expect, test } from "bun:test";
import type { SendRequest, SendResult } from "../src/api/types.ts";
import { confirmTier, sendConfirmed } from "../src/components/Composer.tsx";

describe("sendConfirmed", () => {
	test("a resend drops the first send's client id", async () => {
		const seen: SendRequest[] = [];
		const send = async (r: SendRequest) => {
			seen.push(r);
			return seen.length === 1
				? ({ total: 1, reconfirm: "confirm", resolveToken: "t" } as SendResult)
				: ({ total: 1, messageId: "m2" } as SendResult);
		};
		const r = await sendConfirmed(
			{ ids: ["a"], body: "hi", clientId: "c_first" },
			send,
		);
		expect(r.messageId).toBe("m2");
		expect(seen).toHaveLength(2);
		// The daemon answers a repeated id with the first result: no delivery.
		for (const s of seen) expect(s.clientId).toBeUndefined();
		expect(seen[1]!.resolveToken).toBe("t");
	});
});

describe("confirmTier", () => {
	const dry = (total: number) =>
		({ total, machines: 1, resolveToken: "t" }) as SendResult;
	test("one recipient sends at once after a dry run", () => {
		expect(confirmTier(dry(1), false, false)).toBe("direct");
	});
	test("a 409 for one recipient still asks (else the text is lost)", () => {
		expect(confirmTier(dry(1), true, false)).toBe("inline");
	});
	test("wider sends keep their tier", () => {
		expect(confirmTier(dry(8), true, false)).toBe("inline");
		expect(confirmTier(dry(8), false, true)).toBe("dialog");
	});
});
