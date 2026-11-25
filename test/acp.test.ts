import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { cleanFedAgent } from "../src/federation/state.ts";
import type { AttachmentUpload } from "../src/http/wire.ts";
import type { TranscriptPageResult } from "../src/service/transcripts.ts";
import type { PublicAgent } from "../src/types.ts";
import { operator, startDaemon, until } from "./helpers.ts";

test("managed ACP sends prompts, renders transcript, binds MCP tools, denies permission, stops, and resumes", async () => {
	const env = await startDaemon();
	let daemon = env.daemon;
	let op = await operator();
	const agy = join(env.home, "agy");
	const cli = new URL("../src/cli.ts", import.meta.url).pathname;
	const fixture = new URL("./fixtures/acp-agent.ts", import.meta.url).pathname;
	writeFileSync(
		agy,
		`#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
	);
	chmodSync(agy, 0o700);
	let bridge: ReturnType<typeof launch> | undefined;

	function launch(resume?: string, mode?: string) {
		const child = spawn(
			process.execPath,
			[cli, "acp", "antigravity", ...(resume ? ["--resume", resume] : [])],
			{
				cwd: env.home,
				env: {
					...process.env,
					PATH: `${env.home}:${process.env.PATH}`,
					ACP_FIXTURE_MODE: mode,
				},
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		let output = "";
		child.stdout.on("data", (chunk) => {
			output += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			output += String(chunk);
		});
		const exit = new Promise<number | null>((done) => child.once("exit", done));
		return { child, exit, output: () => output };
	}

	const sessionId = "fixture/acp";
	const agentId = "antigravity:fixture%2Facp";
	const current = async () => {
		const agents = await op.call<PublicAgent[]>("list");
		return agents.find((agent) => agent.id === agentId);
	};
	const session = async () => {
		await until(
			() => Boolean(bridge?.output().includes(`ACP session ${sessionId}`)),
			4000,
		);
		expect((await current())?.reach).toBe("push");
	};
	const prompt = (body: string) => op.call("send", { to: agentId, body });
	const user = {
		kind: "human",
		login: "test@example.com",
		node: "fixture",
		verified: true,
	} as const;
	const changeMode = (mode: string) =>
		daemon.service.acting.run(
			user,
			"agents.mode",
			{ agent: agentId },
			{ mode },
		);
	const runCommand = (line: string) =>
		daemon.service.acting.run(
			user,
			"agents.command",
			{ agent: agentId },
			{ line },
		);
	const control = () => daemon.service.controls;

	async function selectPlan() {
		expect(await control().modes(agentId)).toMatchObject({
			current: "ask",
			live: true,
			canSwitch: true,
			modes: [
				{ id: "ask", label: "Ask" },
				{ id: "plan-v2", label: "Plan" },
			],
		});
		expect(await changeMode("unknown")).toMatchObject({
			result: "unsupported",
			via: "acp",
		});
		expect(await changeMode("plan-v2")).toMatchObject({
			result: "ok",
			via: "acp",
			mode: "plan-v2",
		});
		expect(await control().modes(agentId)).toMatchObject({
			current: "plan-v2",
		});
	}

	try {
		bridge = launch();
		await session();
		const caps = {
			surface: "managed-acp",
			modes: true,
			commands: true,
			resume: true,
			approvals: true,
			skills: false,
			questions: false,
			attachments: true,
			usage: false,
		};
		expect((await current())?.capabilities).toMatchObject(caps);
		expect(
			cleanFedAgent({
				id: agentId,
				name: "fixture",
				harness: "antigravity",
				capabilities: caps,
			})?.capabilities,
		).toMatchObject(caps);
		expect(
			cleanFedAgent({ id: agentId, name: "fixture", harness: "antigravity" })
				?.capabilities,
		).toBeUndefined();
		await selectPlan();
		expect(await control().commands(agentId)).toMatchObject({
			runnable: true,
			commands: [{ name: "fixture-command", source: "agent", args: "details" }],
		});
		expect(await runCommand("/unknown")).toMatchObject({
			result: "unsupported",
			via: "acp",
		});
		expect(await runCommand("/fixture-command")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(() =>
			Boolean(bridge?.output().includes("Fixture command called")),
		);

		const uploaded = "Fixture attachment contents";
		const bytes = Buffer.from(uploaded);
		const upload = (await daemon.service.acting.run(
			user,
			"attachments.upload",
			{ agent: agentId },
			{
				nonce: "fixture-attachment-001",
				files: [
					{
						name: "fixture.txt",
						type: "text/plain",
						size: bytes.length,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					},
				],
			},
		)) as AttachmentUpload;
		const attachment = await daemon.service.attachments.write(
			user.login,
			agentId,
			upload.upload,
			0,
			0,
			bytes,
		);
		expect(attachment.file?.name).toBe("fixture.txt");
		await prompt(
			`Read the uploaded file\nAttached: ${attachment.file!.path} (text/plain, ${bytes.length} B)`,
		);
		await until(() => Boolean(bridge?.output().includes(uploaded)));
		await prompt("fixture-ready");
		await until(() => Boolean(bridge?.output().includes("Fixture ready")));
		const usage = () =>
			daemon.service.agentUsage(agentId, { kind: "terminal" });
		await until(async () => (await usage()).context?.used === 120);
		expect(await usage()).toMatchObject({
			context: { used: 120, window: 4096 },
			cost: 0.003,
		});
		await until(async () => (await current())?.capabilities?.usage === true);
		await prompt("fixture-tools");
		await until(() => Boolean(bridge?.output().includes(agentId)));
		await prompt("fixture-permission");
		await until(() => Boolean(bridge?.output().includes("Permission deny")));
		const held = await op.call<{ message: { id: string } }>("send", {
			to: agentId,
			body: "fixture-hold",
			expectReply: true,
		});
		await until(
			async () =>
				(await current())?.status === "busy" &&
				Boolean(bridge?.output().includes("Holding")),
		);
		expect(await control().modes(agentId)).toMatchObject({
			current: "plan-v2",
			canSwitch: false,
		});
		expect(await changeMode("ask")).toMatchObject({
			result: "busy",
			via: "acp",
		});
		// Replaying a queued receipt after restart must not start a second turn.
		const sent = daemon.store.receipt(held.message.id, agentId)!;
		daemon.store.setReceipt({ ...sent, state: "queued" });
		op.close();
		await daemon.stop();
		daemon = new Daemon({
			socket: join(env.home, "bus.sock"),
			db: join(env.home, "pulsar.db"),
			scan: false,
			remote: { mode: "off" },
		});
		expect(await daemon.start()).toBe(true);
		op = await operator();
		await until(
			async () =>
				(await current())?.status === "busy" &&
				(await current())?.reach === "push",
			4000,
		);
		expect(await op.call("stop", { agent: agentId })).toMatchObject({
			result: "interrupted",
		});
		await until(
			() =>
				daemon.store.receipt(held.message.id, agentId)?.state === "delivered",
		);
		expect(bridge.output().match(/Holding/g)?.length).toBe(1);
		await prompt("fixture-tools");
		await until(() => (bridge?.output().split(agentId).length ?? 0) >= 3);
		await until(async () => (await current())?.status === "idle");
		await prompt("fixture-rejected");
		await until(() =>
			Boolean(bridge?.output().includes("Fixture prompt rejected")),
		);
		bridge.child.stdin?.write(
			`${"x".repeat(257 * 1024)}\nlocal terminal prompt\n`,
		);
		await until(
			() => (bridge?.output().match(/Fixture ready/g)?.length ?? 0) === 2,
		);
		const history = await op.call<TranscriptPageResult>("transcript.read", {
			agent: agentId,
		});
		expect(history.available).toBe(true);
		expect(bridge.output()).toContain("ACP prompt exceeds the size limit");
		expect(
			history.events.some((event) => event.text === "fixture-rejected"),
		).toBe(false);
		expect(history.events.map((event) => event.text)).toContain(
			"Fixture ready",
		);
		expect(history.events.map((event) => event.text)).toContain(
			"local terminal prompt",
		);
		expect(
			history.events.some((event) => event.subtype === "interrupted"),
		).toBe(true);
		bridge.child.kill("SIGTERM");
		expect(await bridge.exit).toBe(0);
		await until(async () => (await current())?.status !== "idle");

		for (const mode of ["resume", "load"]) {
			bridge = launch(sessionId, mode);
			await session();
			expect((await current())?.sessionId).toBe(sessionId);
			await until(() => Boolean(bridge?.output().includes("Holding")));
			expect(bridge.output().match(/Holding/g)?.length).toBe(1);
			expect(await op.call("stop", { agent: agentId })).toMatchObject({
				result: "interrupted",
			});
			await until(async () => (await current())?.status === "idle");
			await selectPlan();
			bridge.child.kill("SIGTERM");
			expect(await bridge.exit).toBe(0);
		}

		bridge = launch(sessionId, "unsupported");
		expect(await bridge.exit).toBe(1);
		expect(bridge.output()).toContain(
			"does not advertise ACP session resume or load",
		);
	} catch (error) {
		throw new Error(bridge?.output(), { cause: error });
	} finally {
		if (bridge && bridge.child.exitCode === null) {
			bridge.child.kill("SIGTERM");
			await bridge.exit;
		}
		op.close();
		await daemon.stop();
		env.cleanup();
	}
}, 20_000);
