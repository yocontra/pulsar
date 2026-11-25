import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient } from "../src/client.ts";
import { PROTOCOL_VERSION, type Receipt } from "../src/types.ts";
import {
	agentClient,
	registration,
	restoreEnv,
	startDaemon,
	until,
} from "./helpers.ts";

test("a live OMP child has its own socket, selector, mailbox, and reply identity", async () => {
	const { daemon, home, cleanup } = await startDaemon();
	const originalHome = process.env.HOME;
	process.env.HOME = home;
	const sessionId = "0000dddd-1111-4222-8333-444455556666";
	const parentPid = process.pid;
	const cwd = join(home, "work");
	const parentLog = join(
		home,
		".omp",
		"agent",
		"sessions",
		"-work",
		`2026-11-10T10-00-00-000Z_${sessionId}.jsonl`,
	);
	const children = parentLog.slice(0, -".jsonl".length);
	const childLog = join(children, "Review.jsonl");
	const rec = (value: object) => `${JSON.stringify(value)}\n`;
	const connect = new DaemonClient();
	try {
		mkdirSync(children, { recursive: true });
		writeFileSync(
			parentLog,
			rec({ type: "title" }) + rec({ type: "session", id: sessionId, cwd }),
		);
		writeFileSync(
			childLog,
			rec({ type: "title" }) +
				rec({
					type: "session",
					id: "child-uuid",
					cwd,
					parentSession: parentLog,
				}),
		);
		const base = registration({
			harness: "omp",
			pid: parentPid,
			cwd,
			project: "omp-child",
			resumeKey: `omp:${sessionId}`,
		});
		const parent = await agentClient(base);
		const sender = await agentClient(registration({ name: "sender" }));
		let childClient: DaemonClient | undefined;
		try {
			await connect.connect(false);
			expect(
				await connect.call("hello", { protocol: PROTOCOL_VERSION }),
			).toMatchObject({ ompChildMessaging: true, agent: null });
			await expect(
				connect.call("hello", {
					protocol: PROTOCOL_VERSION,
					registration: {
						...base,
						subagent: { key: "Review", file: parentLog },
					},
				}),
			).rejects.toMatchObject({ code: "not_found" });
			const child = await agentClient({
				...base,
				capabilities: ["acks"],
				subagent: { key: "Review", file: childLog },
			});
			childClient = child.client;
			expect(child.agent.id).toBe(`${parent.agent.id}/sub:Review`);
			expect(child.agent.capabilities).toMatchObject({
				inbox: true,
				wake: true,
				stop: false,
				subagents: false,
			});
			expect(daemon.service.registry.live().map((a) => a.id)).not.toContain(
				child.agent.id,
			);
			expect(
				await sender.client.call("list", {
					selector: "name=Review project=omp-child",
				}),
			).toMatchObject([{ id: child.agent.id }]);
			await until(
				() =>
					daemon.service.subagents.cached(parent.agent.id)[0]?.messaging
						.mode === "direct",
			);
			const send = await sender.client.call<{ receipts: Receipt[] }>("send", {
				to: "name=Review project=omp-child",
				body: "fixture only",
				expectReply: true,
			});
			expect(send.receipts).toMatchObject([
				{ agentId: child.agent.id, state: "sent" },
			]);
			await until(() => child.pushes.length === 1);
			await child.client.call("msg.ack", {
				messageId: child.pushes[0]!.message.id,
			});
			expect(
				daemon.store.receipt(child.pushes[0]!.message.id, child.agent.id)
					?.state,
			).toBe("acked");
			expect(parent.pushes).toHaveLength(0);
			expect(await child.client.call("whoami")).toMatchObject({
				agent: { id: child.agent.id },
			});
			expect(
				await child.client.call("reply", {
					messageId: child.pushes[0]!.message.id,
					body: "fixture reply",
				}),
			).toMatchObject({
				message: { fromId: child.agent.id },
				receipts: [{ agentId: sender.agent.id, state: "sent" }],
			});
			await until(() => sender.pushes.length === 1);
			expect(sender.pushes[0]!.message.fromId).toBe(child.agent.id);
			child.client.close();
			await until(
				() =>
					daemon.service.subagents.cached(parent.agent.id)[0]?.messaging
						.mode === "parent",
			);
			await expect(
				sender.client.call("send", {
					to: child.agent.id,
					body: "must not reach parent",
				}),
			).rejects.toMatchObject({ code: "no_recipients" });
			expect(parent.pushes).toHaveLength(0);
		} finally {
			childClient?.close();
			parent.client.close();
			sender.client.close();
		}
	} finally {
		connect.close();
		await daemon.stop();
		restoreEnv("HOME", originalHome);
		cleanup();
	}
});
