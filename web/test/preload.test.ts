// Must come first: TanStack decides "server or browser" when it loads.
import "./window-shim.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient } from "@tanstack/react-query";

/**
 * public/preload.js starts the first screen's reads before the app runs;
 * the app must ask for exactly the same paths, or every preload is wasted.
 * These run the real script and the real query definitions.
 */
const store = new Map<string, string>();
const calls: string[] = [];
const g = globalThis as Record<string, unknown>;
const saved = {
	fetch: g.fetch,
	localStorage: g.localStorage,
	location: g.location,
};
const loc = { hash: "" };

beforeAll(() => {
	g.location = loc;
	g.localStorage = {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => store.set(k, v),
		removeItem: (k: string) => store.delete(k),
	};
	g.fetch = async (url: string) => {
		calls.push(String(url));
		return new Response(
			JSON.stringify({
				items: [],
				total: 0,
				nextCursor: null,
				events: [],
				cursor: null,
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
});
afterAll(() => {
	g.fetch = saved.fetch;
	g.localStorage = saved.localStorage;
	g.location = saved.location;
	delete g.__pulsarPreload;
});

function runPreload() {
	calls.length = 0;
	const src = readFileSync(
		join(import.meta.dir, "..", "public", "preload.js"),
		"utf8",
	);
	new Function(src)();
	return [...calls];
}

describe("data preload", () => {
	test("the app's first reads use the preloaded responses, each once", async () => {
		store.set("pulsar.sort", JSON.stringify("busy"));
		store.set(
			"pulsar.expanded.machines",
			JSON.stringify(["m:abc", "m:abc/p:my app"]),
		);
		const started = runPreload();
		expect(started).toEqual([
			"/api/v1/hello",
			"/api/v1/tree?group=machines&sort=busy&limit=100",
			"/api/v1/attention",
			"/api/v1/recent",
			"/api/v1/tree/m%3Aabc/children?sort=busy",
			"/api/v1/tree/m%3Aabc%2Fp%3Amy%20app/children?sort=busy",
		]);
		const { defs } = await import("../src/data/queries.ts");
		const client = new QueryClient();
		const signal = new AbortController().signal;
		calls.length = 0;
		await defs.hello().queryFn({ signal });
		await defs.tree(client, "machines", "", "busy").queryFn({ signal });
		await defs.attention().queryFn({ signal });
		await defs.recent().queryFn({ signal });
		await defs.children(client, "m:abc", "", "busy").queryFn({ signal });
		await defs
			.children(client, "m:abc/p:my app", "", "busy")
			.queryFn({ signal });
		// Every one came from the preload: no request of the app's own.
		expect(calls).toEqual([]);
		// Single use: the next poll goes to the network.
		await defs.attention().queryFn({ signal });
		expect(calls).toEqual(["/api/v1/attention"]);
	});

	test("a first visit asks for the default branches with the tree, as the app does", async () => {
		store.delete("pulsar.sort");
		store.delete("pulsar.expanded.machines");
		expect(runPreload()).toEqual([
			"/api/v1/hello",
			"/api/v1/tree?group=machines&sort=needs&limit=100&expand=default",
			"/api/v1/attention",
			"/api/v1/recent",
		]);
		const { defs, expandNextTree } = await import("../src/data/queries.ts");
		const { keys } = await import("../src/data/keys.ts");
		const client = new QueryClient();
		const signal = new AbortController().signal;
		calls.length = 0;
		expandNextTree("default");
		g.__pulsarPreload = new Map([
			[
				"/tree?group=machines&sort=needs&limit=100&expand=default",
				{
					at: Date.now(),
					token: null,
					res: Promise.resolve(
						Response.json({
							items: [{ id: "m:1" }],
							total: 1,
							nextCursor: null,
							expanded: {
								"m:1": {
									items: [{ id: "m:1/p:a" }],
									total: 1,
									nextCursor: null,
								},
							},
						}),
					),
				},
			],
		]);
		const top = await defs
			.tree(client, "machines", "", "needs")
			.queryFn({ signal });
		expect(calls).toEqual([]);
		expect(top).toEqual({
			items: [{ id: "m:1" }],
			total: 1,
			nextCursor: null,
		} as never);
		// The included branch seeds its own query: no children request later.
		expect(client.getQueryData(keys.children("m:1", "", "needs"))).toEqual({
			items: [{ id: "m:1/p:a" }],
			total: 1,
			nextCursor: null,
		});
		// Once: the next fetch asks for the top level only.
		await defs.tree(client, "machines", "", "needs").queryFn({ signal });
		expect(calls).toEqual(["/api/v1/tree?group=machines&sort=needs&limit=100"]);
	});

	test("a link to a session preloads its row and newest page; the session uses them", async () => {
		store.set("pulsar.expanded.machines", "[]");
		loc.hash = "#/a/claude%3Aabc%2F1";
		const started = runPreload();
		loc.hash = "";
		expect(started.slice(-2)).toEqual([
			"/api/v1/agents/claude%3Aabc%2F1",
			"/api/v1/agents/claude%3Aabc%2F1/transcript",
		]);
		const { defs, transcriptDef } = await import("../src/data/queries.ts");
		const client = new QueryClient();
		const signal = new AbortController().signal;
		calls.length = 0;
		await defs.agent("claude:abc/1").queryFn({ signal });
		// No event stream yet (a cold link): the page goes without `stream`.
		await transcriptDef(
			client,
			"claude:abc/1",
			async () => {},
			undefined,
			() => null,
		).queryFn({ signal });
		expect(calls).toEqual([]);
		// The stream opened before the session asked: the preloaded page still serves.
		loc.hash = "#/a/claude%3Aabc%2F1";
		runPreload();
		loc.hash = "";
		calls.length = 0;
		await transcriptDef(
			client,
			"claude:abc/1",
			async () => {},
			undefined,
			() => "s0",
		).queryFn({ signal });
		expect(calls).toEqual([]);
		// With a stream open, the page subscribes it (and the subscription PUT
		// runs alongside, not first).
		let flushed = false;
		await transcriptDef(
			client,
			"claude:abc/1",
			async () => {
				flushed = true;
			},
			undefined,
			() => "s1",
		).queryFn({ signal });
		expect(flushed).toBe(true);
		expect(calls).toEqual([
			"/api/v1/agents/claude%3Aabc%2F1/transcript?stream=s1",
		]);
	});

	test("a different token, a stale preload, or an unknown sort is not used", async () => {
		const { takePreload } = await import("../src/api/client.ts");
		store.set("pulsar.sort", JSON.stringify("<script>"));
		store.set("pulsar.expanded.machines", "[]");
		store.set("pulsar.session", "tok-1");
		expect(runPreload()).toContain(
			"/api/v1/tree?group=machines&sort=needs&limit=100",
		);
		store.delete("pulsar.session");
		// The app holds no token (or another one): the preload is dropped.
		expect(takePreload("/hello", null)).toBeNull();
		expect(takePreload("/hello", "tok-1")).toBeNull();
		expect(takePreload("/attention", "tok-1")).not.toBeNull();
		expect(takePreload("/recent", "tok-1", Date.now() + 11_000)).toBeNull();
	});
});
