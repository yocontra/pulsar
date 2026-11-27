import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { driverFor } from "../src/harnesses/index.ts";

const { DatabaseSync } = createRequire(import.meta.url)(
	"node:sqlite",
) as typeof import("node:sqlite");
const id = "99112233-0000-4000-8111-123456789abc";
const other = "99112233-0000-4000-8111-123456789def";
const oldEnv = { ...process.env };
let root: string;
let cwd: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "pulsar-native-resume-"));
	cwd = join(root, "project");
	mkdirSync(cwd);
	process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
	process.env.CODEX_HOME = join(root, "codex");
	process.env.XDG_DATA_HOME = join(root, "xdg");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
});
afterEach(() => {
	for (const key of [
		"CLAUDE_CONFIG_DIR",
		"CODEX_HOME",
		"XDG_DATA_HOME",
		"PI_CODING_AGENT_DIR",
	]) {
		if (oldEnv[key] === undefined) delete process.env[key];
		else process.env[key] = oldEnv[key];
	}
	rmSync(root, { recursive: true, force: true });
});
function write(file: string, ...rows: unknown[]) {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

test("Claude verifies the transcript's session and original directory", async () => {
	const driver = driverFor("claude")!;
	const file = join(root, "claude/projects/-project", `${id}.jsonl`);
	write(file, { sessionId: other, cwd });
	expect(await driver.readSession!(id)).toBeNull();
	write(
		file,
		{ type: "mode", sessionId: id },
		{ type: "user", sessionId: id, cwd },
	);
	const saved = await driver.readSession!(id);
	expect(saved?.cwd).toBe(cwd);
	expect(driver.nativeResume!.args(id, saved!)).toEqual([
		"claude",
		"--resume",
		id,
	]);
});

test("older Codex threads use the native index for resume and transcript and exclude child threads", async () => {
	const driver = driverFor("codex")!;
	const file = join(
		root,
		"codex/sessions/2019/01/01",
		`rollout-2019-01-01-${id}.jsonl`,
	);
	write(file, { type: "session_meta", payload: { id, cwd } });
	const db = new DatabaseSync(join(root, "codex/state_5.sqlite"));
	db.exec("CREATE TABLE threads(id TEXT, rollout_path TEXT, archived INTEGER)");
	db.prepare("INSERT INTO threads VALUES(?,?,0)").run(id, file);
	db.close();
	for (const year of ["2024", "2025", "2026"])
		mkdirSync(join(root, "codex/sessions", year));
	const saved = await driver.readSession!(id);
	expect(saved?.cwd).toBe(cwd);
	expect(driver.nativeResume!.args(id, saved!)).toEqual([
		"codex",
		"resume",
		id,
	]);
	expect(
		await driver.transcript!.locate({
			harness: "codex",
			sessionId: id,
			cwd,
			pid: null,
		}),
	).toMatchObject({ path: file });
	write(file, {
		type: "session_meta",
		payload: {
			id,
			cwd,
			source: { subagent: { thread_spawn: { parent_thread_id: other } } },
		},
	});
	expect(await driver.readSession!(id)).toBeNull();
});

for (const harness of ["pi", "omp"])
	test(`${harness} passes only the absolute file verified against its primary session header`, async () => {
		const driver = driverFor(harness)!;
		const file = join(
			root,
			"agent/sessions/-project",
			`2026-11-26_${id}.jsonl`,
		);
		const title =
			harness === "omp"
				? [{ type: "title", title: "A saved conversation" }]
				: [];
		write(file, ...title, { type: "session", id: other, cwd });
		expect(await driver.readSession!(id)).toBeNull();
		write(file, ...title, { type: "session", id, cwd });
		const saved = await driver.readSession!(id);
		expect(saved?.cwd).toBe(cwd);
		expect(driver.nativeResume!.args(id, saved!)).toEqual([
			harness,
			"--session",
			file,
		]);
		expect(await driver.readSession!(id.slice(0, 8))).toBeNull();
	});

test("OpenCode resumes the exact parent session from its native database", async () => {
	const driver = driverFor("opencode")!;
	const key = "ses_Aa123";
	mkdirSync(join(root, "xdg/opencode"), { recursive: true });
	const db = new DatabaseSync(join(root, "xdg/opencode/opencode.db"));
	try {
		db.exec(
			"CREATE TABLE session_v2(id TEXT, directory TEXT, time_updated INTEGER, parent_id TEXT)",
		);
		db.prepare("INSERT INTO session_v2 VALUES(?,?,100,NULL)").run(key, cwd);
		db.prepare("INSERT INTO session_v2 VALUES(?,?,200,?)").run(
			"ses_child",
			cwd,
			key,
		);
		const saved = await driver.readSession!(key);
		expect(saved?.cwd).toBe(cwd);
		expect(driver.nativeResume!.args(key, saved!)).toEqual([
			"opencode",
			"--session",
			key,
		]);
		expect(await driver.readSession!("ses_child")).toBeNull();
	} finally {
		db.close();
	}
});
