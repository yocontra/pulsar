import { expect, test } from "bun:test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
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
		process.env.HOME = realpathSync(home);
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
if (command !== "agentapi" || recipient !== process.env.ANTIGRAVITY_CONVERSATION_ID) process.exit(1);
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
		const bind = (extraEnv: NodeJS.ProcessEnv = {}) =>
			promisify(execFile)(process.execPath, [cli, "antigravity-bind"], {
				env: { ...env, ...extraEnv },
				timeout: 20_000,
			});
		const bus = new DaemonClient();
		const op = await operator();
		let mcp: DaemonClient | undefined;
		try {
			await once(host.stdout, "data");
			const reg = registration({
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
			await expect(bind({ EMPTY_METADATA: "1" })).rejects.toThrow(
				"could not verify",
			);
			await bind();
			await until(
				() =>
					daemon.service.store.receipt(queued.message.id, id)?.state ===
					"delivered",
				8000,
			);
			expect(
				daemon.service.registry.view(daemon.service.registry.get(id)!)
					.capabilities,
			).toMatchObject({ wake: true, stop: false });
			await bind();
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
