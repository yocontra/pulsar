/**
 * One live process is one agent. Claude Code can switch the session a
 * process runs (/resume, /clear, a session switch) while the MCP server it
 * started keeps the session id it registered with: the old session must not
 * stay listed as a second, idle agent for the same process.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claude } from "../src/harnesses/claude.ts";
import { Session } from "../src/mcp.ts";
import type { DeliveredMessage, PublicAgent } from "../src/types.ts";
import {
	agentClient,
	operator,
	registration,
	restoreEnv,
	roundTrip,
	startDaemon,
} from "./helpers.ts";

const claudeDir = mkdtempSync(join(tmpdir(), "pulsar-switch-"));
mkdirSync(join(claudeDir, "sessions"));
const previousConfig = process.env.CLAUDE_CONFIG_DIR;

/** Claude's record for this test process: it runs `sessionId` now. */
function record(sessionId: string, status = "idle", name = "lead-session") {
	writeFileSync(
		join(claudeDir, "sessions", `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId,
			cwd: "/tmp",
			name,
			status,
		}),
	);
}

let env: Awaited<ReturnType<typeof startDaemon>>;
const closers: Array<{ close: () => void }> = [];

beforeAll(async () => {
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	env = await startDaemon();
});

afterEach(() => {
	for (const c of closers.splice(0)) c.close();
});

afterAll(async () => {
	await env.daemon.stop();
	env.cleanup();
	restoreEnv("CLAUDE_CONFIG_DIR", previousConfig);
	rmSync(claudeDir, { recursive: true, force: true });
});

const registry = () => env.daemon.service.registry;
const scan = () => registry().runScan("claude", claude.scan!);
/** Live Claude agents of this process. */
const forPid = () =>
	registry()
		.live()
		.filter((a) => a.harness === "claude" && a.pid === process.pid);

/** The MCP server Claude started before the switch: registered as `sessionId`. */
async function staleMcp(sessionId: string) {
	const c = await agentClient(
		registration({
			harness: "claude",
			sessionId,
			pid: process.pid,
			cwd: "/tmp",
			role: "mcp",
		}),
	);
	closers.push(c.client);
	return c;
}

describe("a Claude process that switched sessions", () => {
	test("stale MCP hello, then the scan: one agent, the connection speaks as the current session", async () => {
		record("sess-b1");
		const stale = await staleMcp("sess-a1");
		await stale.client.call("set_identity", {
			name: "bench-demo",
			activity: "an old conversation",
		});
		// A wait the stale connection had blocked before the switch.
		const waiting = stale.client.call<{
			event: string;
			message?: DeliveredMessage;
		}>("wait", { for: "message", timeoutSeconds: 10 }, 15_000);
		await roundTrip(stale.client);
		await new Promise((r) => setTimeout(r, 5));
		await scan();

		expect(forPid().map((a) => a.id)).toEqual(["claude:sess-b1"]);
		expect(registry().get("claude:sess-a1")).toBeUndefined();
		const me = await stale.client.call<{ agent: PublicAgent }>("whoami");
		expect(me.agent.id).toBe("claude:sess-b1");
		// The old conversation's identity stays behind.
		expect(me.agent.name).toBe("lead-session");
		expect(me.agent.activity).toBeNull();
		expect(registry().get("claude:sess-b1")?.registered).toBe(true);

		// Messages to the current session reach the moved wait.
		const op = await operator();
		closers.push(op);
		await op.call("send", { to: "lead-session", body: "hello after resume" });
		const got = await waiting;
		expect(got.event).toBe("message");
		expect(got.message?.body).toBe("hello after resume");
	});

	test("scan first, then a stale hello (daemon restart): merged on the next scan", async () => {
		record("sess-b2");
		await scan();
		expect(forPid().map((a) => a.id)).toEqual(["claude:sess-b2"]);
		const stale = await staleMcp("sess-a2");
		expect(forPid()).toHaveLength(2);
		await new Promise((r) => setTimeout(r, 5));
		await scan();
		expect(forPid().map((a) => a.id)).toEqual(["claude:sess-b2"]);
		const me = await stale.client.call<{ agent: PublicAgent }>("whoami");
		expect(me.agent.id).toBe("claude:sess-b2");
	});

	test("the MCP server follows the record: hello again under the new id", async () => {
		record("sess-a3");
		await scan();
		const s = new Session(
			registration({
				harness: "claude",
				sessionId: "sess-a3",
				pid: process.pid,
				cwd: "/tmp",
				role: "mcp",
				meta: { claudeName: "old-name" },
			}),
			() => {},
		);
		closers.push({ close: () => s.close() });
		await s.call("whoami");
		expect(s.me?.id).toBe("claude:sess-a3");
		// /clear: the process now runs another session.
		record("sess-b3", "idle", "fresh-session");
		await s.call("whoami");
		expect(s.me?.id).toBe("claude:sess-b3");
		expect(s.registration.meta?.claudeName).toBe("fresh-session");
		expect(registry().get("claude:sess-a3")).toBeUndefined();
		await scan();
		expect(forPid().map((a) => a.id)).toEqual(["claude:sess-b3"]);
		expect(registry().get("claude:sess-b3")?.name).toBe("fresh-session");
	});

	test("a harness whose sessions share a pid (Codex threads) is never merged", async () => {
		const a = await agentClient(
			registration({
				harness: "codex",
				sessionId: "thread-1",
				pid: process.pid,
				role: "mcp",
			}),
		);
		const b = await agentClient(
			registration({
				harness: "codex",
				sessionId: "thread-2",
				pid: process.pid,
				role: "mcp",
			}),
		);
		closers.push(a.client, b.client);
		await scan();
		const ids = registry()
			.live()
			.filter((x) => x.harness === "codex")
			.map((x) => x.id)
			.sort();
		expect(ids).toEqual(["codex:thread-1", "codex:thread-2"]);
	});

	test("a prompt mid-turn stays busy (wait idle: must not fire); an open dialog is idle unless subagents write", async () => {
		record("sess-c1", "busy");
		await scan();
		const waiter = await agentClient(registration());
		closers.push(waiter.client);
		const name = registry().get("claude:sess-c1")!.name;
		let settled = false;
		const pending = waiter.client
			.call<{ event: string }>(
				"wait",
				{ for: `idle:${name}`, timeoutSeconds: 10 },
				15_000,
			)
			.then((r) => {
				settled = true;
				return r;
			});
		await roundTrip(waiter.client);
		writeFileSync(
			join(claudeDir, "sessions", `${process.pid}.json`),
			JSON.stringify({
				pid: process.pid,
				sessionId: "sess-c1",
				cwd: "/tmp",
				status: "waiting",
				waitingFor: "permission prompt",
			}),
		);
		await scan();
		await roundTrip(waiter.client);
		expect(registry().get("claude:sess-c1")?.status).toBe("busy");
		expect(settled).toBe(false);

		const dialog = () =>
			writeFileSync(
				join(claudeDir, "sessions", `${process.pid}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: "sess-c1",
					cwd: "/tmp",
					status: "waiting",
					waitingFor: "dialog open",
				}),
			);
		// A subagent still writes its log while /config is open: busy.
		const subagents = join(
			claudeDir,
			"projects",
			"-tmp",
			"sess-c1",
			"subagents",
		);
		mkdirSync(subagents, { recursive: true });
		const log = join(subagents, "agent-a1.jsonl");
		writeFileSync(log, "{}\n");
		dialog();
		await scan();
		expect(registry().get("claude:sess-c1")?.status).toBe("busy");
		// Quiet for over a minute: nothing runs; the session sits at a dialog.
		const old = (Date.now() - 2 * 60_000) / 1000;
		utimesSync(log, old, old);
		await scan();
		expect(registry().get("claude:sess-c1")?.status).toBe("idle");
		expect((await pending).event).toBe("idle");
	});
	test("waiting in the terminal shows needs-you until the dialog closes; a relayed prompt wins", async () => {
		const waiting = (waitingFor: string) =>
			writeFileSync(
				join(claudeDir, "sessions", `${process.pid}.json`),
				JSON.stringify({
					pid: process.pid,
					sessionId: "sess-d1",
					cwd: "/tmp",
					status: "waiting",
					waitingFor,
				}),
			);
		const needs = () => registry().needsYou("claude:sess-d1");
		// A permission prompt nobody relayed (the hook timed out or is not installed).
		waiting("permission prompt");
		await scan();
		// One scan isn't enough: a relayed prompt's hook may still be connecting.
		expect(needs()).toBeNull();
		await scan();
		expect(needs()).toMatchObject({
			reason: "terminal",
			detail: "Waiting in the terminal: permission prompt",
		});
		const view = env.daemon.service.app.views.row(
			registry().get("claude:sess-d1")!,
		);
		expect(view.state).toBe("needs-you");
		// The approvals service relays a prompt: it owns needs-you now.
		registry().setNeedsYou("claude:sess-d1", {
			reason: "approval",
			detail: "Approve Bash: ls",
		});
		await scan();
		expect(needs()?.reason).toBe("approval");
		// The app's answer timed out, the terminal still asks: back to terminal.
		registry().setNeedsYou("claude:sess-d1", null);
		await scan();
		expect(needs()?.reason).toBe("terminal");
		// Answered in the terminal: cleared.
		record("sess-d1", "busy");
		await scan();
		expect(needs()).toBeNull();
	});
});
