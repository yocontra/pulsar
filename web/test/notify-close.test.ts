import { describe, expect, test } from "bun:test";
import { closeAnswered } from "../src/features/notify/close.ts";

function sw(ids: Array<string | undefined>) {
	const closed: string[] = [];
	const notes = ids.map((id, i) => ({
		data: id === undefined ? null : { id },
		close: () => closed.push(id ?? `none-${i}`),
	}));
	return {
		closed,
		container: {
			getRegistration: async () =>
				({ getNotifications: async () => notes }) as never,
		},
	};
}

describe("closeAnswered", () => {
	test("an answered prompt closes only its own notification", async () => {
		const s = sw(["r1", "r2", undefined, "r1"]);
		expect(
			await closeAnswered({ requestId: "r1", state: "allowed" }, s.container),
		).toBe(2);
		expect(s.closed).toEqual(["r1", "r1"]);
	});

	test("a pending prompt, or no service worker, closes nothing", async () => {
		const s = sw(["r1"]);
		expect(
			await closeAnswered({ requestId: "r1", state: "pending" }, s.container),
		).toBe(0);
		expect(s.closed).toEqual([]);
		expect(
			await closeAnswered({ requestId: "r1", state: "denied" }, undefined),
		).toBe(0);
	});
});
