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
	lastTimestamp,
	listClaudeSubagents,
	TASK_QUIET_MS,
	TEAMMATE_QUIET_MS,
} from "../src/harnesses/claude-subagents.ts";
import {
	IDLE_MAX_MS,
	listCodexSubagents,
	listOmpSubagents,
	listOpencodeSubagents,
	OMP_QUIET_MS,
	ompSubagentReads,
} from "../src/harnesses/more-subagents.ts";
import { omp as ompDriver } from "../src/harnesses/omp.ts";
import { openFilesSource } from "../src/harnesses/pi-sessions.ts";
import { processSnapshot } from "../src/processes.ts";
import {
	isAddress,
	isLocalSubagentId,
	splitAddress,
	splitSubagentId,
} from "../src/service/pool.ts";
import { newParseState } from "../src/transcripts/types.ts";
import {
	agentClient,
	operator,
	registration,
	restoreEnv,
	startDaemon,
} from "./helpers.ts";
import {
	agentRecord,
	rec,
	writeClaudeSub,
	writeClaudeTeam,
} from "./subagent-fixtures.ts";

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
				color: "cyan",
			},
			{ mtime: now - 5 * 60_000, started: "2026-11-10T10:30:00.000Z" },
		);
		// The team this session leads: reviewer is its only member.
		writeClaudeTeam(config, "t", lead.sessionId!, [
			{ name: "reviewer", joinedAt: Date.parse("2026-11-10T10:30:00.000Z") },
		]);
		// Another session leads "t2" (a team name reused elsewhere).
		writeClaudeTeam(config, "t2", "ffff0000-1111-4222-8333-444455556666", [
			{ name: "x" },
		]);
		const mate = (name: string, teamName: string) => ({
			agentType: "general-purpose",
			description: `Work as ${name}`,
			name,
			taskKind: "in_process_teammate",
			teamName,
		});
		// Shut down: no longer a member of its team. Its color stays.
		writeClaudeSub(
			sessionDir,
			"a5stopped",
			{ ...mate("old-mate", "t"), color: "pink" },
			{
				mtime: now - 2 * 60_000,
				started: "2026-11-10T09:30:00.000Z",
			},
		);
		// An earlier "reviewer" (the name was spawned again since).
		writeClaudeSub(sessionDir, "a6prior", mate("reviewer", "t"), {
			mtime: now - 3 * 3600_000,
			started: "2026-11-10T08:00:00.000Z",
		});
		// Its team was deleted.
		writeClaudeSub(sessionDir, "a7noteam", mate("solo", "gone-team"), {
			mtime: now - 30_000,
			started: "2026-11-10T11:00:00.000Z",
		});
		// A member, but of a team another session leads.
		writeClaudeSub(sessionDir, "a8foreign", mate("x", "t2"), {
			mtime: now - 10_000,
			started: "2026-11-10T11:00:00.000Z",
		});
		// Resumed: Claude appended untimestamped records (mtime now), but it
		// last worked two hours ago and never got `finished`.
		writeClaudeSub(
			sessionDir,
			"a9resumed",
			{
				agentType: "general-purpose",
				description: "Unmatched task",
				toolUseId: "toolu_8",
			},
			{
				mtime: now - 1000,
				started: "2026-11-10T09:50:00.000Z",
				last: "2026-11-10T10:00:00.000Z",
				trailer:
					rec({ type: "data-flow-incomplete", v: 1, agentId: "a9resumed" }) +
					rec({
						type: "data-flow-records",
						v: 1,
						agentId: "a9resumed",
						records: ["x".repeat(30_000)],
					}),
			},
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

	test("a teammate keeps the color Claude gave it; others have none", async () => {
		const found = await listClaudeSubagents(lead, now);
		const color = (k: string) => found.find((f) => f.key === k)?.color;
		expect(color("a3mate")).toBe("cyan");
		expect(color("a5stopped")).toBe("pink");
		expect(color("a1run")).toBeNull();
		expect(color("a6prior")).toBeNull();
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
			"a5stopped",
			"a6prior",
			"a7noteam",
			"a8foreign",
			"a9resumed",
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

	test("only a member of a team this session leads is alive", async () => {
		const by = new Map(
			(await listClaudeSubagents(lead, now)).map((f) => [f.key, f]),
		);
		expect(by.get("a3mate")?.state).toBe("idle");
		// Stopped, an older incarnation, no team, someone else's team: done.
		for (const k of ["a5stopped", "a6prior", "a7noteam", "a8foreign"]) {
			expect(by.get(k)?.state).toBe("done");
			expect(by.get(k)?.finishedAt).toBe(by.get(k)!.updatedAt);
		}
		// A live member writing now is running.
		const busy = await listClaudeSubagents(
			lead,
			Date.parse("2026-11-10T11:55:00.000Z") + TEAMMATE_QUIET_MS / 2,
		);
		expect(busy.find((f) => f.key === "a3mate")?.state).toBe("running");
	});

	test("activity is the last record's time, not the resumed log's mtime", async () => {
		const sub = (await listClaudeSubagents(lead, now)).find(
			(f) => f.key === "a9resumed",
		);
		expect(sub?.state).toBe("done");
		expect(sub?.updatedAt).toBe(Date.parse("2026-11-10T10:00:00.000Z"));
		expect(sub?.finishedAt).toBe(Date.parse("2026-11-10T10:00:00.000Z"));
	});

	test("lastTimestamp skips untimestamped and cut lines", () => {
		const a = rec({ type: "user", timestamp: "2026-11-10T10:00:00.000Z" });
		const b = rec({ type: "data-flow-records", records: [] });
		expect(lastTimestamp(a + b, true)).toBe(
			Date.parse("2026-11-10T10:00:00.000Z"),
		);
		// A cut first line is never trusted.
		expect(lastTimestamp(a.slice(5) + b, false)).toBeNull();
		expect(lastTimestamp(b, true)).toBeNull();
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

	test("a teammate the lead shuts down turns done", async () => {
		const file = writeClaudeTeam(config, "t", lead.sessionId!, [], {
			mtime: Date.now() + 10_000,
		});
		let found = await listClaudeSubagents(lead, now);
		expect(found.find((f) => f.key === "a3mate")?.state).toBe("done");
		// Back in the team (a later config write): alive again.
		writeClaudeTeam(
			config,
			"t",
			lead.sessionId!,
			[{ name: "reviewer", joinedAt: Date.parse("2026-11-10T10:30:00.000Z") }],
			{ mtime: Date.now() + 20_000 },
		);
		found = await listClaudeSubagents(lead, now);
		expect(found.find((f) => f.key === "a3mate")?.state).toBe("idle");
		expect(file).toContain("teams");
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
		writeFileSync(
			join(folder, "changes.jsonl"),
			rec({ type: "edit", path: "src/file.ts" }),
		);
		writeFileSync(
			join(folder, "wrong-parent.jsonl"),
			head("Other").replace(session, "different"),
		);
		// Died: no exit record, no result, no write for an hour.
		writeFileSync(
			join(folder, "Ghost.jsonl"),
			`${head("Ghost")}${rec({ type: "message", message: { role: "assistant" } })}`,
		);
		const old = (Date.now() - OMP_QUIET_MS - 60_000) / 1000;
		utimesSync(join(folder, "Ghost.jsonl"), old, old);
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
		expect([...by.keys()].sort()).toEqual(["Builder", "Ghost", "Scout"]);
		expect(by.get("Scout")?.state).toBe("done");
		expect(by.get("Ghost")?.state).toBe("done");
		expect(by.get("Builder")?.state).toBe("running");
		expect(by.get("Builder")?.startedAt).toBe(
			Date.parse("2026-11-10T10:05:00.000Z"),
		);
		const before = ompSubagentReads.bytes;
		await listOmpSubagents(parent);
		expect(ompSubagentReads.bytes).toBe(before);
	});
});

describe("omp subagents: which session", () => {
	// Real-shaped: omp names a folder under the home folder home-relative
	// (`-tmp` for ~/tmp), and two sessions can share one.
	const home = join(dir, "omp-which-home");
	const cwd = join(home, "tmp");
	const sessions = join(home, ".omp", "agent", "sessions", "-tmp");
	const mine = join(sessions, "2026-11-20T04-03-57-433Z_01a1f720.jsonl");
	const newer = join(sessions, "2026-11-22T07-43-06-660Z_01a20235.jsonl");
	const saved = openFilesSource.fn;
	let open: string[] = [];

	const task = (name: string, parent: string) =>
		rec({ type: "title", title: name }) +
		rec({
			type: "session",
			id: name,
			parentSession: parent,
			cwd,
			timestamp: "2026-11-20T04-05-00.000Z",
		});

	beforeAll(() => {
		process.env.HOME = home;
		openFilesSource.fn = async () => open;
		for (const [file, sub] of [
			[mine, "MineTask"],
			[newer, "OtherTask"],
		] as const) {
			mkdirSync(file.slice(0, -".jsonl".length), { recursive: true });
			writeFileSync(
				file,
				`${rec({ type: "title", title: "" })}${rec({ type: "message", id: sub, message: { role: "user", content: `log of ${sub}` } })}`,
			);
			writeFileSync(
				join(file.slice(0, -".jsonl".length), `${sub}.jsonl`),
				task(sub, file),
			);
		}
		utimesSync(mine, 1000, 1000);
		utimesSync(newer, 2000, 2000);
	});
	afterAll(() => {
		openFilesSource.fn = saved;
	});

	const keys = async (over: Parameters<typeof agentRecord>[0]) =>
		(
			await listOmpSubagents(
				agentRecord({ harness: "omp", sessionId: null, cwd, ...over }),
			)
		).map((f) => f.key);

	test("no session id: the session its process has open, not the newest", async () => {
		open = [join(mine.slice(0, -".jsonl".length), "MineTask.jsonl"), mine];
		expect(await keys({ id: "omp:pid:84724", pid: 84724 })).toEqual([
			"MineTask",
		]);
	});

	test("the session the extension reported (resumeKey) wins", async () => {
		open = [];
		expect(
			await keys({
				id: "omp:pid:2",
				pid: 2,
				meta: { resumeKey: "omp:01a1f720" },
			}),
		).toEqual(["MineTask"]);
	});

	test("nothing exact: do not claim children from another parent", async () => {
		open = [];
		expect(await keys({ id: "omp:pid:3", pid: 3 })).toEqual([]);
	});

	test("the session log is the agent's own session", async () => {
		open = [mine];
		const log = await ompDriver.sessionLog!(
			agentRecord({ harness: "omp", sessionId: null, cwd, pid: 4 }),
		);
		expect(log).toContain("log of MineTask");
		expect(log).not.toContain("log of OtherTask");
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
			// Idle: one waiting now, one left loaded long after its work.
			{
				id: "t-wait",
				parentThreadId: "t-lead",
				createdAt: 1_790_000_000,
				updatedAt: 1_790_000_200,
				status: { type: "idle" },
			},
			{
				id: "t-old",
				parentThreadId: "t-lead",
				createdAt: 1_780_000_000,
				updatedAt: 1_780_000_100,
				status: { type: "idle" },
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
			1_790_000_200_000 + 60_000,
		);
		const by = new Map(found.map((f) => [f.key, f]));
		expect([...by.keys()].sort()).toEqual([
			"t-child",
			"t-grand",
			"t-old",
			"t-wait",
		]);
		expect(by.get("t-wait")?.state).toBe("idle");
		// Idle longer than IDLE_MAX_MS: done.
		expect(by.get("t-old")?.state).toBe("done");
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
				"GET /api/session/ses_lead": {
					data: { id: "ses_lead", directory: "/tmp", parentID: null },
				},
				"GET /api/session/ses_kid1": {
					data: { id: "ses_kid1", directory: "/tmp", parentID: "ses_lead" },
				},
				"GET /api/session/ses_kid2": {
					data: { id: "ses_kid2", directory: "/tmp", parentID: "ses_lead" },
				},
				"GET /api/session/ses_grand": {
					data: { id: "ses_grand", directory: "/tmp", parentID: "ses_kid1" },
				},
				"POST /api/session/ses_kid1/prompt": { data: {} },
				"POST /api/session/ses_kid2/prompt": { data: {} },
				"GET /api/session?limit=500&order=desc": {
					data: [
						{ id: "ses_grand", parentID: "ses_kid1", title: "nested" },
						{ id: "ses_deep", parentID: "ses_grand", title: "deeper" },
						{
							id: "ses_unrelated",
							parentID: "ses_unrelated_root",
							title: "other tree",
						},
						{ id: "ses_lead", parentID: "ses_deep", title: "invalid cycle" },
					],
				},
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
						{
							id: "ses_kid3",
							parentID: "ses_lead",
							title: "waiting",
							time: { created: 1_790_000_000_000, updated: 1_790_000_010_000 },
						},
						{
							id: "ses_kid4",
							parentID: "ses_lead",
							title: "long finished",
							time: { created: 1_780_000_000_000, updated: 1_780_000_010_000 },
						},
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
			1_790_000_010_000 + IDLE_MAX_MS / 2,
		);
		expect(found.find((f) => f.key === "ses_deep")?.parentKey).toBe(
			"ses_grand",
		);
		expect(found.find((f) => f.key === "ses_grand")?.parentKey).toBe(
			"ses_kid1",
		);
		expect(found.map((f) => f.key).sort()).toEqual([
			"ses_deep",
			"ses_grand",
			"ses_kid1",
			"ses_kid2",
			"ses_kid3",
			"ses_kid4",
		]);
		expect(found.find((f) => f.key === "ses_kid1")).toMatchObject({
			name: "explore the repo",
			kind: "session",
			agentType: "explore",
			state: "running",
			sessionId: "ses_kid1",
		});
		// Idle while recently updated; with no time or long quiet, done.
		expect(found.find((f) => f.key === "ses_kid3")?.state).toBe("idle");
		expect(found.find((f) => f.key === "ses_kid2")?.state).toBe("done");
		expect(found.find((f) => f.key === "ses_kid4")?.state).toBe("done");
	});

	test("native MCP child calls use the same identity as direct delivery", async () => {
		const { daemon, cleanup } = await startDaemon();
		try {
			const a = await agentClient(
				registration({
					harness: "opencode",
					role: "mcp",
					sessionId: "ses_kid1",
				}),
			);
			const b = await agentClient(
				registration({
					harness: "opencode",
					role: "mcp",
					sessionId: "ses_grand",
				}),
			);
			const issuer = await operator();
			try {
				expect(a.agent.id).toBe("opencode:ses_lead/sub:ses_kid1");
				expect(b.agent.id).toBe("opencode:ses_lead/sub:ses_grand");
				expect(
					daemon.service.registry.get("opencode:ses_kid1"),
				).toBeUndefined();
				const sent = await issuer.call<{ message: { id: string } }>("send", {
					to: a.agent.id,
					body: "one message",
				});
				const inbox = await b.client.call<{ messages: unknown[] }>("inbox");
				expect(inbox.messages).toEqual([]);
				await expect(
					b.client.call("reply", {
						messageId: sent.message.id,
						body: "wrong child",
					}),
				).rejects.toBeDefined();
				const response = await a.client.call<{ message: { fromId: string } }>(
					"reply",
					{ messageId: sent.message.id, body: "right child" },
				);
				expect(response.message.fromId).toBe(a.agent.id);
			} finally {
				issuer.close();
				a.client.close();
				b.client.close();
			}
		} finally {
			await daemon.stop();
			cleanup();
		}
	});
});
