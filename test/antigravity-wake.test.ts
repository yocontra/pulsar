import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DaemonClient } from "../src/client.ts";
import { PROTOCOL_VERSION, type Receipt } from "../src/types.ts";
import {
	agentClient,
	operator,
	registration,
	restoreEnv,
	startDaemon,
	until,
} from "./helpers.ts";

const sessionId = "891ffebd-6d62-42ee-9307-60daffce3c1a";
const other = "a85919cf-aaf9-4b28-9696-622b10585f75";

test.skipIf(process.platform === "win32")(
	"binds the native command tool to its conversation, flushes once and withdraws on disconnect",
	async () => {
		const { daemon, home, cleanup } = await startDaemon();
		const realHome = process.env.HOME;
		process.env.HOME = join(home, "linked-home");
		symlinkSync(home, process.env.HOME);
		const directory = join(home, ".gemini", "antigravity-cli", "presence");
		mkdirSync(directory, { recursive: true });
		const lock = join(directory, `${sessionId}.lock`);
		const cli = join(import.meta.dir, "../src/cli.ts");
		const helper = join(home, "agentapi-fixture.js");
		const calls = join(home, "calls.jsonl");
		writeFileSync(
			helper,
			`#!${process.execPath}
const fs = require("node:fs");
const [command, operation, recipient, text] = process.argv.slice(2);
fs.appendFileSync(process.env.WAKE_FIXTURE_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");
if (command !== "agentapi") process.exit(1);
if (operation === "get-conversation-metadata") {
	const metadata = process.env.EMPTY_METADATA ? null : {conversationId: recipient};
	console.log(JSON.stringify({response: {conversationMetadata: {metadata}}}));
} else {
	if (text.includes("REJECT_FIXTURE")) process.exit(1);
	const recipientId = text.includes("WRONG_RESPONSE") ? "different" : recipient;
	console.log(JSON.stringify({response: {sendMessage: {recipientId, content: text}}}));
}
`,
			{ mode: 0o700 },
		);
		const host = spawn(
			process.execPath,
			[
				"-e",
				"require('node:fs').openSync(process.argv.at(-1),'w');process.stdout.write('ready');setInterval(()=>{},10000)",
				lock,
			],
			{ argv0: "agy", cwd: home, stdio: ["ignore", "pipe", "ignore"] },
		);
		const env = {
			...process.env,
			ANTIGRAVITY_LS_ADDRESS: "fixture",
			ANTIGRAVITY_CONVERSATION_ID: sessionId,
			ANTIGRAVITY_AGENTAPI_EXE: helper,
			WAKE_FIXTURE_CALLS: calls,
		};
		const hook = async (
			event = "SessionStart",
			extraEnv: NodeJS.ProcessEnv = {},
			conversationId = sessionId,
			invocationNum = 0,
		) => {
			const proc = spawn(
				process.execPath,
				[cli, "hook", "antigravity-session"],
				{
					env: { ...env, ...extraEnv },
					stdio: ["pipe", "pipe", "pipe"],
					timeout: 10_000,
				},
			);
			let stdout = "",
				stderr = "";
			proc.stdout.on("data", (chunk) => (stdout += chunk));
			proc.stderr.on("data", (chunk) => (stderr += chunk));
			const finished = once(proc, "close");
			proc.stdin.end(
				JSON.stringify({ hookEventName: event, conversationId, invocationNum }),
			);
			const [code] = await finished;
			if (code !== 0) throw new Error(stderr || `hook exited ${code}`);
			return JSON.parse(stdout);
		};
		const bus = new DaemonClient();
		const op = await operator();
		let mcp: DaemonClient | undefined;
		try {
			await once(host.stdout, "data");
			const reg = registration({
				nativeHostToken: crypto.randomUUID(),
				harness: "antigravity",
				role: "mcp",
				pid: host.pid!,
				sessionId,
				cwd: home,
			});
			const native = await agentClient(reg);
			mcp = native.client;
			const id = native.agent.id;
			const send = (body: string, priority = "normal") =>
				op.call<{ message: { id: string }; receipts: Receipt[] }>("send", {
					to: id,
					body,
					priority,
				});
			const staged = await send("hook test message");
			const urgent = await send("immediate hook message", "urgent");
			const unbound = { ANTIGRAVITY_LS_ADDRESS: "" };
			expect(await hook("PreInvocation", unbound, other)).toEqual({});
			const midTurn = await hook("PreInvocation", unbound, sessionId, 3);
			expect(midTurn.injectSteps).toHaveLength(1);
			expect(
				daemon.service.registry.view(daemon.service.registry.get(id)!)
					.capabilities,
			).toMatchObject({ steer: true, wake: false });
			expect(midTurn.injectSteps[0].userMessage).toContain(
				"immediate hook message",
			);
			expect(daemon.service.store.receipt(urgent.message.id, id)).toMatchObject(
				{ state: "delivered", via: "native-hook" },
			);
			expect(daemon.service.store.receipt(staged.message.id, id)?.state).toBe(
				"queued",
			);
			const hookOnly = daemon.service.registry.get(id)!;
			daemon.service.registry.setStatus(hookOnly, "busy");
			const promoted = await send("promoted FYI for hook", "fyi");
			await daemon.service.queue.apply(
				{ kind: "human", login: "test", node: "test" },
				id,
				promoted.message.id,
				"promote",
				{ verified: true },
			);
			expect(
				(await hook("PreInvocation", unbound, sessionId, 4)).injectSteps,
			).toEqual([
				{ userMessage: expect.stringContaining("promoted FYI for hook") },
			]);
			expect(
				daemon.service.store.receipt(promoted.message.id, id),
			).toMatchObject({ state: "delivered", via: "native-hook" });
			daemon.service.registry.setStatus(
				daemon.service.registry.get(id)!,
				"idle",
			);
			const delivery = await Promise.all([
				hook("PreInvocation", unbound),
				hook("PreInvocation", unbound),
			]);
			expect(
				delivery.flatMap((d) => d.injectSteps ?? []).map((d) => d.userMessage),
			).toEqual([expect.stringContaining("hook test message")]);
			const alpha = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
			const beta = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
			const db = new DatabaseSync(
				join(directory, "..", "conversation_summaries.db"),
			);
			db.exec(
				"CREATE TABLE conversation_summaries(conversation_id TEXT, parent_conversation_id TEXT, title TEXT, last_modified_time TEXT, status TEXT, killed INTEGER)",
			);
			const insert = db.prepare(
				"INSERT INTO conversation_summaries VALUES (?,?,?,?,'CASCADE_RUN_STATUS_IDLE',0)",
			);
			for (const [key, parent] of [
				[alpha, sessionId],
				[beta, sessionId],
				[other, ""],
			] as const)
				insert.run(key, parent, key, new Date().toISOString());
			// Both children inherit the installed hook. Only the named invocation collects the text.
			await daemon.service.subagents.refresh(id);
			const dest = `${id}/sub:${beta}`;
			const stagedChild = await op.call<{
				message: { id: string };
				receipts: Receipt[];
			}>("send", {
				to: dest,
				body: "addressed child hook",
				priority: "urgent",
			});
			expect(stagedChild.receipts[0]?.state).toBe("queued");
			expect(
				await hook(
					"PreInvocation",
					{ ...unbound, ANTIGRAVITY_CONVERSATION_ID: alpha },
					alpha,
					1,
				),
			).toEqual({});
			expect(await hook("PreInvocation", unbound, sessionId, 1)).toEqual({});
			const collected = await hook(
				"PreInvocation",
				{ ...unbound, ANTIGRAVITY_CONVERSATION_ID: beta },
				beta,
				1,
			);
			expect(collected.injectSteps).toEqual([
				{ userMessage: expect.stringContaining("addressed child hook") },
			]);
			expect(
				daemon.service.store.receipt(stagedChild.message.id, dest),
			).toMatchObject({ state: "delivered", via: "native-hook" });
			const lost = await send("unconfirmed hook delivery", "urgent");
			const interrupted = new DaemonClient();
			await interrupted.connect(false);
			try {
				await interrupted.call("hello", {
					protocol: PROTOCOL_VERSION,
					registration: { ...reg, role: "cli" },
				});
				await expect(
					interrupted.call("native.hook.collect", {
						pid: reg.pid,
						sessionId: other,
						first: true,
					}),
				).rejects.toThrow("does not match");
				const claimed = await interrupted.call<{
					messages: Array<{ id: string }>;
				}>("native.hook.collect", { pid: reg.pid, sessionId, first: true });
				expect(claimed.messages.map((m) => m.id)).toEqual([lost.message.id]);
			} finally {
				interrupted.close();
			}
			await until(
				() =>
					daemon.service.store.receipt(lost.message.id, id)?.state === "nacked",
			);
			expect(await hook("PreInvocation", unbound)).toEqual({});
			const queued = await send("queued before bind");
			const fyi = await send("quiet FYI", "fyi");
			expect(queued.receipts[0]?.state).toBe("queued");
			await bus.connect(false);
			await expect(
				bus.call("hello", {
					protocol: PROTOCOL_VERSION,
					registration: { ...reg, role: "wake", sessionId: other },
				}),
			).rejects.toThrow("no longer running");
			await hook("PreInvocation", { EMPTY_METADATA: "1" }, sessionId, 3);
			await until(() => {
				try {
					return readFileSync(calls, "utf8").includes(
						"get-conversation-metadata",
					);
				} catch {
					return false;
				}
			}, 8000);
			expect(daemon.service.sessions.wakeFor(id)).toBeFalsy();
			await hook("PreInvocation", {}, sessionId, 3);
			await until(
				() =>
					daemon.service.store.receipt(queued.message.id, id)?.state ===
					"delivered",
				8000,
			);
			expect(
				daemon.service.registry.view(daemon.service.registry.get(id)!)
					.capabilities,
			).toMatchObject({ wake: true, steer: true, stop: false });
			await hook("PreInvocation", {}, sessionId, 3);
			expect(daemon.service.store.receipt(fyi.message.id, id)?.state).toBe(
				"queued",
			);
			const text = "Literal $(whoami)\n--option";
			expect((await send(text)).receipts[0]?.state).toBe("delivered");
			expect((await send("REJECT_FIXTURE")).receipts[0]?.state).toBe("queued");
			expect((await send("WRONG_RESPONSE")).receipts[0]?.state).toBe("queued");
			const sends = readFileSync(calls, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as string[])
				.filter((args) => args[1] === "send-message");
			expect(sends).toHaveLength(4);
			expect(sends.every((args) => args[2] === sessionId)).toBe(true);
			expect(sends[0]![3]).toContain("queued before bind");
			expect(sends[1]![3]).toContain(text);
			const tracked = daemon.service.registry.get(id)!;
			daemon.service.registry.setStatus(tracked, "busy");
			const during = await send("urgent parent while running", "urgent");
			expect(during.receipts[0]).toMatchObject({
				state: "queued",
				via: "pulsar-native-steer",
			});
			expect(
				(await hook("PreInvocation", unbound, sessionId, 4)).injectSteps,
			).toEqual([
				{ userMessage: expect.stringContaining("urgent parent while running") },
			]);
			expect(await hook("PreInvocation", unbound, sessionId, 5)).toEqual({});
			const finalInvocation = await send(
				"urgent missed final invocation",
				"urgent",
			);
			daemon.service.registry.setStatus(tracked, "idle");
			await until(
				() =>
					daemon.service.store.receipt(finalInvocation.message.id, id)?.via ===
					"native-wake",
			);
			expect(
				daemon.service.store.receipt(finalInvocation.message.id, id)?.state,
			).toBe("delivered");
			expect(readFileSync(calls, "utf8")).not.toContain(
				"urgent parent while running",
			);
			// A newer relay can address only descendants in the native index.
			const childReg = (key: string) => ({
				...reg,
				sessionId: key,
				meta: { nativeRootSessionId: sessionId, nativeToolContext: "1" },
			});
			const stranger = new DaemonClient();
			try {
				await stranger.connect(false);
				await expect(
					stranger.call("hello", {
						protocol: PROTOCOL_VERSION,
						registration: {
							...childReg(alpha),
							nativeHostToken: crypto.randomUUID(),
						},
					}),
				).rejects.toThrow("did not verify");
			} finally {
				stranger.close();
			}
			const own = await agentClient(childReg(alpha));
			try {
				expect(own.agent.id).toBe(`${id}/sub:${alpha}`);
				const dest = `${id}/sub:${beta}`;
				const response = await own.client.call<{
					message: { fromId: string };
					receipts: Receipt[];
				}>("send", { to: dest, body: "sibling test", priority: "urgent" });
				expect(response.message.fromId).toBe(own.agent.id);
				expect(response.receipts).toMatchObject([
					{ agentId: dest, state: "delivered", via: "native-wake" },
				]);
				expect(readFileSync(calls, "utf8")).toContain(
					`"send-message","${beta}"`,
				);
				const status = db.prepare(
					"UPDATE conversation_summaries SET status=? WHERE conversation_id=?",
				);
				status.run("CASCADE_RUN_STATUS_RUNNING", beta);
				await daemon.service.subagents.refresh(id);
				const busyChild = await own.client.call<{
					message: { id: string };
					receipts: Receipt[];
				}>("send", {
					to: dest,
					body: "urgent busy sibling",
					priority: "urgent",
				});
				expect(busyChild.receipts[0]).toMatchObject({
					state: "queued",
					via: "pulsar-native-steer",
				});
				expect(await hook("PreInvocation", unbound, sessionId, 4)).toEqual({});
				expect(
					(
						await hook(
							"PreInvocation",
							{ ...unbound, ANTIGRAVITY_CONVERSATION_ID: beta },
							beta,
							4,
						)
					).injectSteps,
				).toEqual([
					{ userMessage: expect.stringContaining("urgent busy sibling") },
				]);
				expect(readFileSync(calls, "utf8")).not.toContain(
					"urgent busy sibling",
				);
				const childBoundary = await own.client.call<{
					message: { id: string };
				}>("send", {
					to: dest,
					body: "sibling already finished turn",
					priority: "urgent",
				});
				status.run("CASCADE_RUN_STATUS_IDLE", beta);
				await daemon.service.subagents.refresh(id);
				await until(
					() =>
						daemon.service.store.receipt(childBoundary.message.id, dest)
							?.state === "delivered",
				);
				expect(
					daemon.service.store.receipt(childBoundary.message.id, dest)?.via,
				).toBe("native-wake");
				for (const [key, error] of [
					[alpha, "already has"],
					[other, "did not verify"],
				] as const) {
					const connection = new DaemonClient();
					try {
						await connection.connect(false);
						await expect(
							connection.call("hello", {
								protocol: PROTOCOL_VERSION,
								registration: childReg(key),
							}),
						).rejects.toThrow(error);
					} finally {
						connection.close();
					}
				}
				await expect(
					own.client.call("hello", {
						protocol: PROTOCOL_VERSION,
						registration: childReg(beta),
					}),
				).rejects.toThrow("different conversation");
				db.prepare(
					"UPDATE conversation_summaries SET killed=1 WHERE conversation_id=?",
				).run(beta);
				await daemon.service.subagents.refresh(id);
				expect(daemon.service.subagents.localTarget(dest)).toBeUndefined();
			} finally {
				own.client.close();
				db.close();
			}
			host.kill();
			daemon.service.sessions.wakeFor(id)?.close?.("test disconnect");
			await until(() => daemon.service.registry.get(id)?.reach === "pull");
			expect((await send("queued after disconnect")).receipts[0]?.state).toBe(
				"queued",
			);
		} finally {
			host.kill();
			mcp?.close();
			bus.close();
			op.close();
			await daemon.stop();
			restoreEnv("HOME", realHome);
			cleanup();
		}
	},
	30_000,
);
