import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ANTIGRAVITY_HOOK_GROUP,
	antigravityHookCommand,
	antigravityHookConfig,
} from "../src/harnesses/antigravity-hook-config.ts";
import { NativeHookProofs } from "../src/service/native-hook-proofs.ts";
import { Store } from "../src/store.ts";
import type { Agent } from "../src/types.ts";

test("only an observed hook with the same installed config and live session identity survives restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pulsar-hook-proof-"));
	const config = join(dir, "hooks.json");
	const otherConfig = join(dir, "other-hooks.json");
	const command = antigravityHookCommand(
		"/tools/bin/node",
		"/with space/dist/cli.js",
	);
	const handler = { type: "command", command };
	const configured = JSON.stringify({
		[ANTIGRAVITY_HOOK_GROUP]: {
			SessionStart: [handler],
			PreInvocation: [handler],
		},
	});
	const store = new Store(":memory:");
	const root: Agent = {
		id: "antigravity:d22ea60b-9231-4ec5-b1c1-f444ffa0924d",
		name: "Fixture",
		harness: "antigravity",
		sessionId: "d22ea60b-9231-4ec5-b1c1-f444ffa0924d",
		pid: 1234,
		cwd: null,
		branch: null,
		project: null,
		tags: [],
		status: "idle",
		model: null,
		activity: null,
		inbound: "accept",
		registered: false,
		reach: "pull",
		lastSeen: 1,
		createdAt: 1,
		meta: { processStart: "actual birth" },
	};
	const custom = {
		...root,
		sessionId: "6c625440-81d2-4531-b36e-5aaea249162a",
		pid: 5678,
	};
	function proofs() {
		return new NativeHookProofs(
			store,
			(apply) => apply(),
			() => false,
			() => antigravityHookConfig(config, command),
		);
	}
	try {
		await writeFile(config, configured);
		await writeFile(otherConfig, configured);
		const revision = (await antigravityHookConfig(config, command))?.revision;
		const other = (await antigravityHookConfig(otherConfig, command))?.revision;
		expect(revision).toBeDefined();
		expect(other).not.toBe(revision);

		const runtime = proofs();
		await runtime.refresh();
		expect(runtime.has(root)).toBe(false);
		runtime.observe(root, "actual birth", revision);
		runtime.observe(custom, "actual birth", other);
		expect(runtime.has(root)).toBe(true);
		expect(runtime.has(custom)).toBe(true);

		const restarted = proofs();
		await restarted.refresh();
		expect(restarted.has({ ...root })).toBe(true);
		expect(
			restarted.has({ ...root, meta: { processStart: "reused PID" } }),
		).toBe(false);
		expect(restarted.has({ ...root, meta: {} })).toBe(false);
		expect(restarted.has({ ...custom })).toBe(false);

		await writeFile(config, "{}");
		await restarted.refresh();
		expect(restarted.has(root)).toBe(false);
		await writeFile(config, configured);
		await restarted.refresh();
		expect(restarted.has(root)).toBe(false);
		const restartedAgain = proofs();
		await restartedAgain.refresh();
		expect(restartedAgain.has(root)).toBe(false);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
