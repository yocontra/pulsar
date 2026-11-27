import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { codex } from "../src/harnesses/codex.ts";
import { codexControlSocket } from "../src/harnesses/codex-rpc.ts";
import { codexThreadHistory } from "../src/harnesses/codex-thread-history.ts";
import { patchFiles, patchText } from "../src/transcripts/describe.ts";
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

test("checking native archive presence only reads the requested root thread", async () => {
	const loaded = codex.nativeResume!.loaded!;
	const cwd = "/fixture";
	let thread = {
		id: parentId,
		cwd,
		parentThreadId: null as string | null,
		status: { type: "notLoaded" },
	};
	server.handlers.set("thread/read", (params) => {
		expect(params).toEqual({ threadId: parentId, includeTurns: false });
		return { thread };
	});
	expect(await loaded(parentId, cwd)).toBeNull();
	thread.status.type = "idle";
	expect(await loaded(parentId, cwd)).toBe("idle");
	thread.status.type = "active";
	expect(await loaded(parentId, cwd)).toBe("busy");
	thread = { ...thread, parentThreadId: childId };
	await expect(loaded(parentId, cwd)).rejects.toThrow("different thread");
	expect(
		server.calls
			.filter((c) => !["initialize", "initialized"].includes(c.method))
			.map((c) => c.method),
	).toEqual(Array(4).fill("thread/read"));
});

test("only live Codex children explicitly accepting app-server input advertise direct messaging", async () => {
	const now = Date.now();
	server.handlers.set("thread/list", (params) => {
		expect(params).toMatchObject({
			sourceKinds: ["subAgentThreadSpawn"],
			ancestorThreadId: parent.sessionId,
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

test("nested Codex children keep their own workspace and exact archived rollout across pages", async () => {
	const file = join(directory, "archived-rollout.jsonl");
	const grandId = "00000000-0000-4000-8000-000000000003";
	server.handlers.set("thread/list", (params) => {
		expect(params.ancestorThreadId).toBe(parentId);
		expect(params.cwd).toBeUndefined();
		return params.cursor === "earlier"
			? { data: [{ id: childId, parentThreadId: parentId }], nextCursor: null }
			: {
					data: [
						{
							id: grandId,
							parentThreadId: childId,
							cwd: "/other-worktree",
							path: file,
						},
					],
					nextCursor: "earlier",
				};
	});
	const rows = await codex.subagents!.list(parent);
	const grand = rows.find((r) => r.key === grandId)!;
	expect(grand).toMatchObject({ parentKey: childId, cwd: "/other-worktree" });
	const lookup = () => codex.subagents!.transcript!(parent, grand);
	for (const [id, parent_thread_id, valid] of [
		[grandId, childId, true],
		[childId, parentId, false],
		[grandId, parentId, false],
	] as const) {
		await writeFile(
			file,
			`${JSON.stringify({
				type: "session_meta",
				payload: {
					id,
					source: { subagent: { thread_spawn: { parent_thread_id } } },
				},
			})}\n`,
		);
		const transcript = await lookup();
		expect(transcript?.source ?? null).toEqual(
			valid ? { kind: "file", path: file } : null,
		);
	}
});

test("a missing or lost Codex child queue receipt is terminal to avoid duplicate delivery", async () => {
	activeChild();
	for (const lost of [false, true]) {
		server.handlers.set("thread/queue/add", () => {
			if (lost) server.dropClients();
			return {};
		});
		expect(
			await codex.push!.deliver(child, "Only once", "normal", "Operator"),
		).toMatchObject({ ok: false, via: "codex-queue", uncertain: true });
	}
	expect(
		server.calls.filter((c) => c.method === "thread/queue/add"),
	).toHaveLength(2);
});

test("a child without a rollout reads its own paged thread history, including peer and tool activity", async () => {
	server.handlers.set("thread/list", () => ({
		data: [{ id: childId, parentThreadId: parentId }],
	}));
	const [sub] = await codex.subagents!.list(parent);
	const own = await codex.subagents!.transcript!(parent, sub!);
	if (own?.source.kind !== "poll")
		throw new Error("expected app-server history");
	server.handlers.set("thread/turns/list", (params) => {
		expect(params).toMatchObject({
			threadId: childId,
			itemsView: "full",
			sortDirection: "desc",
		});
		if (params.cursor === "earlier")
			return {
				data: [
					{
						startedAt: 8,
						items: [
							{
								id: "user",
								type: "userMessage",
								content: [{ type: "text", text: "My first prompt" }],
							},
						],
					},
				],
			};
		return {
			data: [
				{
					startedAt: 10,
					items: [{ type: "agentMessage", id: "reply", text: "Latest reply" }],
				},
				{
					startedAt: 9,
					items: [
						{
							type: "reasoning",
							id: "summary",
							summary: ["Public summary"],
							content: ["private data"],
						},
						{
							type: "collabAgentToolCall",
							id: "peer",
							tool: "sendMessage",
							receiverThreadIds: ["sibling"],
							prompt: "Run checks",
							status: "completed",
						},
						{
							type: "commandExecution",
							id: "cmd",
							command: "false",
							aggregatedOutput: "failed check",
							exitCode: 1,
							status: "failed",
						},
					],
				},
			],
			nextCursor: "earlier",
		};
	});
	const page = await own.source.fetch(null);
	expect(page.cursor).toBe("earlier");
	expect(page.events.at(-1)).toMatchObject({
		id: "reply",
		text: "Latest reply",
	});
	expect(page.events[0]).toMatchObject({ text: "Public summary" });
	expect(JSON.stringify(page.events)).not.toContain("private data");
	expect(page.events.find((e) => e.id === "peer")?.tool).toMatchObject({
		name: "send_message",
		input: { target: "sibling", message: "Run checks" },
	});
	expect(page.events.find((e) => e.id === "cmd#output")?.tool?.isError).toBe(
		true,
	);
	expect((await own.source.fetch(page.cursor)).events[0]).toMatchObject({
		role: "user",
		text: "My first prompt",
	});
	expect(server.calls.some((c) => c.method === "thread/resume")).toBe(false);
});

test("Codex thread history retains patch hunks, tool outcomes and stable compaction notices", async () => {
	server.handlers.set("thread/turns/list", () => ({
		data: [
			{
				items: [
					{
						id: "f",
						type: "fileChange",
						changes: [
							{ kind: { type: "add" }, path: "new.ts", diff: "new\n" },
							{ kind: { type: "delete" }, path: "old.ts", diff: "old\n" },
							{
								kind: { type: "update", move_path: "after.ts" },
								path: "before.ts",
								diff: "--- before.ts\n+++ after.ts\n@@ -1 +1 @@\n-old\n+replacement\n\nMoved to: after.ts",
							},
						],
						status: "completed",
						startedAtMs: 1700000000012,
					},
					{
						id: "tool",
						type: "dynamicToolCall",
						tool: "lookup",
						contentItems: [{ type: "inputText", text: "offline" }],
						status: "failed",
					},
					{
						id: "wait",
						type: "functionCallOutput",
						name: "wait",
						namespace: "functions",
						output: "",
					},
					{
						id: "result",
						type: "functionCallOutput",
						name: "read",
						output: "hello",
					},
					{
						id: "hidden",
						type: "reasoning",
						summary: [],
						content: ["private raw text"],
					},
					{ id: "compact", type: "contextCompaction" },
				],
			},
		],
	}));
	const { events } = await codexThreadHistory(childId, null, parent.cwd);
	const call = events.find((e) => e.kind === "tool_call" && e.id === "f")!;
	expect(call.ts).toBe(1700000000012);
	expect(patchFiles(patchText(call.tool?.input))).toMatchObject([
		{ path: "new.ts", op: "add", added: 1, removed: 0 },
		{ path: "old.ts", op: "delete", added: 0, removed: 1 },
		{
			path: "before.ts",
			moveTo: "after.ts",
			added: 1,
			removed: 1,
			lines: ["@@ -1 +1 @@", "-old", "+replacement"],
		},
	]);
	expect(events.find((e) => e.id === "tool#output")).toMatchObject({
		text: "offline",
		tool: { isError: true },
	});
	expect(events.find((e) => e.id === "result")).toMatchObject({
		text: "hello",
		tool: { name: "read" },
	});
	expect(events.find((e) => e.id === "hidden")).toMatchObject({
		subtype: "hidden",
		text: "",
	});
	expect(events.some((e) => e.id === "wait")).toBe(false);
	expect(events.find((e) => e.id === "compact")).toMatchObject({
		subtype: "compacted",
	});
});
