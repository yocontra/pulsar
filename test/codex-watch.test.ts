import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "../src/harnesses/codex.ts";
import {
	CodexWatch,
	codexPrompt,
	codexResult,
} from "../src/harnesses/codex-watch.ts";
import type { ServerPrompt } from "../src/harnesses/types.ts";
import type { Agent } from "../src/types.ts";
import { FakeCodex } from "./codex-fake.ts";
import { restoreEnv } from "./helpers.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
	for (const c of cleanups.splice(0).reverse()) await c();
});

const T1 = "019a0000-0000-7000-8000-000000000001";
const T2 = "019a0000-0000-7000-8000-000000000002";

async function fake() {
	const dir = mkdtempSync(join(tmpdir(), "pcx-"));
	const f = new FakeCodex(join(dir, "c.sock"));
	await f.listen();
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	cleanups.push(() => f.close());
	return f;
}

function watchOn(f: FakeCodex) {
	const w = new CodexWatch({ socket: () => f.path, timeoutMs: 2000 });
	cleanups.push(() => w.close());
	return w;
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

const exec = (threadId: string, itemId: string, command = "rm -rf build") => ({
	kind: "command",
	threadId,
	turnId: "turn-1",
	itemId,
	startedAtMs: 1,
	environmentId: null,
	command,
	cwd: "/repo",
	reason: "clean the build",
});

const ALLOW = { decision: "allow-once" as const, answer: null, note: null };

describe("Codex prompts answered from the app (app-server client)", () => {
	test("rejoins only threads the daemon runs, with nothing but the thread id", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const w = watchOn(f);
		expect(await w.sync([T1, T2])).toBe(true);
		expect(w.covers(T1)).toBe(true);
		// T2 isn't loaded in the daemon (a --no-daemon TUI): never resumed.
		expect(w.covers(T2)).toBe(false);
		const resumes = f.calls.filter((c) => c.method === "thread/resume");
		expect(resumes.map((c) => c.params)).toEqual([
			{ threadId: T1, excludeTurns: true },
		]);
		// Asks for the experimental question requests.
		expect(f.inits()[0]).toMatchObject({
			clientInfo: { name: "pulsar" },
			capabilities: { experimentalApi: true },
		});
		// Synced again: no second resume.
		await w.sync([T1, T2]);
		expect(f.calls.filter((c) => c.method === "thread/resume")).toHaveLength(1);
	});

	test("a pending approval is replayed on resume; Allow reaches Codex on its request id", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const id = f.request(
			"item/commandExecution/requestApproval",
			exec(T1, "call_1"),
		);
		const w = watchOn(f);
		await w.sync([T1]);
		await tick();
		const [p] = w.prompts(T1);
		expect(p).toMatchObject({
			kind: "permission",
			tool: "exec",
			input: {
				command: "rm -rf build",
				cwd: "/repo",
				reason: "clean the build",
			},
			sessionRules: ["rm -rf build"],
		});
		expect(p!.readOnly).toBeUndefined();
		const ok = await w.reply({ ...p!, sessionId: T1 }, ALLOW);
		expect(ok).toBe(true);
		expect(f.answers).toEqual([{ id, result: { decision: "accept" } }]);
		expect(w.prompts(T1)).toEqual([]);
	});

	test("questions: the app's answers go back per question id", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const w = watchOn(f);
		await w.sync([T1]);
		const id = f.request("item/tool/requestUserInput", {
			threadId: T1,
			turnId: "turn-1",
			itemId: "call_q",
			isBlocking: true,
			autoResolutionMs: null,
			questions: [
				{
					id: "color",
					header: "Color",
					question: "Which color?",
					isOther: true,
					isSecret: false,
					options: [
						{ label: "Red", description: "warm" },
						{ label: "Blue", description: "cool" },
					],
				},
			],
		});
		await tick();
		const [p] = w.prompts(T1);
		expect(p!.kind).toBe("question");
		expect(p!.prompt).toMatchObject({
			kind: "question",
			questions: [{ id: "color", question: "Which color?", allowOther: true }],
		});
		const ok = await w.reply(
			{ ...p!, sessionId: T1 },
			{
				decision: "answer",
				answer: { kind: "question", answers: { color: ["Blue"] } },
				note: null,
			},
		);
		expect(ok).toBe(true);
		expect(f.answers).toEqual([
			{ id, result: { answers: { color: { answers: ["Blue"] } } } },
		]);
	});

	test("answered in the TUI first: the card goes, and a late answer is never sent", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const w = watchOn(f);
		await w.sync([T1]);
		const id = f.request("item/fileChange/requestApproval", {
			threadId: T1,
			turnId: "turn-1",
			itemId: "call_p",
			startedAtMs: 1,
		});
		await tick();
		const [p] = w.prompts(T1);
		expect(p!.tool).toBe("apply_patch");
		f.answerElsewhere(id);
		await tick();
		expect(w.prompts(T1)).toEqual([]);
		expect(await w.reply({ ...p!, sessionId: T1 }, ALLOW)).toBe(false);
		expect(f.answers).toEqual([]);
	});

	test("requests the app doesn't answer are never answered (left to the TUI)", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const w = watchOn(f);
		await w.sync([T1]);
		f.request("item/tool/call", { threadId: T1, tool: "x", arguments: {} });
		f.request("item/permissions/requestApproval", {
			threadId: T1,
			itemId: "call_perm",
			reason: "network",
		});
		f.request("item/commandExecution/requestApproval", {
			...exec(T1, "call_stdin"),
			kind: "writeStdin",
		});
		await tick();
		const ps = w.prompts(T1);
		// Shown, read-only; the dynamic tool call isn't shown at all.
		expect(ps.map((p) => [p.tool, p.readOnly])).toEqual([
			["permissions", true],
			["exec", true],
		]);
		expect(f.answers).toEqual([]);
	});

	test("the app-server drops the client: it reconnects, and the replayed prompt is still answerable", async () => {
		const f = await fake();
		f.loaded.add(T1);
		const w = watchOn(f);
		await w.sync([T1]);
		const id = f.request(
			"item/commandExecution/requestApproval",
			exec(T1, "call_r"),
		);
		await tick();
		const key = w.prompts(T1)[0]!.key;
		f.dropClients();
		await tick();
		// Still shown (no flicker while reconnecting)...
		expect(w.covers(T1)).toBe(true);
		expect(w.prompts(T1).map((p) => p.key)).toEqual([key]);
		// ...but not answerable until replayed on the new connection.
		expect(await w.reply({ ...w.prompts(T1)[0]!, sessionId: T1 }, ALLOW)).toBe(
			false,
		);
		await w.sync([T1]);
		await tick();
		const [p] = w.prompts(T1);
		expect(p!.key).toBe(key);
		expect(await w.reply({ ...p!, sessionId: T1 }, ALLOW)).toBe(true);
		expect(f.answers).toEqual([{ id, result: { decision: "accept" } }]);
	});

	test("a thread that ends is left; one not resumable yet is tried again", async () => {
		const f = await fake();
		f.loaded.add(T1);
		f.loaded.add(T2);
		f.unresumable.add(T2);
		const w = watchOn(f);
		await w.sync([T1, T2]);
		expect([w.covers(T1), w.covers(T2)]).toEqual([true, false]);
		f.unresumable.delete(T2);
		await w.sync([T2]);
		expect([w.covers(T1), w.covers(T2)]).toEqual([false, true]);
		expect(f.calls.filter((c) => c.method === "thread/unsubscribe")).toEqual([
			{ method: "thread/unsubscribe", params: { threadId: T1 } },
		]);
	});

	test("no app-server: sync says so (the rollout is read instead)", async () => {
		const w = new CodexWatch({
			socket: () => join(tmpdir(), "pcx-none", "c.sock"),
		});
		expect(await w.sync([T1])).toBe(false);
		expect(w.covers(T1)).toBe(false);
	});

	test("decisions map to Codex's", () => {
		const m = "item/commandExecution/requestApproval";
		expect(codexResult(m, ALLOW)).toEqual({ decision: "accept" });
		expect(
			codexResult(m, { decision: "allow-session", answer: null, note: null }),
		).toEqual({ decision: "acceptForSession" });
		expect(
			codexResult(m, { decision: "deny", answer: null, note: "no" }),
		).toEqual({ decision: "decline" });
		expect(
			codexResult("item/tool/requestUserInput", {
				decision: "deny",
				answer: null,
				note: null,
			}),
		).toEqual({ answers: {} });
		expect(codexResult("item/tool/call", ALLOW)).toBeNull();
		expect(codexPrompt("item/tool/call", {})).toBeNull();
	});
});

describe("the Codex driver's prompts", () => {
	test("threads in the daemon are answerable; others stay read-only from the rollout", async () => {
		const home = mkdtempSync(join(tmpdir(), "pcxh-"));
		const previous = process.env.CODEX_HOME;
		process.env.CODEX_HOME = home;
		cleanups.push(() => {
			restoreEnv("CODEX_HOME", previous);
			rmSync(home, { recursive: true, force: true });
		});
		mkdirSync(join(home, "app-server-control"), { recursive: true });
		const f = new FakeCodex(
			join(home, "app-server-control", "app-server-control.sock"),
		);
		await f.listen();
		cleanups.push(() => f.close());
		f.loaded.add(T1);
		f.request("item/commandExecution/requestApproval", exec(T1, "call_d"));
		const agent = (sessionId: string) =>
			({
				id: `codex:${sessionId}`,
				harness: "codex",
				sessionId,
				status: "busy",
			}) as Agent;
		const source = codex.serverInteractions!;
		await source.pending([agent(T1), agent(T2)]);
		await tick();
		const ps: ServerPrompt[] = await source.pending([agent(T1), agent(T2)]);
		expect(ps).toHaveLength(1);
		expect(ps[0]).toMatchObject({ sessionId: T1, tool: "exec" });
		expect(ps[0]!.readOnly).toBeUndefined();
		expect(await source.reply(ps[0]!, ALLOW)).toBe(true);
		expect(f.answers).toHaveLength(1);
	});
});
