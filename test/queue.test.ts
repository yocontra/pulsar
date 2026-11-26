/**
 * The queue strip (src/service/queue.ts): which messages to an agent are
 * not in its conversation yet, and withdraw / send now / edit with the
 * right state changes, receipts and authority.
 */
import { describe, expect, test } from "bun:test";
import type { Caller, Principal } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import type { Message, Registration } from "../src/types.ts";
import { registration } from "./helpers.ts";

const LOGIN = "me@example.com";
/** The operator in the app without a passkey session. */
const USER: Principal = { kind: "human", login: LOGIN, node: "iphone" };
/** The operator with a passkey session (Prove Human). */
const VERIFIED: Principal = { ...USER, verified: true };

function setup() {
	const store = new Store(":memory:");
	const service = new PulsarService({ store, scan: false, machine: "studio" });
	const connect = (
		role: "extension" | "mcp",
		over: Partial<Registration> = {},
	) => {
		const controller = new AbortController();
		const pushes: Array<{ message: Message; text: string }> = [];
		const notes: unknown[] = [];
		const caller: Caller = {
			principal: { kind: "terminal" },
			closed: controller.signal,
			emit: (event, data) => {
				if (event === "push")
					pushes.push(data as { message: Message; text: string });
				if (event === "message") notes.push(data);
			},
		};
		service.attach(caller);
		service.setRole(caller, role);
		const agent = service.registerAgent(
			caller,
			registration({ role, ...over }),
		);
		return { caller, agent, pushes, close: () => controller.abort() };
	};
	/** A send from the operator in the app (as POST /send). */
	const userSend = async (
		to: string,
		body: string,
		p: Principal = USER,
		priority: "urgent" | "normal" | "fyi" = "normal",
	) => {
		const r = (await service.app.send(p, {
			ids: [to],
			body,
			priority,
			dryRun: false,
		})) as { message: Message };
		return r.message;
	};
	return {
		store,
		service,
		connect,
		userSend,
		list: (agentId: string, p: Principal = USER) =>
			service.queue.list(p, agentId).then((l) => l.items),
		done: () => {
			service.stop();
			store.close();
		},
	};
}

describe("what the queue lists", () => {
	test("inbox-only messages wait for the next turn; a session that has one is not listed", async () => {
		const t = setup();
		try {
			// An MCP-only pi session: no push path, so messages wait in its inbox.
			const inbox = t.connect("mcp");
			const m = await t.userSend(inbox.agent.id, "hello there");
			const items = await t.list(inbox.agent.id);
			expect(items).toHaveLength(1);
			expect(items[0]).toMatchObject({
				messageId: m.id,
				state: "next-turn",
				mine: true,
				from: { name: "You" },
				canWithdraw: true,
				canEdit: true,
				canPromote: false,
				where: "home",
			});
			expect(items[0]!.why.promote).toContain("inbox");

			// An extension session that is idle: the message is pushed and in its conversation.
			const ext = t.connect("extension");
			await t.userSend(ext.agent.id, "straight in");
			expect(ext.pushes).toHaveLength(1);
			expect(await t.list(ext.agent.id)).toEqual([]);
		} finally {
			t.done();
		}
	});

	test("a message handed over during a busy turn waits for idle and can't be withdrawn", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension");
			const agent = t.service.registry.get(ext.agent.id)!;
			t.service.registry.setStatus(agent, "busy");
			await t.userSend(ext.agent.id, "after this turn");
			const [item] = await t.list(ext.agent.id);
			expect(item).toMatchObject({
				state: "idle",
				canWithdraw: false,
				canPromote: false,
				canEdit: false,
			});
			expect(item!.why.withdraw).toContain("current turn");
			await expect(
				t.service.queue.act(USER, ext.agent.id, item!.messageId, "withdraw"),
			).rejects.toMatchObject({ code: "conflict" });
			// Urgent ones land between tool calls: not listed.
			await t.userSend(ext.agent.id, "now", USER, "urgent");
			expect(await t.list(ext.agent.id)).toHaveLength(1);
			// The extension confirmed it is in the conversation: gone from the queue.
			t.service.mailbox.ack(agent, item!.messageId, "extension");
			expect(await t.list(ext.agent.id)).toEqual([]);
		} finally {
			t.done();
		}
	});

	test("busy steerable sessions retain editable next-turn messages until promotion or idle", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension", { capabilities: ["steer"] });
			const { registry, queue } = t.service;
			registry.idleSettleMs = 0;
			queue.start();
			const agent = registry.get(ext.agent.id)!;
			await t.service.handle(ext.caller, "set_status", { status: "busy" });
			const a = await t.userSend(agent.id, "first");
			const b = await t.userSend(agent.id, "old text");
			const c = await t.userSend(agent.id, "withdraw");
			const d = await t.userSend(agent.id, "last");
			await t.userSend(agent.id, "quiet", USER, "fyi");
			expect(ext.pushes).toHaveLength(0);
			expect(await t.list(agent.id)).toContainEqual(
				expect.objectContaining({
					messageId: a.id,
					canPromote: true,
					canWithdraw: true,
					canEdit: true,
				}),
			);
			await queue.act(USER, agent.id, b.id, "edit", { body: "edited" });
			await queue.act(USER, agent.id, c.id, "withdraw");
			await queue.act(USER, agent.id, a.id, "promote");
			expect(ext.pushes.map((p) => p.message.priority)).toEqual(["urgent"]);
			await t.service.handle(ext.caller, "set_status", { status: "idle" });
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(ext.pushes.map((p) => [p.message.id, p.message.body])).toEqual([
				[a.id, "first"],
				[b.id, "edited"],
				[d.id, "last"],
			]);
		} finally {
			t.done();
		}
	});

	test("urgent queued turns remain visible until the session accepts them", async () => {
		const t = setup();
		try {
			for (const via of ["extension", "codex-queue"]) {
				const ext = t.connect("extension", {
					sessionId: via,
					meta: via === "extension" ? { acp: "1" } : {},
				});
				const agent = t.service.registry.get(ext.agent.id)!;
				t.service.registry.setStatus(agent, "busy");
				const message = await t.userSend(
					agent.id,
					"while busy",
					USER,
					"urgent",
				);
				// Native Codex confirms queue submission with its own transport name.
				if (via === "codex-queue") {
					const receipt = t.store.receipt(message.id, agent.id)!;
					t.store.setReceipt({ ...receipt, via });
				}
				expect(await t.list(agent.id)).toMatchObject([
					{ messageId: message.id, state: "idle", canPromote: false },
				]);
				t.service.mailbox.ack(agent, message.id, via);
				expect(await t.list(agent.id)).toEqual([]);
			}
		} finally {
			t.done();
		}
	});

	test("held messages are listed as held; another agent's message is not editable", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension");
			const agent = t.service.registry.get(ext.agent.id)!;
			agent.inbound = "hold";
			const peer = t.connect("mcp", { harness: "codex" });
			const sender = t.service.registry.get(peer.agent.id)!;
			await t.service.mailbox.send(sender, {
				to: ext.agent.id,
				body: "from codex",
				priority: "normal",
				replyTo: null,
				expectReply: false,
			});
			const [item] = await t.list(ext.agent.id);
			expect(item).toMatchObject({
				state: "held",
				mine: false,
				canWithdraw: true,
				canPromote: true,
				canEdit: false,
			});
			expect(item!.why.edit).toContain("your own");
		} finally {
			t.done();
		}
	});
});

describe("withdraw", () => {
	test("the operator's own message: no proof needed, final receipt, out of the inbox", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const m = await t.userSend(inbox.agent.id, "never mind");
			const r = await t.service.queue.act(
				USER,
				inbox.agent.id,
				m.id,
				"withdraw",
			);
			expect(r.receipt).toMatchObject({ state: "withdrawn", via: "operator" });
			expect(await t.list(inbox.agent.id)).toEqual([]);
			const agent = t.service.registry.get(inbox.agent.id)!;
			expect(t.service.mailbox.inbox(agent, true, 10).messages).toEqual([]);
			// A second withdraw finds nothing waiting.
			await expect(
				t.service.queue.act(USER, inbox.agent.id, m.id, "withdraw"),
			).rejects.toMatchObject({ code: "conflict" });
			// Audited.
			expect(t.store.auditLog(10).some((a) => a.op === "queue.withdraw")).toBe(
				true,
			);
		} finally {
			t.done();
		}
	});

	test("another agent's ask: needs Prove Human; the asker stops waiting and gets a notice", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const asker = t.connect("extension", { harness: "pi" });
			const sender = t.service.registry.get(asker.agent.id)!;
			const sent = await t.service.mailbox.send(sender, {
				to: inbox.agent.id,
				body: "can you check the build?",
				priority: "normal",
				replyTo: null,
				expectReply: true,
			});
			const waiting = t.service.waiters.add(
				asker.caller,
				sender.id,
				"reply",
				sent.message.id,
				5000,
			);
			// Without a passkey session: refused, nothing changes.
			await expect(
				t.service.queue.act(USER, inbox.agent.id, sent.message.id, "withdraw"),
			).rejects.toMatchObject({ code: "session_required" });
			expect(await t.list(inbox.agent.id)).toHaveLength(1);
			// With one: withdrawn.
			const r = await t.service.queue.act(
				VERIFIED,
				inbox.agent.id,
				sent.message.id,
				"withdraw",
			);
			expect(r.receipt?.state).toBe("withdrawn");
			expect(await waiting).toMatchObject({ event: "withdrawn" });
			// The asker hears why: a notice from pulsar in its inbox.
			await new Promise((r) => setTimeout(r, 0));
			const notes = t.service.mailbox.inbox(sender, false, 10).messages;
			expect(
				notes.some((n) => n.body.includes("withdrawn by the operator")),
			).toBe(true);
		} finally {
			t.done();
		}
	});
});

describe("send now", () => {
	test("a held message is pushed at once as urgent", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension");
			const agent = t.service.registry.get(ext.agent.id)!;
			t.service.registry.setStatus(agent, "busy");
			agent.inbound = "hold";
			const m = await t.userSend(ext.agent.id, "this one matters");
			expect(ext.pushes).toHaveLength(0);
			const r = await t.service.queue.act(USER, ext.agent.id, m.id, "promote");
			expect(r.receipt?.state).toBe("sent");
			expect(ext.pushes).toHaveLength(1);
			expect(ext.pushes[0]!.message.priority).toBe("urgent");
			expect(await t.list(ext.agent.id)).toEqual([]);
		} finally {
			t.done();
		}
	});

	test("a don't-wake message to an extension session is pushed now", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension");
			const m = await t.userSend(ext.agent.id, "fyi", USER, "fyi");
			const [item] = await t.list(ext.agent.id);
			expect(item).toMatchObject({ state: "next-turn", canPromote: true });
			await t.service.queue.act(USER, ext.agent.id, m.id, "promote");
			expect(ext.pushes).toHaveLength(1);
		} finally {
			t.done();
		}
	});

	test("a promoted ACP message shows its urgent priority while the session is busy", async () => {
		const t = setup();
		try {
			const ext = t.connect("extension", { meta: { acp: "1" } });
			const agent = t.service.registry.get(ext.agent.id)!;
			t.service.registry.setStatus(agent, "busy");
			const m = await t.userSend(agent.id, "queued", USER, "fyi");
			await t.service.queue.act(USER, agent.id, m.id, "promote");
			expect(await t.list(agent.id)).toMatchObject([
				{ messageId: m.id, state: "idle", priority: "urgent" },
			]);
		} finally {
			t.done();
		}
	});

	test("an agent with no push path can't take it now", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const m = await t.userSend(inbox.agent.id, "hi");
			await expect(
				t.service.queue.act(USER, inbox.agent.id, m.id, "promote"),
			).rejects.toMatchObject({ code: "unsupported" });
		} finally {
			t.done();
		}
	});
});

describe("edit", () => {
	test("the operator's own message before delivery; the agent reads the new text", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const m = await t.userSend(inbox.agent.id, "frist draft");
			await t.service.queue.act(USER, inbox.agent.id, m.id, "edit", {
				body: "  first draft  ",
			});
			const agent = t.service.registry.get(inbox.agent.id)!;
			const read = t.service.mailbox.inbox(agent, true, 10).messages;
			expect(read.map((x) => x.body)).toEqual(["first draft"]);
			// Read now: no longer editable.
			await expect(
				t.service.queue.act(USER, inbox.agent.id, m.id, "edit", {
					body: "again",
				}),
			).rejects.toMatchObject({ code: "conflict" });
		} finally {
			t.done();
		}
	});

	test("never another sender's message, and never an empty body", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const peer = t.connect("mcp", { harness: "codex" });
			const sent = await t.service.mailbox.send(
				t.service.registry.get(peer.agent.id)!,
				{
					to: inbox.agent.id,
					body: "codex here",
					priority: "normal",
					replyTo: null,
					expectReply: false,
				},
			);
			await expect(
				t.service.queue.act(VERIFIED, inbox.agent.id, sent.message.id, "edit", {
					body: "changed",
				}),
			).rejects.toMatchObject({ code: "forbidden" });
			const mine = await t.userSend(inbox.agent.id, "mine");
			await expect(
				t.service.queue.act(USER, inbox.agent.id, mine.id, "edit", {
					body: "   ",
				}),
			).rejects.toMatchObject({ code: "bad_request" });
		} finally {
			t.done();
		}
	});

	test("a group send is editable only while no recipient has it", async () => {
		const t = setup();
		try {
			const a = t.connect("mcp");
			const b = t.connect("extension");
			const r = (await t.service.app.send(USER, {
				ids: [a.agent.id, b.agent.id],
				body: "both of you",
				priority: "normal",
				dryRun: false,
			})) as { message: Message };
			// b's extension took it: the message is no longer editable for a.
			const [item] = await t.list(a.agent.id);
			expect(item).toMatchObject({ canEdit: false, canWithdraw: true });
			await expect(
				t.service.queue.act(USER, a.agent.id, r.message.id, "edit", {
					body: "x",
				}),
			).rejects.toMatchObject({ code: "conflict" });
		} finally {
			t.done();
		}
	});
});

describe("authority", () => {
	test("an agent can't read or act on another agent's queue", async () => {
		const t = setup();
		try {
			const inbox = t.connect("mcp");
			const other = t.connect("mcp", { harness: "codex" });
			const m = await t.userSend(inbox.agent.id, "hi");
			const asAgent: Principal = { kind: "agent", agentId: other.agent.id };
			await expect(
				t.service.queue.list(asAgent, inbox.agent.id),
			).rejects.toBeDefined();
			await expect(
				t.service.queue.act(asAgent, inbox.agent.id, m.id, "withdraw"),
			).rejects.toBeDefined();
			expect(await t.list(inbox.agent.id)).toHaveLength(1);
		} finally {
			t.done();
		}
	});
});
