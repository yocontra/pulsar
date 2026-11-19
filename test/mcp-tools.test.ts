/**
 * The consolidated MCP tools (list_agents, send, respond, wait, inbox,
 * set_identity): `respond` drives the same delivery states as the 1.x
 * ack/done/nack/reply tools, `send await_reply` is `ask`, and the 1.x names
 * still work as hidden aliases.
 */
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { DaemonClient } from "../src/client.ts";
import type { Daemon } from "../src/daemon.ts";
import type { Message, Receipt } from "../src/types.ts";
import { agentClient, registration, startDaemon, until } from "./helpers.ts";
import { runtimeBinary } from "./mem-harness.ts";

/** The real node (a version-manager shim needs the real HOME). */
const NODE = runtimeBinary("node");

setDefaultTimeout(30_000);

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let daemon: Daemon;
let home: string;
let cleanup: () => void;
const clients: Client[] = [];
const peers: DaemonClient[] = [];

beforeAll(async () => {
	({ daemon, home, cleanup } = await startDaemon());
});

afterAll(async () => {
	for (const c of clients) await c.close();
	for (const p of peers) p.close();
	await daemon.stop();
	cleanup();
});

async function mcp(sessionId: string) {
	const transport = new StdioClientTransport({
		command: NODE,
		args: [cli, "mcp"],
		cwd: "/tmp",
		env: {
			...(process.env as Record<string, string>),
			HOME: home,
			PULSAR_HOME: home,
			PULSAR_HARNESS: "codex",
			PULSAR_SESSION_ID: sessionId,
			PULSAR_NO_SCAN: "1",
		},
		stderr: "ignore",
	});
	const client = new Client({ name: "tools-test", version: "0" });
	await client.connect(transport);
	clients.push(client);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const r = (await client.callTool({ name, arguments: args })) as {
			content: { text: string }[];
			isError?: boolean;
		};
		return { text: r.content.map((c) => c.text).join("\n"), err: !!r.isError };
	};
	const me = await call("set_identity");
	const id = /\(([^)]+)\)/.exec(me.text)![1]!;
	return { client, call, id };
}

/** A fake agent that asks the MCP agent things and reads the receipts. */
async function asker() {
	const a = await agentClient(
		registration({ sessionId: `asker-${peers.length}` }),
	);
	peers.push(a.client);
	const ask = async (to: string, body: string) =>
		(
			await a.client.call<{ message: Message }>("send", {
				to,
				body,
				expectReply: true,
			})
		).message.id;
	const receipt = async (id: string) =>
		(
			await a.client.call<{ receipts: Receipt[] }>("history", {
				messageId: id,
			})
		).receipts[0]!;
	return { ...a, ask, receipt };
}

describe("tool list", () => {
	test("six tools listed; the 1.x names are hidden but callable", async () => {
		const { client, call } = await mcp("tools-list");
		const listed = (await client.listTools()).tools.map((t) => t.name);
		expect(listed).toEqual([
			"list_agents",
			"send",
			"respond",
			"inbox",
			"wait",
			"set_identity",
		]);
		const respond = (await client.listTools()).tools.find(
			(t) => t.name === "respond",
		)!;
		expect(respond.inputSchema.required).toEqual(["message_id", "state"]);
		expect(
			(respond.inputSchema.properties as Record<string, { enum?: string[] }>)
				.state?.enum,
		).toEqual(["working", "reply", "done", "declined"]);
		for (const [name, args] of [
			["whoami", {}],
			["who", { question: "who is on nothing" }],
			["history", { query: "zzz" }],
			["ack", { message_id: "m_nope" }],
			["done", { message_id: "m_nope" }],
			["nack", { message_id: "m_nope", reason: "x" }],
			["reply", { message_id: "m_nope", body: "x" }],
			["ask", { to: "nobody-here", body: "q", timeout_seconds: 5 }],
		] as const) {
			const r = await call(name, args);
			expect({
				name,
				notFound:
					r.text.includes("not found") && r.text.includes(`Tool ${name}`),
			}).toEqual({ name, notFound: false });
		}
	});
});

describe("respond", () => {
	test("working → acked, reply → replied (and the asker gets the answer)", async () => {
		const b = await mcp("resp-a");
		const a = await asker();
		const id = await a.ask(b.id, "can you check the build?");
		const w = await b.call("respond", { message_id: id, state: "working" });
		expect(w.text).toContain(`Working on ${id}`);
		expect((await a.receipt(id)).state).toBe("acked");
		const r = await b.call("respond", {
			message_id: id,
			state: "reply",
			text: "build is green",
		});
		expect(r.text).toMatch(/Replied with m_/);
		expect((await a.receipt(id)).state).toBe("replied");
		await until(() => a.events.some((m) => m.body === "build is green"));
	});

	test("done with text → done, and the text reaches the sender as the reply", async () => {
		const b = await mcp("resp-b");
		const a = await asker();
		const id = await a.ask(b.id, "rebase please");
		await b.call("respond", { message_id: id, state: "working" });
		const d = await b.call("respond", {
			message_id: id,
			state: "done",
			text: "rebased on main",
		});
		expect(d.text).toContain(`Marked ${id} done and sent the result`);
		expect((await a.receipt(id)).state).toBe("done");
		await until(() => a.events.some((m) => m.body === "rebased on main"));
	});

	test("done without text → done, nothing sent", async () => {
		const b = await mcp("resp-c");
		const a = await asker();
		const id = await a.ask(b.id, "tidy up");
		const d = await b.call("respond", { message_id: id, state: "done" });
		expect(d.text).toBe(`Marked ${id} done.`);
		expect((await a.receipt(id)).state).toBe("done");
	});

	test("declined → nacked with the reason; retry → queued again", async () => {
		const b = await mcp("resp-d");
		const a = await asker();
		const id = await a.ask(b.id, "deploy prod");
		const n = await b.call("respond", {
			message_id: id,
			state: "declined",
			text: "no prod access",
		});
		expect(n.text).toContain(`Declined ${id} (nacked)`);
		const r = await a.receipt(id);
		expect(r.state).toBe("nacked");
		expect(r.result).toBe("no prod access");

		const id2 = await a.ask(b.id, "try later");
		const n2 = await b.call("respond", {
			message_id: id2,
			state: "declined",
			text: "busy",
			retry: true,
		});
		expect(n2.text).toContain("will come back to you later");
		expect((await a.receipt(id2)).state).toBe("queued");
	});

	test("reply and declined need text; bad states are refused", async () => {
		const b = await mcp("resp-e");
		const a = await asker();
		const id = await a.ask(b.id, "q");
		const r1 = await b.call("respond", { message_id: id, state: "reply" });
		expect(r1).toEqual({
			err: true,
			text: "pulsar: reply needs text: the answer",
		});
		const r2 = await b.call("respond", {
			message_id: id,
			state: "declined",
			text: "  ",
		});
		expect(r2.err).toBe(true);
		const r3 = await b.call("respond", { message_id: id, state: "maybe" });
		expect(r3.err).toBe(true);
		expect(r3.text).toContain("Invalid option");
		// Nothing changed the receipt.
		expect((await a.receipt(id)).state).not.toBe("replied");
	});

	test("the hidden 1.x tools give the same states", async () => {
		const b = await mcp("resp-f");
		const a = await asker();
		const id = await a.ask(b.id, "x");
		await b.call("ack", { message_id: id });
		expect((await a.receipt(id)).state).toBe("acked");
		await b.call("done", { message_id: id });
		expect((await a.receipt(id)).state).toBe("done");
		const id2 = await a.ask(b.id, "y");
		await b.call("nack", { message_id: id2, reason: "no" });
		expect((await a.receipt(id2)).state).toBe("nacked");
	});
});

describe("send await_reply, list_agents question, inbox history, set_identity", () => {
	test("send await_reply=true blocks for the reply (ask)", async () => {
		const b = await agentClient(registration({ sessionId: "await-b" }));
		peers.push(b.client);
		const a = await mcp("await-a");
		const pending = a.call("send", {
			to: b.agent.id,
			body: "what branch are you on?",
			await_reply: true,
			timeout_seconds: 20,
		});
		await until(() => b.pushes.length > 0, 10_000);
		await b.client.call("reply", {
			messageId: b.pushes[0]!.message.id,
			body: "main",
		});
		const got = await pending;
		expect(got.text).toContain("Reply from");
		expect(got.text).toContain("main");
	});

	test("send await_reply times out with the delivery", async () => {
		const silent = await agentClient(registration({ sessionId: "silent" }));
		peers.push(silent.client);
		const a = await mcp("await-t");
		const r = await a.call("send", {
			to: silent.agent.id,
			body: "?",
			await_reply: true,
			timeout_seconds: 5,
		});
		expect(r.text).toMatch(/^No reply to m_\S+ within 5s\. Delivery:/);
		expect(silent.pushes).toHaveLength(1);
		expect(silent.pushes[0]!.message.priority).toBe("urgent");
		expect(silent.pushes[0]!.message.expectReply).toBe(true);
	});

	test("list_agents question looks up; inbox query searches history", async () => {
		const a = await mcp("q-a");
		const q = await a.call("list_agents", {
			question: "who is editing src/nowhere.ts",
		});
		expect(q.text).toContain("Nobody matches");
		const peer = await asker();
		await peer.client.call("send", {
			to: a.id,
			body: "needle7781 in a haystack",
		});
		const h = await a.call("inbox", { query: "needle7781" });
		expect(h.text).toContain("needle7781");
		const none = await a.call("inbox", { query: "zzz-not-there" });
		expect(none.text).toBe("No messages found.");
	});

	test("set_identity sets and returns the identity; no arguments only reads", async () => {
		const a = await mcp("ident");
		const r = await a.call("set_identity", {
			activity: "reviewing PR #9",
			tags_add: ["role:reviewer"],
		});
		expect(r.text).toContain("activity: reviewing PR #9");
		expect(r.text).toContain("role:reviewer");
		expect(r.text).toMatch(/unread: \d+/);
		const again = await a.call("set_identity");
		expect(again.text).toContain("activity: reviewing PR #9");
	});
});
