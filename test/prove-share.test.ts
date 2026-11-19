import { describe, expect, test } from "bun:test";
import {
	type ChannelLike,
	shareToken,
	type TokenShare,
} from "../web/src/prove/share.ts";

/** An in-memory BroadcastChannel: a post reaches every other member, async. */
function hub() {
	const members = new Set<ChannelLike>();
	return () => {
		const ch: ChannelLike = {
			onmessage: null,
			postMessage(message) {
				const data = structuredClone(message);
				for (const m of members)
					if (m !== ch) queueMicrotask(() => m.onmessage?.({ data }));
			},
			close() {
				members.delete(ch);
			},
		};
		members.add(ch);
		return ch;
	};
}

/** A tab: its in-memory token, shared over `channel`. */
function tab(
	channel: ChannelLike | null,
	token: string | null = null,
	waitMs = 30,
) {
	const t = {
		token,
		adopted: 0,
		share: null as unknown as TokenShare,
		set(next: string | null) {
			const prev = t.token;
			t.token = next;
			t.share.announce(next, prev);
		},
	};
	t.share = shareToken({
		get: () => t.token,
		adopt: (x) => {
			t.token = x;
			t.adopted++;
		},
		channel,
		waitMs,
	});
	return t;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("one Prove Human for every tab", () => {
	test("a tab that opens (or reloads) takes the token an open tab holds", async () => {
		const join = hub();
		const a = tab(join(), "tok-a");
		await a.share.ready;
		// Settled by the answer, not the timeout: with a wait far past the
		// test's own timeout, only the answer can settle it.
		const b = tab(join(), null, 60_000);
		await b.share.ready;
		expect(b.token).toBe("tok-a");
	});

	test("alone, ready settles after the wait with no token", async () => {
		const b = tab(hub()());
		await b.share.ready;
		expect(b.token).toBeNull();
	});

	test("proving in one tab proves the others; signing out drops it everywhere", async () => {
		const join = hub();
		const a = tab(join());
		const b = tab(join());
		await Promise.all([a.share.ready, b.share.ready]);
		a.set("tok-1");
		await tick();
		expect(b.token).toBe("tok-1");
		b.set(null);
		await tick();
		expect(a.token).toBeNull();
	});

	test("a drop names its token: a tab that already holds a newer one keeps it", async () => {
		const join = hub();
		const a = tab(join(), "old");
		const b = tab(join(), "new");
		await Promise.all([a.share.ready, b.share.ready]);
		// Settle on one token first (each answered the other's ask).
		b.set("new");
		await tick();
		expect(a.token).toBe("new");
		const c = tab(join(), "other");
		await tick();
		c.share.announce(null, "stale");
		await tick();
		expect(a.token).toBe("new");
	});

	test("junk on the channel is ignored", async () => {
		const join = hub();
		const a = tab(join(), "tok");
		const evil = join();
		evil.postMessage({ t: "drop", token: 42 });
		evil.postMessage({ t: "token", token: "" });
		evil.postMessage("token");
		await tick();
		expect(a.token).toBe("tok");
		expect(a.adopted).toBe(0);
	});

	test("without BroadcastChannel: no sharing, nothing waits", async () => {
		const a = tab(null, "tok");
		await a.share.ready;
		a.set(null);
		expect(a.token).toBeNull();
	});
});
