import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import type { PublicAgent } from "../src/types.ts";
import {
	agentClient,
	operator,
	registration,
	restoreEnv,
	roundTrip,
	until,
} from "./helpers.ts";

// A fake Claude config dir: one "live" session record pointing at this test process.
const claudeDir = mkdtempSync(join(tmpdir(), "pulsar-claude-"));
const sessions = join(claudeDir, "sessions");
mkdirSync(sessions);
const record = (status: string, name = "sweep-apparish") =>
	writeFileSync(
		join(sessions, `${process.pid}.json`),
		JSON.stringify({
			pid: process.pid,
			sessionId: "fake-claude-1",
			cwd: "/tmp",
			name,
			status,
		}),
	);

let daemon: Daemon;
const home = mkdtempSync(join(tmpdir(), "pulsar-test-"));
const previousEnv = {
	CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
	PULSAR_HOME: process.env.PULSAR_HOME,
};
const closers: Array<{ close: () => void }> = [];

beforeAll(async () => {
	process.env.CLAUDE_CONFIG_DIR = claudeDir;
	process.env.PULSAR_HOME = home;
	record("busy");
	daemon = new Daemon({
		socket: join(home, "bus.sock"),
		db: join(home, "pulsar.db"),
		scan: true,
	});
	await daemon.start();
});

afterAll(async () => {
	for (const c of closers) c.close();
	await daemon.stop();
	for (const [name, value] of Object.entries(previousEnv))
		restoreEnv(name, value);
	rmSync(claudeDir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("Claude scanner", () => {
	test("lists the session under the name Claude shows", async () => {
		await until(
			() => daemon.live().some((a) => a.id === "claude:fake-claude-1"),
			6000,
		);
		const op = await operator();
		closers.push(op);
		const found = await op.call<PublicAgent[]>("list", { selector: "sweep*" });
		expect(found.map((a) => a.name)).toEqual(["sweep-apparish"]);
	});

	test("wait idle:<agent> fires when the scanner sees the session go idle", async () => {
		const waiter = await agentClient(registration());
		closers.push(waiter.client);
		const pending = waiter.client.call<{ event: string }>(
			"wait",
			{ for: "idle:sweep-apparish", timeoutSeconds: 15 },
			20_000,
		);
		await roundTrip(waiter.client);
		record("idle");
		expect((await pending).event).toBe("idle");
	}, 20_000);

	test("follows a rename in Claude until the agent names itself", async () => {
		record("idle", "sweep-renamed");
		await until(
			() => daemon.live().some((a) => a.name === "sweep-renamed"),
			6000,
		);
	}, 10_000);
});
