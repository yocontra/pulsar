import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

/**
 * web/public/sw.js push and click handlers, run in a fake service worker
 * scope: finish/fail notices say only that an agent finished or failed,
 * one per agent (tag), quiet unless the setting asks for sound, and a tap
 * opens that agent.
 */

const SOURCE = readFileSync(
	join(import.meta.dir, "..", "web", "public", "sw.js"),
	"utf8",
);

interface Shown {
	title: string;
	opts: { body: string; tag: string; silent?: boolean; data: unknown };
}

function worker(
	opts: { ua?: string; focused?: boolean; turns?: Record<string, string> } = {},
) {
	const fetched: string[] = [];
	const handlers = new Map<string, (e: unknown) => void>();
	const shown: Shown[] = [];
	const navigated: string[] = [];
	const tab = {
		url: "https://studio.example.ts.net/#/",
		focused: opts.focused ?? false,
		visibilityState: opts.focused ? "visible" : "hidden",
		focus: async () => {},
		navigate: async (url: string) => {
			navigated.push(url);
		},
	};
	const self = {
		addEventListener: (name: string, fn: (e: unknown) => void) =>
			handlers.set(name, fn),
		navigator: { userAgent: opts.ua ?? "Mozilla/5.0 Chrome/140.0 Safari/537" },
		registration: {
			showNotification: async (title: string, o: Shown["opts"]) => {
				shown.push({ title, opts: o });
			},
		},
		clients: {
			matchAll: async () => [tab],
			openWindow: async (url: string) => {
				navigated.push(url);
			},
		},
	};
	runInNewContext(SOURCE, {
		self,
		location: { origin: "https://studio.example.ts.net" },
		URL,
		Set,
		Promise,
		Date,
		fetch: async (url: string) => {
			fetched.push(url);
			const ref = decodeURIComponent(url.split("/").pop() ?? "");
			const agentId = opts.turns?.[ref];
			return agentId
				? { ok: true, json: async () => ({ agentId }) }
				: { ok: false };
		},
		setTimeout,
	});
	const fire = async (name: string, event: Record<string, unknown>) => {
		const waits: Promise<unknown>[] = [];
		handlers.get(name)!({
			...event,
			waitUntil: (p: Promise<unknown>) => waits.push(p),
		});
		await Promise.all(waits);
	};
	const push = (data: unknown) => fire("push", { data: { json: () => data } });
	return { shown, navigated, fetched, push, fire };
}

describe("sw.js finish and fail notifications", () => {
	test("finished and failed: plain copy, one tag per agent, silent unless sound", async () => {
		const w = worker();
		await w.push({ kind: "finished", ref: "r1" });
		await w.push({ kind: "failed", ref: "r2", sound: true });
		expect(w.shown).toHaveLength(2);
		expect(w.shown[0]!.title).toBe("An agent finished");
		expect(w.shown[0]!.opts).toMatchObject({
			tag: "turn:r1",
			silent: true,
			data: { turn: "r1" },
		});
		expect(w.shown[1]!.title).toBe("An agent stopped with an error");
		expect(w.shown[1]!.opts.silent).toBe(false);
		expect(w.shown[1]!.opts.tag).toBe("turn:r2");
	});

	test("a malformed push shows nothing", async () => {
		const w = worker();
		await w.push({ kind: "finished" });
		await w.push({ kind: "finished", ref: 5 });
		expect(w.shown).toHaveLength(0);
	});

	test("a focused tab shows its own toast on Chromium; Safari always gets a notification", async () => {
		const chrome = worker({ focused: true });
		await chrome.push({ kind: "finished", ref: "r1" });
		expect(chrome.shown).toHaveLength(0);
		const safari = worker({
			focused: true,
			ua: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1",
		});
		await safari.push({ kind: "finished", ref: "r1" });
		expect(safari.shown).toHaveLength(1);
	});

	test("tapping one resolves its token and opens that agent; an old one opens the app", async () => {
		const w = worker({ turns: { r2: "m2/codex:t" } });
		await w.fire("notificationclick", {
			notification: { close: () => {}, data: { turn: "r2" } },
		});
		expect(w.fetched).toEqual(["/api/v1/push/turns/r2"]);
		expect(w.navigated).toEqual([`/#/a/${encodeURIComponent("m2/codex:t")}`]);
		await w.fire("notificationclick", {
			notification: { close: () => {}, data: { turn: "gone" } },
		});
		expect(w.navigated[1]).toBe("/");
	});
});

describe("sw.js usage limit notifications", () => {
	test("near and reached: plain copy with no names, one notice at a time, a tap opens Usage", async () => {
		const w = worker();
		await w.push({ kind: "limit", level: 95 });
		await w.push({ kind: "limit", level: 100, reached: true });
		await w.push({ kind: "limit" });
		expect(w.shown.map((n) => [n.title, n.opts.body, n.opts.tag])).toEqual([
			[
				"An agent is near its usage limit",
				"A usage limit passed 95%. Open Pulsar to see which.",
				"limit",
			],
			[
				"An agent hit its usage limit",
				"Open Pulsar to see when it resets.",
				"limit",
			],
		]);
		await w.fire("notificationclick", {
			notification: { close: () => {}, data: { limit: true } },
		});
		expect(w.navigated).toEqual(["/#/usage"]);
	});

	test("a focused tab shows its own toast on Chromium; Safari still gets a notice", async () => {
		const chrome = worker({ focused: true });
		await chrome.push({ kind: "limit", level: 80 });
		expect(chrome.shown).toHaveLength(0);
		const safari = worker({
			focused: true,
			ua: "Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Version/26.0 Mobile Safari/604.1",
		});
		await safari.push({ kind: "limit", level: 80 });
		expect(safari.shown).toHaveLength(1);
	});
});
