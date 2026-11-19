import { afterAll, beforeAll, expect, test } from "bun:test";
import { driverFor } from "../src/harnesses/index.ts";
import { Session } from "../src/mcp.ts";
import { agentClient, registration, startDaemon } from "./helpers.ts";

let env: Awaited<ReturnType<typeof startDaemon>>;
beforeAll(async () => {
	env = await startDaemon();
});
afterAll(async () => {
	await env.daemon.stop();
	env.cleanup();
});

test("a claimed session id moves to the next candidate on a fresh connection", async () => {
	// Another Codex thread of this process already serves thread-a.
	const holder = await agentClient(
		registration({
			harness: "codex",
			sessionId: "thread-a",
			pid: 5150,
			role: "mcp",
		}),
	);
	const late = driverFor("codex")!.lateSession!;
	const saved = { find: late.find, adopt: late.adopt };
	late.find = async (_reg, exclude) =>
		exclude.has("thread-a") ? "thread-b" : "thread-a";
	late.adopt = async (reg, id) => {
		reg.sessionId = id;
	};
	try {
		const s = new Session(
			registration({
				harness: "codex",
				sessionId: "thread-a",
				pid: 5150,
				role: "mcp",
			}),
			() => {},
		);
		await s.ensure();
		expect(s.me?.id).toContain("thread-b");
		s.client.close();
	} finally {
		late.find = saved.find;
		late.adopt = saved.adopt;
		holder.client.close();
	}
});

test("an OpenCode session is not swept while a call runs, and a closed one never reconnects", async () => {
	const s = new Session(
		registration({
			harness: "opencode",
			sessionId: "ses_long_wait",
			pid: null,
			role: "mcp",
		}),
		() => {},
	);
	const far = Date.now() + 3600_000;
	const waiting = s.call("wait", { for: "message", timeoutSeconds: 1 });
	// A long wait is a call in use, however long ago it started.
	await new Promise((r) => setTimeout(r, 50));
	expect(s.idle(far, 60_000)).toBe(false);
	await waiting;
	expect(s.idle(far, 60_000)).toBe(true);
	s.close();
	// What waitReply's retry does after a sweep: it must not come back as an orphan.
	await expect(s.call("whoami")).rejects.toMatchObject({ code: "closed" });
	expect(s.client.connected).toBe(false);
});
