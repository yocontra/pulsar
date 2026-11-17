import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Daemon } from "../src/daemon.ts";
import { LIMITS } from "../src/daemon.ts";
import type {
	DeliveredMessage,
	Message,
	PublicAgent,
	Receipt,
} from "../src/types.ts";
import {
	agentClient,
	operator,
	registration,
	startDaemon,
	until,
} from "./helpers.ts";

type SendResult = { message: Message; receipts: Receipt[] };

let daemon: Daemon;
const clients: Array<{ close: () => void }> = [];

beforeEach(async () => {
	({ daemon } = await startDaemon());
});

afterEach(async () => {
	for (const c of clients.splice(0)) c.close();
	await daemon.stop();
});

async function spawnAgent(over: Parameters<typeof registration>[0] = {}) {
	const a = await agentClient(registration(over));
	clients.push(a.client);
	return a;
}

describe("presence (goal 1)", () => {
	test("one list across harnesses", async () => {
		await spawnAgent({ harness: "pi", project: "apparish" });
		await spawnAgent({ harness: "omp", project: "apparish" });
		await spawnAgent({ harness: "codex", project: "billing", role: "mcp" });
		const op = await operator();
		clients.push(op);
		const all = await op.call<PublicAgent[]>("list", { selector: "*" });
		expect(all.map((a) => a.harness).sort()).toEqual(["codex", "omp", "pi"]);
	});

	test("names are unique and readable", async () => {
		const a = await spawnAgent({ harness: "pi", project: "apparish" });
		const b = await spawnAgent({ harness: "pi", project: "apparish" });
		expect(a.agent.name).toBe("pi@apparish");
		expect(b.agent.name).toBe("pi@apparish-2");
	});

	test("an agent that disconnects is gone", async () => {
		const a = await spawnAgent();
		const op = await operator();
		clients.push(op);
		a.client.close();
		await until(() => daemon.live().length === 0);
		expect(await op.call<PublicAgent[]>("list", {})).toHaveLength(0);
	});
});

describe("tags (goal 2)", () => {
	test("self-tags are visible to others and survive a reconnect", async () => {
		const a = await spawnAgent({ sessionId: "fixed-1" });
		await a.client.call("set_identity", {
			tagsAdd: ["workstream:auth"],
			summary: "fixing login",
		});
		const op = await operator();
		clients.push(op);
		const found = await op.call<PublicAgent[]>("list", {
			selector: "workstream=auth",
		});
		expect(found).toHaveLength(1);
		expect(found[0]!.summary).toBe("fixing login");

		a.client.close();
		await until(() => daemon.live().length === 0);
		const again = await spawnAgent({ sessionId: "fixed-1" });
		expect(again.agent.tags).toContain("workstream:auth");
	});
});

describe("multicast and broadcast (goals 3, 4)", () => {
	test("send to project=x reaches only that project", async () => {
		const sender = await spawnAgent({ project: "apparish" });
		const peer = await spawnAgent({ project: "apparish" });
		const other = await spawnAgent({ project: "billing" });
		const r = await sender.client.call<SendResult>("send", {
			to: "project=apparish",
			body: "migration done",
		});
		expect(r.receipts.map((x) => x.agentId)).toEqual([peer.agent.id]);
		await until(() => peer.pushes.length === 1);
		expect(peer.pushes[0]!.text).toContain("migration done");
		expect(peer.pushes[0]!.text).toContain("not from your user");
		expect(other.pushes).toHaveLength(0);
	});

	test("* reaches every other agent", async () => {
		const sender = await spawnAgent({ project: "a" });
		const b = await spawnAgent({ project: "b" });
		const c = await spawnAgent({ project: "c", harness: "omp" });
		const r = await sender.client.call<SendResult>("send", {
			to: "*",
			body: "main is frozen",
		});
		expect(r.message.to).toBe("*");
		expect(r.receipts).toHaveLength(2);
		await until(() => b.pushes.length === 1 && c.pushes.length === 1);
		expect(sender.pushes).toHaveLength(0);
	});

	test("operator can broadcast from the CLI", async () => {
		const b = await spawnAgent();
		const op = await operator();
		clients.push(op);
		const r = await op.call<SendResult>("send", { to: "*", body: "hello all" });
		expect(r.message.fromName).toBe("operator");
		await until(() => b.pushes.length === 1);
	});

	test("no match is an error, not a silent drop", async () => {
		const sender = await spawnAgent();
		await expect(
			sender.client.call("send", { to: "project=nope", body: "x" }),
		).rejects.toThrow(/no live agent/);
	});
});

describe("delivery rules", () => {
	test("pull-only agents get the message in their inbox", async () => {
		const sender = await spawnAgent();
		const pull = await spawnAgent({ harness: "cursor", role: "mcp" });
		const r = await sender.client.call<SendResult>("send", {
			to: pull.agent.name,
			body: "please review",
		});
		expect(r.receipts[0]!.state).toBe("queued");
		await until(() => pull.events.length === 1);
		const inbox = await pull.client.call<{ messages: DeliveredMessage[] }>(
			"inbox",
			{},
		);
		expect(inbox.messages.map((m) => m.body)).toEqual(["please review"]);
		const again = await pull.client.call<{ messages: DeliveredMessage[] }>(
			"inbox",
			{},
		);
		expect(again.messages).toHaveLength(0);
	});

	test("fyi never wakes: it waits in the inbox", async () => {
		const sender = await spawnAgent();
		const peer = await spawnAgent();
		const r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "fyi",
			priority: "fyi",
		});
		expect(r.receipts[0]!.state).toBe("queued");
		expect(peer.pushes).toHaveLength(0);
	});

	test("reply threads back to the sender, and ask/wait sees it", async () => {
		const asker = await spawnAgent();
		const answerer = await spawnAgent();
		const sent = await asker.client.call<SendResult>("send", {
			to: answerer.agent.name,
			body: "ready?",
			expectReply: true,
		});
		const waiting = asker.client.call<{
			event: string;
			message: DeliveredMessage;
		}>("wait", {
			for: `reply:${sent.message.id}`,
			timeoutSeconds: 5,
		});
		await answerer.client.call<SendResult>("reply", {
			messageId: sent.message.id,
			body: "yes",
		});
		const r = await waiting;
		expect(r.event).toBe("reply");
		expect(r.message.body).toBe("yes");
		expect(r.message.threadId).toBe(sent.message.threadId);
		const hist = await asker.client.call<{ receipts: Receipt[] }>("history", {
			messageId: sent.message.id,
		});
		expect(hist.receipts[0]!.state).toBe("replied");
	});

	test("wait for message resolves on the next message", async () => {
		const a = await spawnAgent();
		const b = await spawnAgent();
		const waiting = b.client.call<{ event: string; message: DeliveredMessage }>(
			"wait",
			{ timeoutSeconds: 5 },
		);
		await new Promise((r) => setTimeout(r, 30));
		await a.client.call("send", { to: b.agent.name, body: "ping" });
		const r = await waiting;
		expect(r.message.body).toBe("ping");
	});

	test("wait times out cleanly", async () => {
		const a = await spawnAgent();
		const r = await a.client.call<{ event: string }>("wait", {
			timeoutSeconds: 1,
		});
		expect(r.event).toBe("timeout");
	});

	test("idle notice", async () => {
		const a = await spawnAgent();
		const b = await spawnAgent();
		await b.client.call("set_status", { status: "busy" });
		const waiting = a.client.call<{ event: string }>("wait", {
			for: `idle:${b.agent.name}`,
			timeoutSeconds: 5,
		});
		await new Promise((r) => setTimeout(r, 30));
		await b.client.call("set_status", { status: "idle" });
		expect((await waiting).event).toBe("idle");
	});

	test("inbound refuse and hold", async () => {
		const sender = await spawnAgent();
		const peer = await spawnAgent();
		await peer.client.call("set_identity", { inbound: "refuse" });
		let r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "x",
		});
		expect(r.receipts[0]!.state).toBe("refused");
		await peer.client.call("set_identity", { inbound: "hold" });
		r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "held one",
		});
		expect(r.receipts[0]!.state).toBe("held");
		expect(peer.pushes).toHaveLength(0);
		await peer.client.call("set_identity", { inbound: "accept" });
		await until(() => peer.pushes.length === 1);
		expect(peer.pushes[0]!.message.body).toBe("held one");
	});

	test("sender identity comes from the connection, not the request", async () => {
		const sender = await spawnAgent();
		const peer = await spawnAgent();
		const r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "x",
			fromId: "claude:spoofed",
			fromName: "operator",
		});
		expect(r.message.fromId).toBe(sender.agent.id);
		expect(r.message.fromName).toBe(sender.agent.name);
	});

	test("rate limit on broadcasts", async () => {
		const sender = await spawnAgent();
		await spawnAgent();
		for (let i = 0; i < LIMITS.broadcastsPerMinute; i++)
			await sender.client.call("send", { to: "*", body: `n${i}` });
		await expect(
			sender.client.call("send", { to: "*", body: "one too many" }),
		).rejects.toThrow(/broadcasts a minute/);
	});

	test("inbox cap refuses past the limit", async () => {
		const pull = await spawnAgent({ harness: "cursor", role: "mcp" });
		const op = await operator();
		clients.push(op);
		for (let i = 0; i < LIMITS.inboxCap; i++)
			await op.call("send", {
				to: pull.agent.name,
				body: `m${i}`,
				priority: "fyi",
			});
		const r = await op.call<SendResult>("send", {
			to: pull.agent.name,
			body: "overflow",
			priority: "fyi",
		});
		expect(r.receipts[0]!.state).toBe("refused");
	}, 20_000);

	test("messages survive a daemon restart", async () => {
		const pull = await spawnAgent({
			harness: "cursor",
			role: "mcp",
			sessionId: "keep-1",
		});
		const op = await operator();
		await op.call("send", {
			to: pull.agent.name,
			body: "persisted",
			priority: "fyi",
		});
		op.close();
		pull.client.close();
		clients.length = 0;
		await daemon.stop();
		({ daemon } = await startDaemonAt(process.env.PULSAR_HOME!));
		const back = await spawnAgent({
			harness: "cursor",
			role: "mcp",
			sessionId: "keep-1",
		});
		const inbox = await back.client.call<{ messages: DeliveredMessage[] }>(
			"inbox",
			{},
		);
		expect(inbox.messages.map((m) => m.body)).toEqual(["persisted"]);
	});
});

async function startDaemonAt(home: string) {
	const { Daemon } = await import("../src/daemon.ts");
	const { join } = await import("node:path");
	const d = new Daemon({
		socket: join(home, "bus.sock"),
		db: join(home, "pulsar.db"),
		scan: false,
	});
	await d.start();
	return { daemon: d };
}

describe("identity safety", () => {
	test("no agent can take the operator name", async () => {
		const a = await spawnAgent();
		const r = await a.client.call<{ agent: PublicAgent }>("set_identity", {
			name: "operator",
		});
		expect(r.agent.name).not.toBe("operator");
	});

	test("a CLI call from inside an agent speaks as that agent", async () => {
		const agent = await spawnAgent({
			harness: "codex",
			role: "mcp",
			sessionId: "thread-1",
		});
		const peer = await spawnAgent();
		const { DaemonClient } = await import("../src/client.ts");
		const { PROTOCOL_VERSION } = await import("../src/types.ts");
		const cli = new DaemonClient();
		await cli.connect(false);
		clients.push(cli);
		await cli.call("hello", {
			protocol: PROTOCOL_VERSION,
			registration: registration({
				harness: "codex",
				role: "cli",
				sessionId: "thread-1",
			}),
		});
		const r = await cli.call<SendResult>("send", {
			to: peer.agent.name,
			body: "from my shell",
		});
		expect(r.message.fromId).toBe(agent.agent.id);
		cli.close();
		await new Promise((res) => setTimeout(res, 50));
		expect(daemon.live().some((a) => a.id === agent.agent.id)).toBe(true);
	});

	test("one MCP connection owns a session id", async () => {
		await spawnAgent({ harness: "codex", role: "mcp", sessionId: "thread-x" });
		await expect(
			agentClient(
				registration({ harness: "codex", role: "mcp", sessionId: "thread-x" }),
			),
		).rejects.toThrow(/already served/);
	});
});

describe("receipts", () => {
	test("extension pushes are sent, then delivered on ack", async () => {
		const sender = await spawnAgent();
		const peer = await spawnAgent();
		const r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "x",
		});
		expect(r.receipts[0]!.state).toBe("sent");
		await until(() => peer.pushes.length === 1);
		await peer.client.call("ack", { messageId: r.message.id });
		const h = await sender.client.call<{ receipts: Receipt[] }>("history", {
			messageId: r.message.id,
		});
		expect(h.receipts[0]!.state).toBe("delivered");
	});

	test("a nack puts the message back in the inbox", async () => {
		const sender = await spawnAgent();
		const peer = await spawnAgent();
		const r = await sender.client.call<SendResult>("send", {
			to: peer.agent.name,
			body: "retry me",
		});
		await peer.client.call("nack", { messageId: r.message.id, reason: "busy" });
		const inbox = await peer.client.call<{ messages: DeliveredMessage[] }>(
			"inbox",
			{},
		);
		expect(inbox.messages.map((m) => m.body)).toEqual(["retry me"]);
	});
});
