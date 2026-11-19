import { describe, expect, test } from "bun:test";
import { RpcError } from "../src/rpc.ts";
import {
	type EnrollDeps,
	type EnrollEvent,
	EnrollGate,
	hostInAncestry,
} from "../src/service/enroll.ts";

function gate(over: Partial<EnrollDeps> = {}) {
	const written: { tty: string; text: string }[] = [];
	const events: EnrollEvent[] = [];
	let now = 1_000_000;
	const deps: EnrollDeps = {
		ttyOf: () => "/dev/ttys009",
		ownedByUser: () => true,
		processesOn: () => [4242, 4243],
		agentHost: () => null,
		writeTty: (tty, text) => written.push({ tty, text }),
		now: () => now,
		...over,
	};
	const g = new EnrollGate(deps);
	g.onEvent = (e) => events.push(e);
	return {
		g,
		written,
		events,
		tick: (ms: number) => {
			now += ms;
		},
	};
}

const codeOf = (fn: () => unknown) => {
	try {
		fn();
		return null;
	} catch (e) {
		return e instanceof RpcError ? e.code : String(e);
	}
};
const codeOfAsync = async (fn: () => Promise<unknown>) => {
	try {
		await fn();
		return null;
	} catch (e) {
		return e instanceof RpcError ? e.code : String(e);
	}
};
const shown = (text: string) => /type: (\S+)/.exec(text)![1]!;

describe("enrollment terminal check", () => {
	test("the confirmation (10 characters, ~49 bits) goes only to the terminal", async () => {
		const { g, written, events, tick } = gate();
		const r = await g.start(4242);
		expect(Object.keys(r).sort()).toEqual(["ticket", "tty"]);
		const word = shown(written[0]!.text);
		expect(word).toMatch(/^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
		expect(31 ** 10).toBeGreaterThan(2 ** 49);
		expect(JSON.stringify(r)).not.toContain(word.slice(0, 5));
		expect(g.confirm(r.ticket, "WRONG-WRONG")).toBe(false);
		// Backoff: 1 s after the first wrong answer, even for the right one.
		expect(codeOf(() => g.confirm(r.ticket, word))).toBe("rate_limited");
		tick(1500);
		expect(g.confirm(r.ticket, word.toLowerCase())).toBe(true);
		expect(events.map((e) => e.kind)).toEqual(["ticket", "wrong", "confirmed"]);
		// Used once.
		expect(codeOf(() => g.confirm(r.ticket, word))).toBe("not_a_terminal");
	});

	test("brute force (the review's PoC): a guessing loop gets a handful of tickets an hour", async () => {
		const { g, tick, events } = gate();
		let tickets = 0;
		let wins = 0;
		for (let elapsed = 0; elapsed < 60 * 60_000; ) {
			let r: { ticket: string } | null = null;
			try {
				r = await g.start(4242);
				tickets++;
			} catch (e) {
				expect((e as RpcError).code).toBe("rate_limited");
			}
			if (r)
				for (let i = 0; i < 3; i++) {
					try {
						if (g.confirm(r.ticket, "AAAAA-AAAAA")) wins++;
					} catch {}
					tick(1000);
					elapsed += 1000;
				}
			tick(1000);
			elapsed += 1000;
		}
		expect(wins).toBe(0);
		// Exponential backoff: 0, 15 s, 30 s, 1 min, 2 min, … in one hour.
		expect(tickets).toBeLessThanOrEqual(10);
		expect(events.filter((e) => e.kind === "ticket").length).toBe(tickets);
	});

	test("one ticket at a time: a new one ends the old one", async () => {
		const { g, tick } = gate();
		const a = await g.start(4242);
		tick(20_000);
		await g.start(4242);
		expect(codeOf(() => g.confirm(a.ticket, "x"))).toBe("not_a_terminal");
	});

	test("no terminal, someone else's terminal, a pid not on it, or a process under an agent host: refused", async () => {
		const cases: Partial<EnrollDeps>[] = [
			{ ttyOf: () => null },
			{ ownedByUser: () => false },
			{ processesOn: () => [999] },
			// The terminal's own shell is fine, but Claude Code runs on it too.
			{ agentHost: (pid) => (pid === 4243 ? "Claude Code" : null) },
		];
		for (const over of cases) {
			const { g, written, events } = gate(over);
			expect(await codeOfAsync(() => g.start(4242))).toBe("not_a_terminal");
			expect(written).toHaveLength(0);
			expect(events.map((e) => e.kind)).toEqual(["refused"]);
		}
		expect(await codeOfAsync(() => gate().g.start(1))).toBe("not_a_terminal");
	});

	test("ancestry: the process itself counts, there is no depth cutoff, cycles end", () => {
		type P = { pid: number; ppid: number; args: string };
		const table = new Map<number, P>();
		table.set(100, { pid: 100, ppid: 50, args: "claude" });
		table.set(50, { pid: 50, ppid: 1, args: "-zsh" });
		let parent = 100;
		for (let i = 0; i < 40; i++) {
			const p = 200 + i;
			table.set(p, { pid: p, ppid: parent, args: "sh -c x" });
			parent = p;
		}
		table.set(999, {
			pid: 999,
			ppid: parent,
			args: "script -q /tmp/w sleep 60",
		});
		expect(hostInAncestry(999, table)).toBe("Claude Code");
		expect(hostInAncestry(100, table)).toBe("Claude Code");
		expect(hostInAncestry(50, table)).toBeNull();
		table.set(7, { pid: 7, ppid: 8, args: "a" });
		table.set(8, { pid: 8, ppid: 7, args: "b" });
		expect(hostInAncestry(7, table)).toBeNull();
	});
});
