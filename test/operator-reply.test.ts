/**
 * An agent in any harness can answer the human operator: it finds the
 * operator's pushed message again by id, `send` to a name for the operator
 * or their device reaches them as a reply (or says how to answer), and
 * command-style clients get the main arguments as positionals.
 */
import { describe, expect, test } from "bun:test";
import { schema as $, McpStdioServer } from "../src/mcp-server.ts";
import type { Caller, Principal } from "../src/service/caller.ts";
import { PulsarService } from "../src/service/index.ts";
import { Store } from "../src/store.ts";
import type { Message, Receipt } from "../src/types.ts";
import { registration } from "./helpers.ts";

/** The operator with a passkey session, sending from their phone. */
const USER: Principal = {
	kind: "human",
	login: "ada@example.com",
	node: "iphone-13-mini",
	verified: true,
	name: "Ada Lovelace",
};

type Sent = { message: Message; receipts: Receipt[] };

function setup() {
	const store = new Store(":memory:");
	const service = new PulsarService({ store, scan: false, machine: "studio" });
	const connect = (over: Parameters<typeof registration>[0] = {}) => {
		const controller = new AbortController();
		const pushes: Array<{ text: string }> = [];
		const caller: Caller = {
			principal: { kind: "terminal" },
			closed: controller.signal,
			emit: (event, data) => {
				if (event === "push") pushes.push(data as { text: string });
			},
		};
		service.attach(caller);
		service.setRole(caller, "extension");
		const agent = service.registerAgent(caller, registration(over));
		return { caller, agent, pushes };
	};
	const fromOperator = async (agentId: string, body: string) => {
		const sent = await service.app.send(USER, { ids: [agentId], body });
		if (sent.dryRun) throw new Error("expected a send");
		return sent.message;
	};
	return {
		store,
		service,
		connect,
		fromOperator,
		done: () => {
			service.stop();
			store.close();
		},
	};
}

describe("inbox finds a pushed operator message by id", () => {
	test("query=<id> and message_id=<id> show it after delivery", async () => {
		const t = setup();
		const a = t.connect({ sessionId: "omp-1", harness: "omp" });
		const m = await t.fromOperator(a.agent.id, "status?");
		expect(a.pushes[0]?.text).toContain(`reply: respond ${m.id}`);
		// The session took the push: it is delivered, no longer unread.
		await t.service.handle(a.caller, "ack", { messageId: m.id });
		expect(t.store.receipt(m.id, a.agent.id)?.state).toBe("delivered");
		const unread = (await t.service.handle(a.caller, "inbox", {})) as {
			messages: Message[];
		};
		expect(unread.messages).toEqual([]);

		for (const p of [
			{ query: m.id },
			{ query: ` ${m.id} ` },
			{ messageId: m.id },
		]) {
			const r = (await t.service.handle(a.caller, "history", p)) as {
				messages: Message[];
			};
			expect(r.messages.map((x) => x.id)).toContain(m.id);
		}
		// Plain text still searches bodies.
		const byText = (await t.service.handle(a.caller, "history", {
			query: "status",
		})) as { messages: Message[] };
		expect(byText.messages.map((x) => x.id)).toEqual([m.id]);
		t.done();
	});

	test("another agent cannot read it by id", async () => {
		const t = setup();
		const a = t.connect({ sessionId: "a1" });
		const b = t.connect({ sessionId: "b1" });
		const m = await t.fromOperator(a.agent.id, "for a only");
		await expect(
			t.service.handle(b.caller, "history", { query: m.id }),
		).rejects.toMatchObject({ code: "not_found" });
		t.done();
	});
});

describe("send to the operator by name", () => {
	for (const to of [
		"operator",
		"human",
		"user",
		"Operator",
		"iphone-13-mini",
		"ada@example.com",
		"@ada",
		"Ada Lovelace",
	])
		test(`"${to}" is a reply to their latest message`, async () => {
			const t = setup();
			const a = t.connect({ sessionId: `s-${to}` });
			await t.fromOperator(a.agent.id, "first");
			const latest = await t.fromOperator(a.agent.id, "second");
			const r = (await t.service.handle(a.caller, "send", {
				to,
				body: "all green",
			})) as Sent;
			expect(r.message).toMatchObject({
				to: "user:ada@example.com",
				replyTo: latest.id,
				fromId: a.agent.id,
				body: "all green",
			});
			expect(r.receipts).toMatchObject([
				{ agentId: "user:ada@example.com", state: "queued" },
			]);
			// The app shows it as the agent's reply in that thread, not as the operator's.
			const shown = t.service.app.receipts(USER, latest.id, {});
			expect(shown.replies.map((m) => [m.body, m.from.name])).toEqual([
				["all green", a.agent.name],
			]);
			t.done();
		});

	test("with no operator message yet, the error says to use respond", async () => {
		const t = setup();
		const a = t.connect({ sessionId: "n1" });
		await expect(
			t.service.handle(a.caller, "send", { to: "operator", body: "hi" }),
		).rejects.toMatchObject({
			code: "no_recipients",
			message: expect.stringContaining(
				"To answer the operator, use respond <message id> state=reply",
			),
		});
		t.done();
	});

	test("an unknown name lists the operator's message ids when there are any", async () => {
		const t = setup();
		const a = t.connect({ sessionId: "u1" });
		await expect(
			t.service.handle(a.caller, "send", { to: "nobody-here", body: "x" }),
		).rejects.toThrow(
			'no live agent matches "nobody-here". Call list_agents to see who is online.',
		);
		const m = await t.fromOperator(a.agent.id, "ping");
		const err = await t.service
			.handle(a.caller, "send", { to: "some-laptop", body: "x" })
			.catch((e: Error) => e);
		expect((err as Error).message).toContain(
			`use respond <message id> state=reply text=<answer> (their latest messages to you: ${m.id})`,
		);
		t.done();
	});

	test("a live agent with the name still wins", async () => {
		const t = setup();
		const a = t.connect({ sessionId: "w1" });
		const b = t.connect({ sessionId: "w2", name: "iphone-13-mini" });
		await t.fromOperator(a.agent.id, "hi");
		const r = (await t.service.handle(a.caller, "send", {
			to: b.agent.name,
			body: "to the agent",
		})) as Sent;
		expect(r.receipts.map((x) => x.agentId)).toEqual([b.agent.id]);
		t.done();
	});

	test("an agent cannot take a reserved operator name", () => {
		const t = setup();
		const a = t.connect({ sessionId: "r1", name: "operator" });
		expect(a.agent.name).not.toBe("operator");
		t.done();
	});
});

/** omp's rule: required scalar top-level fields are positionals, in `required` order. */
function ompPositionals(s: {
	properties: Record<string, { type: string; enum?: unknown }>;
	required?: string[];
}): string[] {
	return (s.required ?? []).filter((k) => {
		const p = s.properties[k];
		return (
			!!p &&
			(p.enum !== undefined ||
				p.type === "string" ||
				p.type === "integer" ||
				p.type === "number")
		);
	});
}

describe("positionals for command-style clients", () => {
	function server(cliArgs: boolean) {
		const s = new McpStdioServer({ name: "t", version: "0" }, "");
		s.cliArgs = cliArgs;
		s.tool({
			name: "list_agents",
			title: "",
			description: "",
			inputSchema: $.object({ selector: $.str(), include_gone: $.bool() }),
			positional: ["selector"],
			handler: async (args: never) => ({
				content: [{ type: "text", text: JSON.stringify(args) }],
			}),
		});
		s.tool({
			name: "respond",
			title: "",
			description: "",
			inputSchema: $.object(
				{
					message_id: $.str({ min: 1 }),
					state: $.oneOf(["working", "reply"]),
					text: $.str(),
				},
				["message_id", "state"],
			),
			positional: ["message_id", "state", "text"],
			handler: async (args: never) => ({
				content: [{ type: "text", text: JSON.stringify(args) }],
			}),
		});
		return s as unknown as {
			handle(m: string, p: Record<string, unknown>): Promise<unknown>;
			cliArgs: boolean;
		};
	}
	type Listed = {
		tools: Array<{
			name: string;
			inputSchema: Parameters<typeof ompPositionals>[0];
		}>;
	};
	const schemaOf = (l: Listed, name: string) =>
		l.tools.find((t) => t.name === name)?.inputSchema ?? { properties: {} };

	test("omp sees selector and message_id, state, text as positionals", async () => {
		const s = server(true);
		const l = (await s.handle("tools/list", {})) as Listed;
		expect(ompPositionals(schemaOf(l, "list_agents"))).toEqual(["selector"]);
		expect(ompPositionals(schemaOf(l, "respond"))).toEqual([
			"message_id",
			"state",
			"text",
		]);
		// Calls still validate against the real schema: no selector is fine.
		const r = (await s.handle("tools/call", {
			name: "list_agents",
			arguments: {},
		})) as { isError?: boolean };
		expect(r.isError).toBeUndefined();
	});

	test("other clients keep the optional arguments optional", async () => {
		const s = server(false);
		const l = (await s.handle("tools/list", {})) as Listed;
		expect(schemaOf(l, "list_agents").required).toBeUndefined();
		expect(schemaOf(l, "respond").required).toEqual(["message_id", "state"]);
	});

	test("omp's clientInfo turns it on", async () => {
		const s = server(false);
		await s.handle("initialize", {
			protocolVersion: "2025-06-18",
			clientInfo: { name: "omp-coding-agent", version: "1.0.0" },
		});
		expect(s.cliArgs).toBe(true);
		const other = server(false);
		await other.handle("initialize", {
			clientInfo: { name: "claude-code", version: "1" },
		});
		expect(other.cliArgs).toBe(false);
	});
});
