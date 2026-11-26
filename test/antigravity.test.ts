import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravitySource } from "../src/harnesses/antigravity.ts";
import {
	antigravityActiveConversation,
	antigravityFiles,
	antigravityIdent,
	antigravitySession,
	legacyMcpGeneration,
	legacyMcpMatchesBirth,
	nativeAntigravityProcess,
} from "../src/harnesses/antigravity-ident.ts";
import { agentClient, operator, registration, startDaemon } from "./helpers.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";
const root = "/home/test/.gemini/antigravity-cli";
const logLine = (id: string) =>
	`I1124 22:01:02.345678 122 server.go:1287] Starting conversation update stream for ${id}`;

test("Antigravity uses only its open conversation databases and own CLI log", () => {
	expect(antigravityIdent.matchProcess("/opt/bin/agy --continue")).toBe(true);
	expect(antigravityIdent.matchProcess("node --label agy")).toBe(false);
	for (const args of [
		"agy models",
		"agy acp",
		"agy agentapi send-message",
		"agy remote-control start",
		"agy mic-serve",
	])
		expect(nativeAntigravityProcess(args)).toBe(false);
	expect(nativeAntigravityProcess("agy --remote-control")).toBe(true);
	const conversations = `${root}/conversations`;
	const log = `${root}/log/cli-20261124_220102.log`;
	expect(
		antigravityFiles(
			`fcwd\nn/project\nf1\nn${log}\nf2\nn${log}\nf3\nn${conversations}/${first}.db\nf4\nn${conversations}/${second}.db\nf5\nn/unrelated/${first}.db`,
			conversations,
		),
	).toEqual({ cwd: "/project", sessions: [first, second], presence: [], log });
	expect(
		antigravityActiveConversation(
			`${logLine(first)}\n${logLine(second)}\n${logLine(first)} untrusted trailing text`,
		),
	).toBe(second);
});

test("an idle Antigravity session can close its database and keep its own log open", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-agy-idle-"));
	try {
		const db = join(dir, "conversations");
		mkdirSync(db);
		mkdirSync(join(dir, "log"));
		const log = join(dir, "log", "cli-20261124_220102.log");
		writeFileSync(log, logLine(first));
		const fds = `fcwd\nn/work\nf2\nn${log}`;
		expect((await antigravitySession(fds, db)).sessionId).toBeNull();
		writeFileSync(join(db, `${first}.db`), "");
		expect((await antigravitySession(fds, db)).sessionId).toBe(first);
		expect(
			(await antigravitySession(`${fds}\nf3\nn${db}/${second}.db`, db))
				.sessionId,
		).toBeNull();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Legacy MCP generations are matched to their process birth, not just a reused PID", () => {
	const birth = 1_700_000_000_000;
	expect(legacyMcpGeneration(`123.${(birth + 500).toString(36)}`)).toEqual({
		pid: 123,
		time: birth + 500,
	});
	expect(legacyMcpGeneration("123.extra.trailing")).toBeNull();
	expect(legacyMcpMatchesBirth(birth + 500, birth)).toBe(true);
	expect(legacyMcpMatchesBirth(birth - 60_000, birth)).toBe(false);
	expect(legacyMcpMatchesBirth(birth + 60_000, birth)).toBe(false);
});

function variable(value: number): number[] {
	const bytes: number[] = [];
	while (value >= 128) {
		bytes.push((value % 128) | 128);
		value = Math.floor(value / 128);
	}
	return [...bytes, value];
}
function embedded(field: number, bytes: number[]) {
	return [...variable(field * 8 + 2), ...variable(bytes.length), ...bytes];
}
function payload(type: number, text: string) {
	const time = embedded(5, embedded(1, [8, ...variable(1_700_000_000)]));
	return Uint8Array.from([
		...time,
		...embedded(type === 14 ? 19 : 20, [
			...embedded(type === 14 ? 2 : 1, [...Buffer.from(text)]),
			...embedded(3, [...Buffer.from("private auxiliary text")]),
		]),
	]);
}

test("Antigravity reads history and only polls when SQLite or its WAL changes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pulsar-agy-test-"));
	const path = join(dir, "conversation.db");
	const { DatabaseSync } = createRequire(import.meta.url)(
		"node:sqlite",
	) as typeof import("node:sqlite");
	const db = new DatabaseSync(path);
	try {
		db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, step_format INTEGER, step_payload BLOB)",
		);
		const insert = db.prepare("INSERT INTO steps VALUES (?, ?, ?, ?)");
		for (let idx = 0; idx <= 100; idx++)
			insert.run(idx, 14, 0, payload(14, `prompt ${idx}`));
		insert.run(101, 15, 0, payload(15, "visible response"));
		insert.run(102, 15, 0, Uint8Array.of(255));
		const source = antigravitySource(path, first);
		const recent = (await source.poll())!;
		expect(recent.events.at(-1)).toMatchObject({
			role: "assistant",
			text: "visible response",
			ts: 1_700_000_000_000,
		});
		expect(
			(await source.fetch(recent.cursor)).events.map((event) => event.text),
		).toEqual(["prompt 0", "prompt 1", "prompt 2"]);
		expect(await source.poll()).toBeNull();
		expect(await source.fetch(null)).toEqual(recent);
		insert.run(103, 14, 0, payload(14, "new prompt in WAL"));
		expect((await source.poll())?.events.at(-1)).toMatchObject({
			id: `${first}#103`,
			text: "new prompt in WAL",
		});
		expect(await source.poll()).toBeNull();
		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		expect((await source.poll())?.events.at(-1)?.id).toBe(`${first}#103`);
		expect(await source.poll()).toBeNull();
	} finally {
		db.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("Antigravity scan adopts a proved MCP process and leaves managed ACP registrations alone", async () => {
	const { daemon, cleanup, home } = await startDaemon();
	const old = await agentClient(
		registration({ harness: "unknown", role: "mcp", cwd: home, pid: 42_001 }),
	);
	const anonymous = await agentClient(
		registration({ harness: "unknown", role: "mcp", cwd: home, pid: null }),
	);
	const managed = await agentClient(
		registration({
			harness: "antigravity",
			cwd: home,
			sessionId: second,
			pid: 42_002,
			meta: { acp: "1" },
		}),
	);
	const operatorClient = await operator();
	try {
		await managed.client.call("set_status", { status: "busy" });
		const sent = await operatorClient.call<{ message: { id: string } }>(
			"send",
			{ to: old.agent.id, body: "Keep this unread" },
		);
		const scan = (sessionId: string) =>
			daemon.service.registry.runScan("antigravity", {
				intervalMs: 20_000,
				tracksPid: true,
				sessions: () => [
					{
						harness: "antigravity",
						sessionId,
						pid: 42_001,
						cwd: home,
						status: "unknown",
						meta: { processStart: "same birth" },
					},
				],
			});
		await scan(first);
		await scan("pid:42001");
		const id = `antigravity:${first}`;
		expect(await old.client.call("whoami")).toMatchObject({
			agent: { id, registered: true },
			unread: 1,
		});
		expect(daemon.store.receipt(sent.message.id, id)).toBeTruthy();
		expect(daemon.service.registry.get(old.agent.id)).toBeUndefined();
		expect(daemon.service.registry.get(anonymous.agent.id)?.harness).toBe(
			"unknown",
		);
		expect(daemon.service.registry.get(managed.agent.id)?.status).toBe("busy");
		const switched = "af53a6d5-ed67-4901-a54e-c9d1941999d5";
		// The next scan starts after the canonical registration.
		daemon.service.registry.get(id)!.createdAt = Date.now() - 1;
		await scan(switched);
		expect(await old.client.call("whoami")).toMatchObject({
			agent: { id: `antigravity:${switched}` },
		});
		expect(daemon.service.registry.get(id)).toBeUndefined();
	} finally {
		operatorClient.close();
		old.client.close();
		anonymous.client.close();
		managed.client.close();
		await daemon.stop();
		cleanup();
	}
});
