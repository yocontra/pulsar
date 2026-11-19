import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	claudeSessionDir,
	claudeSubagentReads,
	claudeSubagentTranscript,
	listClaudeSubagents,
	TASK_QUIET_MS,
} from "../src/harnesses/claude-subagents.ts";
import {
	listCodexSubagents,
	listOmpSubagents,
	listOpencodeSubagents,
	ompSubagentReads,
} from "../src/harnesses/more-subagents.ts";
import { processSnapshot } from "../src/processes.ts";
import {
	isAddress,
	isLocalSubagentId,
	splitAddress,
	splitSubagentId,
} from "../src/service/pool.ts";
import { newParseState } from "../src/transcripts/types.ts";
import { restoreEnv } from "./helpers.ts";
import { agentRecord, rec, writeClaudeSub } from "./subagent-fixtures.ts";

/**
 * Subagent discovery per harness, on synthetic files and fake harness
 * servers (never the user's real sessions): Claude Code's
 * `<session>/subagents/agent-*.jsonl` + `.meta.json`, omp's
 * `<session>/<Name>.jsonl`, Codex's spawned threads over a fake app-server,
 * OpenCode's child sessions from a fake `opencode` on PATH.
 */

const dir = mkdtempSync(join(tmpdir(), "pulsar-subagents-"));
const saved = {
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	HOME: process.env.HOME,
	CODEX_HOME: process.env.CODEX_HOME,
	PATH: process.env.PATH,
	XDG_STATE_HOME: process.env.XDG_STATE_HOME,
};

afterAll(() => {
	for (const [k, v] of Object.entries(saved)) restoreEnv(k, v);
	rmSync(dir, { recursive: true, force: true });
});

describe("subagent ids", () => {
	test("a local subagent id is not a pool address; a remote one is", () => {
		const local = "claude:abc/sub:a1";
		expect(isLocalSubagentId(local)).toBe(true);
		expect(isAddress(local)).toBe(false);
		expect(splitAddress(local)).toBeNull();
		expect(splitSubagentId(local)).toEqual({
			parentId: "claude:abc",
			key: "a1",
		});
		const remote = "0b5e1c2d-0000-4000-8000-000000000001/claude:abc/sub:a1";
		expect(isLocalSubagentId(remote)).toBe(false);
		expect(isAddress(remote)).toBe(true);
		expect(splitAddress(remote)).toEqual({
			machineId: "0b5e1c2d-0000-4000-8000-000000000001",
			localId: "claude:abc/sub:a1",
		});
		expect(splitSubagentId(remote)?.parentId).toBe(
			"0b5e1c2d-0000-4000-8000-000000000001/claude:abc",
		);
		// Plain ids and addresses are unchanged.
		expect(splitSubagentId("claude:abc")).toBeNull();
		expect(isAddress("m1/claude:abc")).toBe(true);
		expect(splitSubagentId("claude:abc/sub:")).toBeNull();
		expect(splitSubagentId("claude:abc/sub:a/b")).toBeNull();
	});
});

describe("Claude Code subagents", () => {
	const config = join(dir, "claude");
	const lead = agentRecord();
	let sessionDir: string;
	const now = Date.parse("2026-11-10T12:00:00.000Z");

	beforeAll(() => {
		process.env.CLAUDE_CONFIG_DIR = config;
		sessionDir = claudeSessionDir(lead.cwd, lead.sessionId)!;
		writeClaudeSub(
			sessionDir,
			"a0done",
			{
				agentType: "Explore",
				description: "Find the parser",
				toolUseId: "toolu_1",
				finished: true,
			},
			{ mtime: now - 60_000, started: "2026-11-10T11:00:00.000Z" },
		);
		writeClaudeSub(
			sessionDir,
			"a1run",
			{
				agentType: "general-purpose",
				description: "Fix the bug",
				toolUseId: "toolu_2",
			},
			{ mtime: now - 5_000, started: "2026-11-10T11:30:00.000Z" },
		);
		writeClaudeSub(
			sessionDir,
			"a2stale",
			{
				agentType: "general-purpose",
				description: "Old work",
				toolUseId: "toolu_3",
			},
			{
				mtime: now - TASK_QUIET_MS - 1000,
				started: "2026-11-10T09:00:00.000Z",
			},
		);
		writeClaudeSub(
			sessionDir,
			"a3mate",
			{
				agentType: "general-purpose",
				description: "Review the PR",
				name: "reviewer",
				taskKind: "in_process_teammate",
				teamName: "t",
			},
			{ mtime: now - 5 * 60_000, started: "2026-11-10T10:30:00.000Z" },
		);
		writeClaudeSub(
			sessionDir,
			"a4nested",
			{
				agentType: "Explore",
				description: "Nested search",
				toolUseId: "toolu_9",
				parentAgentId: "a1run",
				finished: true,
			},
			{ mtime: now - 1000, started: "2026-11-10T11:40:00.000Z" },
		);
		// Not subagents: a stray file, a bad id, workflow runs.
		writeFileSync(join(sessionDir, "subagents", "notes.txt"), "x");
		writeFileSync(join(sessionDir, "subagents", "agent-..%2f.jsonl"), "x");
		mkdirSync(join(sessionDir, "subagents", "workflows", "wf_1"), {
			recursive: true,
		});
	});

	test("lists tasks, teammates and nested runs with their state", async () => {
		const found = await listClaudeSubagents(lead, now);
		const by = new Map(found.map((f) => [f.key, f]));
		expect([...by.keys()].sort()).toEqual([
			"a0done",
			"a1run",
			"a2stale",
			"a3mate",
			"a4nested",
		]);
		expect(by.get("a0done")).toMatchObject({
			name: "Find the parser",
			kind: "task",
			agentType: "Explore",
			state: "done",
			callId: "toolu_1",
			startedAt: Date.parse("2026-11-10T11:00:00.000Z"),
		});
		expect(by.get("a1run")?.state).toBe("running");
		expect(by.get("a1run")?.finishedAt).toBeNull();
		// No `finished` mark and quiet for long: taken as done.
		expect(by.get("a2stale")?.state).toBe("done");
		expect(by.get("a3mate")).toMatchObject({
			name: "reviewer",
			kind: "teammate",
			description: "Review the PR",
			state: "idle",
		});
		expect(by.get("a4nested")?.parentKey).toBe("a1run");
	});

	test("a gone parent's subagents are all done", async () => {
		const found = await listClaudeSubagents({ ...lead, status: "gone" }, now);
		expect(found.every((f) => f.state === "done")).toBe(true);
	});

	test("unchanged meta files are not read again", async () => {
		await listClaudeSubagents(lead, now);
		const before = claudeSubagentReads.bytes;
		await listClaudeSubagents(lead, now);
		expect(claudeSubagentReads.bytes).toBe(before);
		// A subagent finishes: only its meta is read again.
		writeFileSync(
			join(sessionDir, "subagents", "agent-a1run.meta.json"),
			JSON.stringify({
				agentType: "general-purpose",
				description: "Fix the bug",
				toolUseId: "toolu_2",
				finished: true,
			}),
		);
		const t = (Date.now() + 5000) / 1000;
		utimesSync(join(sessionDir, "subagents", "agent-a1run.meta.json"), t, t);
		const found = await listClaudeSubagents(lead, now);
		expect(found.find((f) => f.key === "a1run")?.state).toBe("done");
		expect(claudeSubagentReads.bytes - before).toBeLessThan(400);
	});

	test("no session folder, no session id, odd session ids: none", async () => {
		expect(
			await listClaudeSubagents(agentRecord({ cwd: "/elsewhere" })),
		).toEqual([]);
		expect(await listClaudeSubagents(agentRecord({ sessionId: null }))).toEqual(
			[],
		);
		expect(
			await listClaudeSubagents(agentRecord({ sessionId: "../../etc" })),
		).toEqual([]);
	});

	test("its own transcript drops the sidechain mark", async () => {
		const [sub] = (await listClaudeSubagents(lead, now)).filter(
			(f) => f.key === "a0done",
		);
		const t = await claudeSubagentTranscript(lead, sub!);
		expect(t?.source).toEqual({ kind: "file", path: sub!.file! });
		const text = await Bun.file(sub!.file!).text();
		const events = t!.parse(text, newParseState({ atStart: true }));
		expect(events.length).toBeGreaterThan(0);
		expect(events.some((e) => e.sidechain)).toBe(false);
		expect(events.map((e) => e.text)).toContain("done by a0done");
	});
});

describe("omp subagents", () => {
	const home = join(dir, "omp-home");
	const cwd = "/work/omp-demo";
	const session = "0000bbbb-1111-4222-8333-444455556666";
	let folder: string;

	beforeAll(() => {
		process.env.HOME = home;
		const sessions = join(
			home,
			".omp",
			"agent",
			"sessions",
			"--work-omp-demo--",
		);
		mkdirSync(sessions, { recursive: true });
		const file = join(sessions, `2026-11-10T10-00-00-000Z_${session}.jsonl`);
		writeFileSync(file, rec({ type: "title", title: "" }));
		folder = file.slice(0, -".jsonl".length);
		mkdirSync(folder);
		const head = (name: string) =>
			rec({ type: "title", title: name }) +
			rec({
				type: "session",
				id: name,
				parentSession: session,
				cwd,
				timestamp: "2026-11-10T10:05:00.000Z",
			});
		writeFileSync(
			join(folder, "Scout.jsonl"),
			`${head("Scout")}${rec({ type: "custom", customType: "session_exit", data: {} })}`,
		);
		writeFileSync(join(folder, "Scout.md"), "result");
		writeFileSync(
			join(folder, "Builder.jsonl"),
			`${head("Builder")}${rec({ type: "message", message: { role: "assistant" } })}`,
		);
		writeFileSync(join(folder, "1.bash.log"), "not a subagent");
	});

	test("lists task sessions; exited ones are done", async () => {
		const parent = agentRecord({
			id: "omp:pid:1",
			harness: "omp",
			sessionId: session,
			cwd,
		});
		const found = await listOmpSubagents(parent);
		const by = new Map(found.map((f) => [f.key, f]));
		expect([...by.keys()].sort()).toEqual(["Builder", "Scout"]);
		expect(by.get("Scout")?.state).toBe("done");
		expect(by.get("Builder")?.state).toBe("running");
		expect(by.get("Builder")?.startedAt).toBe(
			Date.parse("2026-11-10T10:05:00.000Z"),
		);
		const before = ompSubagentReads.bytes;
		await listOmpSubagents(parent);
		expect(ompSubagentReads.bytes).toBe(before);
	});
});

describe("Codex subagents (fake app-server)", () => {
	let server: Server;
	const threads: unknown[] = [];

	function frame(text: string): Buffer {
		const data = Buffer.from(text);
		const head =
			data.length < 126
				? Buffer.from([0x81, data.length])
				: Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
		return Buffer.concat([head, data]);
	}

	beforeAll(async () => {
		const home = join(dir, "codex");
		mkdirSync(join(home, "app-server-control"), { recursive: true });
		process.env.CODEX_HOME = home;
		server = createServer((sock) => {
			let buf = Buffer.alloc(0);
			let open = false;
			sock.on("data", (chunk) => {
				buf = Buffer.concat([buf, chunk]);
				if (!open) {
					const end = buf.indexOf("\r\n\r\n");
					if (end < 0) return;
					buf = buf.subarray(end + 4);
					open = true;
					sock.write(
						"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
					);
				}
				while (buf.length >= 6) {
					let n = buf[1]! & 0x7f;
					let off = 2;
					if (n === 126) {
						n = buf.readUInt16BE(2);
						off = 4;
					}
					if (buf.length < off + 4 + n) return;
					const mask = buf.subarray(off, off + 4);
					const body = Buffer.from(buf.subarray(off + 4, off + 4 + n));
					for (let i = 0; i < n; i++) body[i] = body[i]! ^ mask[i % 4]!;
					buf = buf.subarray(off + 4 + n);
					const msg = JSON.parse(body.toString()) as {
						id?: number;
						method: string;
					};
					if (msg.id === undefined) continue;
					const result = msg.method === "thread/list" ? { data: threads } : {};
					sock.write(frame(JSON.stringify({ id: msg.id, result })));
				}
			});
		});
		await new Promise<void>((r) =>
			server.listen(
				join(home, "app-server-control", "app-server-control.sock"),
				r,
			),
		);
	});

	afterAll(() => server.close());

	test("spawned threads of this thread, grandchildren included", async () => {
		threads.push(
			{
				id: "t-child",
				parentThreadId: "t-lead",
				agentNickname: "Ada",
				agentRole: "worker",
				preview: "Write the tests",
				createdAt: 1_790_000_000,
				updatedAt: 1_790_000_100,
				status: { type: "active" },
			},
			{
				id: "t-grand",
				parentThreadId: "t-child",
				agentNickname: "Bo",
				createdAt: 1_790_000_010,
				updatedAt: 1_790_000_020,
				status: { type: "notLoaded" },
			},
			{
				id: "t-other",
				parentThreadId: "t-someone-else",
				createdAt: 1_790_000_000,
				status: { type: "active" },
			},
		);
		const found = await listCodexSubagents(
			agentRecord({
				id: "codex:t-lead",
				harness: "codex",
				sessionId: "t-lead",
			}),
		);
		const by = new Map(found.map((f) => [f.key, f]));
		expect([...by.keys()].sort()).toEqual(["t-child", "t-grand"]);
		expect(by.get("t-child")).toMatchObject({
			name: "Ada",
			kind: "thread",
			agentType: "worker",
			state: "running",
			sessionId: "t-child",
			startedAt: 1_790_000_000_000,
		});
		expect(by.get("t-grand")).toMatchObject({
			state: "done",
			parentKey: "t-child",
		});
	});
});

describe("OpenCode subagents (fake opencode on PATH)", () => {
	const bin = join(dir, "oc-bin");
	const routes = join(dir, "oc-routes.json");

	beforeAll(async () => {
		mkdirSync(bin, { recursive: true });
		const stub = (name: string, body: string) => {
			writeFileSync(join(bin, name), body);
			chmodSync(join(bin, name), 0o755);
		};
		stub(
			"opencode",
			`#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const r = JSON.parse(fs.readFileSync(${JSON.stringify(routes)}, "utf8"));
const key = args[1] === "session.active" || args[2] === "/api/session/active" ? "session.active" : args[1] + " " + args[2] + (args[3] === "--param" ? "?" + args[4] : "");
process.stdout.write(JSON.stringify(r[key] ?? {}));
`,
		);
		stub("ps", `#!/bin/sh\necho "99999 1 opencode-fake serve --service"\n`);
		process.env.PATH = `${bin}:${saved.PATH}`;
		// Never the user's own OpenCode service.
		process.env.XDG_STATE_HOME = join(dir, "oc-state");
		writeFileSync(
			routes,
			JSON.stringify({
				"GET /api/session?parentID=ses_lead": {
					data: [
						{
							id: "ses_kid1",
							parentID: "ses_lead",
							title: "explore the repo",
							agent: "explore",
							time: { created: 1_790_000_000_000, updated: 1_790_000_005_000 },
						},
						{ id: "ses_kid2", parentID: "ses_lead", title: "review" },
						{ id: "ses_stranger", parentID: "ses_other", title: "no" },
					],
				},
				"session.active": { data: { ses_kid1: { type: "running" } } },
			}),
		);
		await processSnapshot(0);
		await processSnapshot(0);
	});

	afterAll(async () => {
		process.env.PATH = saved.PATH;
		await processSnapshot(0);
		await processSnapshot(0);
	});

	test("child sessions, running ones from session.active", async () => {
		const found = await listOpencodeSubagents(
			agentRecord({
				id: "opencode:ses_lead",
				harness: "opencode",
				sessionId: "ses_lead",
			}),
		);
		expect(found.map((f) => f.key).sort()).toEqual(["ses_kid1", "ses_kid2"]);
		expect(found.find((f) => f.key === "ses_kid1")).toMatchObject({
			name: "explore the repo",
			kind: "session",
			agentType: "explore",
			state: "running",
			sessionId: "ses_kid1",
		});
		expect(found.find((f) => f.key === "ses_kid2")?.state).toBe("idle");
	});
});
