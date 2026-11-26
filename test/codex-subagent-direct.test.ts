import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codex } from "../src/harnesses/codex.ts";
import { codexControlSocket } from "../src/harnesses/codex-rpc.ts";
import { FakeCodex } from "./codex-fake.ts";
import { agentRecord } from "./subagent-fixtures.ts";

const parentId = "00000000-0000-4000-8000-000000000001";
const childId = "00000000-0000-4000-8000-000000000002";
const parent = agentRecord({
	id: `codex:${parentId}`,
	sessionId: parentId,
	harness: "codex",
});
const child = agentRecord({
	id: `${parent.id}/sub:${childId}`,
	harness: "codex",
	sessionId: childId,
	meta: { subagentOf: parent.id },
});
let server: FakeCodex;
let directory: string;
let previousHome: string | undefined;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pulsar-codex-"));
	previousHome = process.env.CODEX_HOME;
	process.env.CODEX_HOME = directory;
	const path = codexControlSocket();
	await mkdir(dirname(path), { recursive: true });
	server = new FakeCodex(path);
	await server.listen();
});

afterEach(async () => {
	await server.close();
	if (previousHome === undefined) delete process.env.CODEX_HOME;
	else process.env.CODEX_HOME = previousHome;
	await rm(directory, { recursive: true, force: true });
});

test("only live Codex children explicitly accepting app-server input advertise direct messaging", async () => {
	const now = Date.now();
	server.handlers.set("thread/list", (params) => {
		expect(params).toMatchObject({
			sourceKinds: ["subAgentThreadSpawn"],
			cwd: parent.cwd,
		});
		return {
			data: [
				{
					id: childId,
					parentThreadId: parentId,
					agentNickname: "yes",
					canAcceptDirectInput: true,
					status: { type: "active" },
				},
				{
					id: "blocked",
					parentThreadId: parentId,
					agentNickname: "blocked",
					canAcceptDirectInput: false,
					status: { type: "active" },
				},
				{
					id: "missing",
					parentThreadId: parentId,
					agentNickname: "missing",
					status: { type: "active" },
				},
				{
					id: "unloaded",
					parentThreadId: parentId,
					agentNickname: "unloaded",
					canAcceptDirectInput: null,
					status: { type: "notLoaded" },
				},
				{
					id: "other",
					parentThreadId: "unrelated",
					agentNickname: "other",
					canAcceptDirectInput: true,
					status: { type: "active" },
				},
			].map((thread) => ({ ...thread, updatedAt: now })),
		};
	});
	const found = await codex.subagents!.list(parent);
	expect(found.map((sub) => [sub.name, sub.direct])).toEqual([
		["yes", true],
		["blocked", undefined],
		["missing", undefined],
		["unloaded", undefined],
	]);
	expect(server.calls[0]?.params).toHaveProperty(
		"capabilities.experimentalApi",
		true,
	);
});

test("the Codex adapter checks the loaded child and queues one message for that exact thread", async () => {
	let accepting = true;
	server.handlers.set("thread/read", (params) => {
		expect(params).toEqual({ threadId: childId, includeTurns: false });
		return {
			thread: {
				id: childId,
				parentThreadId: parentId,
				canAcceptDirectInput: accepting,
				status: { type: "idle" },
			},
		};
	});
	server.handlers.set("thread/queue/add", (params) => {
		expect(params).toEqual({
			threadId: childId,
			input: [{ type: "text", text: "Child-only message", text_elements: [] }],
			clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
		});
		return { queuedSubmission: { id: "receipt" } };
	});
	expect(
		await codex.push!.deliver(
			child,
			"Child-only message",
			"normal",
			"Operator",
		),
	).toEqual({ ok: true, via: "codex-queue" });
	accepting = false;
	expect(
		await codex.push!.deliver(
			child,
			"Refuse stale capability",
			"normal",
			"Operator",
		),
	).toMatchObject({ ok: false });
	expect(
		server.calls
			.filter((call) => !["initialize", "initialized"].includes(call.method))
			.map((call) => call.method),
	).toEqual(["thread/read", "thread/queue/add", "thread/read"]);
});

test("a Codex queue rejection does not retry or reroute the child's message", async () => {
	server.handlers.set("thread/read", () => ({
		thread: {
			id: childId,
			parentThreadId: parentId,
			canAcceptDirectInput: true,
			status: { type: "idle" },
		},
	}));
	server.handlers.set("thread/queue/add", () => {
		throw new Error(
			"direct app-server input is not allowed for multi-agent v2 sub-agents",
		);
	});
	expect(
		await codex.push!.deliver(child, "One attempt", "normal", "Operator"),
	).toMatchObject({
		ok: false,
		detail: expect.stringContaining("direct app-server input is not allowed"),
	});
	expect(server.calls.map((call) => call.method)).toEqual([
		"initialize",
		"initialized",
		"thread/read",
		"initialize",
		"initialized",
		"thread/queue/add",
	]);
});

function activeChild(accepts = true) {
	server.handlers.set("thread/read", () => ({
		thread: {
			id: childId,
			parentThreadId: parentId,
			canAcceptDirectInput: accepts,
			status: { type: "active" },
		},
	}));
}

for (const target of [parent, child]) {
	test(`urgent input steers the exact active turn on ${target.id}`, async () => {
		activeChild();
		server.handlers.set("thread/turns/list", (params) => {
			expect(params).toEqual({ threadId: target.sessionId, limit: 1 });
			return { data: [{ id: "working-turn", status: "inProgress" }] };
		});
		server.handlers.set("turn/steer", (params) => {
			expect(params).toEqual({
				threadId: target.sessionId,
				expectedTurnId: "working-turn",
				input: [{ type: "text", text: "Use this input", text_elements: [] }],
				clientUserMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
			});
			return { turnId: "working-turn" };
		});
		expect(
			await codex.push!.deliver(target, "Use this input", "urgent", "Operator"),
		).toEqual({ ok: true, via: "codex-steer" });
	});
}

test("a turn that ends before steering receives the input through the child queue", async () => {
	activeChild();
	server.handlers.set("thread/turns/list", () => ({
		data: [{ id: "just-ended", status: "inProgress" }],
	}));
	server.handlers.set("turn/steer", () => {
		throw new Error("no active turn to steer");
	});
	server.handlers.set("thread/queue/add", () => ({
		queuedSubmission: { id: "queued-once" },
	}));
	expect(
		await codex.push!.deliver(child, "Keep this input", "urgent", "Operator"),
	).toEqual({ ok: true, via: "codex-queue" });
	expect(
		server.calls.filter((call) => call.method === "thread/queue/add"),
	).toHaveLength(1);
});

test("an ambiguous steer receipt never causes a second submission", async () => {
	activeChild();
	server.handlers.set("thread/turns/list", () => ({
		data: [{ id: "turn", status: "inProgress" }],
	}));
	server.handlers.set("turn/steer", () => ({}));
	expect(
		await codex.push!.deliver(child, "Only once", "urgent", "Operator"),
	).toMatchObject({ ok: false, via: "codex-steer", uncertain: true });
	expect(server.calls.some((call) => call.method === "thread/queue/add")).toBe(
		false,
	);
});

test("urgent input respects a child that disallows direct messages", async () => {
	activeChild(false);
	expect(
		await codex.push!.deliver(child, "Blocked", "urgent", "Operator"),
	).toMatchObject({ ok: false });
	expect(server.calls.some((call) => call.method === "turn/steer")).toBe(false);
});
