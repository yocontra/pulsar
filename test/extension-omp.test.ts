import { expect, test } from "bun:test";
import {
	type OmpChildContext,
	type OmpChildTool,
	ompChildMessaging,
} from "../src/extension-omp.ts";

const context = (key: string): OmpChildContext => ({
	agent: { kind: "sub" },
	cwd: "/work",
	sessionManager: { getSessionFile: () => `/sessions/parent/${key}.jsonl` },
});

function fixture(key: string, supported = true, identified = true) {
	const calls: { method: string; params: unknown }[] = [];
	const tools = new Map<string, OmpChildTool>();
	const received: { content: string; deliverAs: string }[] = [];
	const events = new Map<string, (data: unknown) => void>();
	const closed = new Set<() => void>();
	const agent = {
		id: identified ? `omp:pid:42/sub:${key}` : "omp:pid:42",
		name: key,
		harness: "omp",
		tags: [],
	};
	let failDelivery = false;
	const client = {
		connected: false,
		async connect() {
			this.connected = true;
			return this;
		},
		async call<T>(method: string, params?: unknown): Promise<T> {
			calls.push({ method, params });
			if (method === "hello") {
				const registration = (params as { registration?: unknown })
					.registration;
				return (
					registration
						? {
								agent,
							}
						: { ompChildMessaging: supported }
				) as T;
			}
			if (method === "whoami" || method === "set_identity")
				return { agent, unread: 0 } as T;
			if (method === "list") return [] as T;
			if (method === "inbox") return { messages: [], held: 0 } as T;
			if (method === "wait") return { event: "timeout" } as T;
			return { message: { id: `m_${key}` }, receipts: [] } as T;
		},
		on(event: string, fn: (data: unknown) => void) {
			events.set(event, fn);
		},
		onClose(fn: () => void) {
			closed.add(fn);
		},
		close() {
			this.connected = false;
			for (const fn of closed) fn();
		},
	};
	const child = ompChildMessaging(
		{
			typebox: {
				Type: {
					Object: (props) => props,
					String: () => ({ type: "string" }),
					Integer: () => ({ type: "integer" }),
					Boolean: () => ({ type: "boolean" }),
					Literal: (v) => v,
					Union: (v) => v,
					Optional: (v) => v,
					Array: (item) => [item],
				},
			},
			registerTool: (tool) => tools.set(tool.name, tool),
			getAllTools: () => [{ name: "alias", mcpServerName: "pulsar" }],
			async sendMessage(message, options) {
				if (failDelivery) throw new Error("child is closing");
				received.push({
					content: message.content,
					deliverAs: options.deliverAs,
				});
			},
		},
		client,
	);
	return {
		child,
		calls,
		tools,
		received,
		failDelivery: () => {
			failDelivery = true;
		},
		push: (id: string) =>
			events.get("push")?.({
				message: { id, from: { name: "operator" }, priority: "urgent" },
				text: `frame ${id}`,
			}),
	};
}

test("OMP children use separate hello identities, delivery and outgoing messages", async () => {
	const a = fixture("A");
	const b = fixture("B");
	try {
		await Promise.all([
			a.child.start(context("A")),
			b.child.start(context("B")),
		]);
		for (const [key, f] of [
			["A", a],
			["B", b],
		] as const) {
			expect(f.calls[1]).toMatchObject({
				method: "hello",
				params: {
					registration: {
						harness: "omp",
						subagent: { key, file: `/sessions/parent/${key}.jsonl` },
					},
				},
			});
		}
		a.push("m_first");
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(a.received).toEqual([
			{ content: "frame m_first", deliverAs: "steer" },
		]);
		expect(b.received).toEqual([]);
		expect(a.calls.at(-1)).toEqual({
			method: "ack",
			params: { messageId: "m_first", via: "extension" },
		});
		b.failDelivery();
		b.push("m_second");
		await new Promise<void>((resolve) => queueMicrotask(resolve));
		expect(b.calls.at(-1)).toEqual({
			method: "nack",
			params: { messageId: "m_second", reason: "child is closing" },
		});

		const response = a.tools.get("pulsar_respond")!;
		await response.execute(
			"call",
			{ message_id: "m_first", text: "answer" },
			undefined,
			undefined,
			context("A"),
		);
		expect(a.calls.find((call) => call.method === "reply")).toEqual({
			method: "reply",
			params: { messageId: "m_first", body: "answer", priority: undefined },
		});
		const priorCount = a.calls.length;
		await response.execute(
			"call",
			{ message_id: "m_second", text: "wrong session" },
			undefined,
			undefined,
			context("B"),
		);
		expect(a.calls).toHaveLength(priorCount);
		await b.tools
			.get("pulsar_send")!
			.execute(
				"call",
				{ to: "codex", body: "hello" },
				undefined,
				undefined,
				context("B"),
			);
		expect(b.calls.find((call) => call.method === "send")).toMatchObject({
			method: "send",
			params: { to: "codex", body: "hello" },
		});
		for (const [tool, input, method] of [
			["list_agents", { selector: "project=pulsar" }, "list"],
			["inbox", { limit: 3 }, "inbox"],
			["wait", { timeout_seconds: 1 }, "wait"],
			["set_identity", { activity: "Testing" }, "set_identity"],
		] as const) {
			const output = await a.tools
				.get(`pulsar_${tool}`)!
				.execute("call", input, undefined, undefined, context("A"));
			expect(output.isError).toBeUndefined();
			expect(a.calls.some((call) => call.method === method)).toBe(true);
			expect(b.calls.some((call) => call.method === method)).toBe(false);
		}

		for (const toolName of ["mcp__pulsar_send", "alias"]) {
			expect(a.child.blockParentMcp({ toolName }, context("A"))).toMatchObject({
				block: true,
			});
			expect(
				a.child.blockParentMcp({ toolName }, { agent: { kind: "main" } }),
			).toBeUndefined();
		}
		expect(
			a.child.blockParentMcp({ toolName: "pulsar_send" }, context("A")),
		).toBeUndefined();
		expect(
			a.child.blockParentMcp(
				{ toolName: "read", input: { path: "mcp://pulsar://inbox" } },
				context("A"),
			),
		).toMatchObject({ block: true });
	} finally {
		a.child.stop();
		b.child.stop();
	}
});

test("OMP children refuse old daemons and never send or accept pushes on an unverified identity", async () => {
	for (const [supported, identified, expectedCalls] of [
		[false, false, 1],
		[true, false, 2],
	] as const) {
		const f = fixture("A", supported, identified);
		try {
			await f.child.start(context("A"));
			f.push("m_wrong");
			await f.tools
				.get("pulsar_send")!
				.execute(
					"call",
					{ to: "someone", body: "test" },
					undefined,
					undefined,
					context("A"),
				);
			expect(f.calls).toHaveLength(expectedCalls);
			expect(f.received).toEqual([]);
		} finally {
			f.child.stop();
		}
	}
});
