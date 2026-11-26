/**
 * An OpenCode session shown only by the folder guess (the latest session in
 * an open TUI's folder) is inbox-only: no send, broadcast or redelivery
 * wakes or resumes it, and the app says "last session". Once that session
 * connects to pulsar itself, it is a normal target.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { opencode } from "../src/harnesses/opencode.ts";
import type { Scanned } from "../src/harnesses/types.ts";
import {
	agentClient,
	operator,
	registration,
	startDaemon,
	until,
} from "./helpers.ts";

let env: Awaited<ReturnType<typeof startDaemon>>;
const pushed: string[] = [];
const savedDeliver = opencode.push!.deliver;
const closers: Array<{ close: () => void }> = [];

const row = (id: string, meta: Record<string, string>): Scanned => ({
	harness: "opencode",
	sessionId: id,
	pid: null,
	cwd: "/work/oc",
	status: "idle",
	meta,
});
const found: Scanned[] = [
	row("ses_guess", { sessionFrom: "folder", tuiPid: "4242", title: "old" }),
	row("ses_live", { sessionFrom: "active", title: "live" }),
];
const scan = { intervalMs: 60_000, sessions: () => found };

beforeAll(async () => {
	env = await startDaemon();
	opencode.push!.deliver = async (agent) => {
		pushed.push(agent.sessionId ?? "");
		return { ok: true, via: "fake" };
	};
	await env.daemon.service.registry.runScan("opencode", scan);
});

beforeEach(() => {
	pushed.length = 0;
});

afterAll(async () => {
	opencode.push!.deliver = savedDeliver;
	for (const c of closers) c.close();
	await env.daemon.stop();
	env.cleanup();
});

const registry = () => env.daemon.service.registry;
const views = () => env.daemon.service.app.views;

test("the guess is inbox-only and labelled; the running session wakes", () => {
	const guess = registry().get("opencode:ses_guess")!;
	const live = registry().get("opencode:ses_live")!;
	expect(guess.reach).toBe("pull");
	expect(opencode.push!.canSteer!(guess)).toBe(false);
	expect(opencode.push!.canSteer!(live)).toBe(true);
	expect(opencode.canInterrupt!(guess)).toBe(false);
	expect(opencode.canInterrupt!(live)).toBe(true);
	expect(live.reach).toBe("push");
	const g = views().row(guess);
	expect(g.wake).toBe("inbox-only");
	expect(g.sessionFrom).toBe("folder");
	expect(views().row(live).wake).toBe("wakes");
	expect(views().row(live).sessionFrom).toBeUndefined();
});

test("a direct send and a broadcast never push into the guess", async () => {
	const op = await operator();
	closers.push(op);
	const guess = registry().get("opencode:ses_guess")!;
	await op.call("send", { to: guess.name, body: "direct" });
	await op.call("send", { to: "*", body: "everyone" });
	await until(() => pushed.includes("ses_live"));
	await new Promise((r) => setTimeout(r, 100));
	expect(pushed).not.toContain("ses_guess");
	// The messages wait in its inbox.
	expect(env.daemon.service.store.unreadCount("opencode:ses_guess")).toBe(2);
});

test("a broadcast's wake count leaves the guess out", () => {
	const rows = views()
		.matching("harness:opencode", views().rows("normal"))
		.filter((r) => !r.id.includes("/"));
	expect(rows.map((r) => [r.id, r.wake]).sort()).toEqual([
		["opencode:ses_guess", "inbox-only"],
		["opencode:ses_live", "wakes"],
	]);
});

test("the guessed session connecting to pulsar itself makes it a normal target", async () => {
	const c = await agentClient(
		registration({
			harness: "opencode",
			sessionId: "ses_guess",
			pid: null,
			role: "mcp",
		}),
	);
	closers.push(c.client);
	const guess = registry().get("opencode:ses_guess")!;
	expect(guess.reach).toBe("push");
	expect(views().row(guess).sessionFrom).toBeUndefined();
	expect(views().row(guess).wake).toBe("wakes");
});
