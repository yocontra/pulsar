import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Daemon } from "../src/daemon.ts";
import { cleanFedAgent } from "../src/federation/state.ts";
import type { AttachmentUpload, InteractionAnswer } from "../src/http/wire.ts";
import type { TranscriptPageResult } from "../src/service/transcripts.ts";
import type { PublicAgent } from "../src/types.ts";
import { operator, startDaemon, until } from "./helpers.ts";
import { SoftAuthenticator } from "./webauthn.ts";

test("managed ACP sends prompts, renders transcript, binds MCP tools, denies permission, stops, and resumes", async () => {
	let answerable = false;
	const env = await startDaemon({
		approvals: { answerable: () => answerable },
	});
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
	for (const name of [
		"fixture-local-skill",
		"fixture-command",
		"fixture-native-skill",
	]) {
		const skill = join(env.home, ".agents", "skills", name);
		mkdirSync(skill, { recursive: true });
		writeFileSync(
			join(skill, "SKILL.md"),
			`---\nname: ${name}\ndescription: A fixture skill\n---\nFixture skill instructions.\n`,
		);
	}
	let bridge: ReturnType<typeof launch> | undefined;

	function launch(resume?: string, mode?: string) {
		const child = spawn(
			process.execPath,
			[cli, "acp", "antigravity", ...(resume ? ["--resume", resume] : [])],
			{
				cwd: env.home,
				env: {
					...process.env,
					HOME: env.home,
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
		expect((await current())?.model).toBe("fixture-base");
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
		bridge = launch(undefined, "steer");
		await session();
		expect((await current())?.capabilities?.steer).toBe(true);
		await until(async () => (await current())?.status === "idle");
		const sendIdle = (body: string, priority: "normal" | "fyi") =>
			op.call<{
				message: { id: string };
				receipts: { state: string; via: string | null }[];
			}>("send", { to: agentId, body, priority });
		const fyi = await sendIdle("fixture-fyi-idle", "fyi");
		expect(fyi.receipts).toMatchObject([{ state: "queued", via: null }]);
		// Even a push dispatched by an older daemon must not turn an FYI into a prompt.
		daemon.service.sessions.extensionFor(agentId)?.emit("push", {
			message: { id: fyi.message.id, priority: "fyi" },
			text: "fixture-fyi-idle",
		});
		const normal = await sendIdle("fixture-idle-wake", "normal");
		expect(normal.receipts).toMatchObject([
			{ state: "sent", via: "extension" },
		]);
		await until(
			() =>
				daemon.store.receipt(normal.message.id, agentId)?.state === "delivered",
		);
		const idleTranscript = await daemon.service.transcripts.page(agentId, null);
		expect(
			idleTranscript.events.some((event) =>
				event.text.includes("fixture-idle-wake"),
			),
		).toBe(true);
		expect(
			idleTranscript.events.some((event) =>
				event.text.includes("fixture-fyi-idle"),
			),
		).toBe(false);
		expect(daemon.store.receipt(fyi.message.id, agentId)?.state).toBe("queued");
		await until(async () => (await current())?.status === "idle");
		await until(async () => (await current())?.capabilities?.skills === true);
		const caps = {
			surface: "managed-acp",
			modes: true,
			commands: true,
			resume: true,
			approvals: true,
			skills: true,
			questions: true,
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
		const commands = await control().commands(agentId);
		expect(
			commands.commands.every((entry) => !Object.hasOwn(entry, "path")),
		).toBe(true);
		expect(commands.commands.filter(({ name }) => name === "model")).toEqual([
			expect.objectContaining({
				source: "agent",
				args: "<model>",
				argumentChoices: [
					{ value: "fixture-base", label: "Base" },
					{ value: "fixture-plan", label: "Planner" },
				],
			}),
		]);
		expect(commands).toMatchObject({
			runnable: true,
			commands: expect.arrayContaining([
				expect.objectContaining({
					name: "fixture-command",
					source: "agent",
					args: "details",
				}),
				expect.objectContaining({
					name: "fixture-local-skill",
					source: "project",
					skill: true,
				}),
				expect.objectContaining({
					name: "skill:fixture-command",
					source: "project",
					skill: true,
				}),
				expect.objectContaining({
					name: "skill:fixture-native-skill",
					source: "project",
					skill: true,
				}),
			]),
		});

		expect(await runCommand("/model fixture-plan")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(async () => (await current())?.model === "fixture-plan");
		const effort = () =>
			control()
				.commands(agentId)
				.then((catalog) =>
					catalog.commands.find(({ name }) => name === "effort"),
				);
		expect(await effort()).toMatchObject({
			argumentChoices: [
				{ value: "low", label: "Low" },
				{ value: "high", label: "High" },
			],
			currentArgument: "low",
			description: expect.stringContaining("Current: Low"),
		});
		expect(await runCommand("/effort high")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		expect(await effort()).toMatchObject({
			description: expect.stringContaining("Current: High"),
		});
		expect((await current())?.model).toBe("fixture-plan");
		expect((await control().modes(agentId)).current).toBe("plan-v2");
		expect(await runCommand("/effort status")).toMatchObject({ result: "ok" });
		await until(
			async () =>
				(await current())?.status === "idle" &&
				Boolean(
					bridge
						?.output()
						.includes("Fixture native effort command called: high"),
				),
		);
		expect(await runCommand("/effort low")).toMatchObject({ result: "ok" });
		await prompt("/model fixture-base");
		await until(
			async () =>
				(await current())?.status === "idle" &&
				Boolean(
					bridge
						?.output()
						.includes("Fixture received model syntax as prompt text"),
				),
		);
		expect((await current())?.model).toBe("fixture-plan");
		expect(await runCommand("/model wrong-model")).toMatchObject({
			result: "unsupported",
			detail: expect.stringContaining("fixture-base, fixture-plan"),
		});
		expect((await current())?.model).toBe("fixture-plan");
		expect(await runCommand("/model")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(
			async () =>
				(await current())?.status === "idle" &&
				Boolean(
					bridge?.output().includes("Fixture native model command called"),
				),
		);

		expect(await runCommand("/unknown")).toMatchObject({
			result: "unsupported",
			via: "acp",
		});
		expect(await runCommand("/fixture-command")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(
			async () =>
				(await current())?.status === "idle" &&
				Boolean(bridge?.output().includes("Fixture command called")),
		);
		expect(await runCommand("/fixture-local-skill on test")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(() =>
			Boolean(
				bridge?.output().includes("Fixture read installed skill: on test"),
			),
		);
		await until(async () => (await current())?.status === "idle");
		expect(await runCommand("/skill:fixture-native-skill")).toMatchObject({
			result: "ok",
			via: "acp",
		});
		await until(() =>
			Boolean(
				bridge?.output().includes("Fixture received native skill syntax"),
			),
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
		expect((await current())?.capabilities?.questions).toBe(true);
		answerable = true;
		const origin = "http://localhost:4100";
		const rp = { rpId: "localhost", origins: [origin] };
		const authenticator = new SoftAuthenticator({ origin, rpId: rp.rpId });
		const approvals = daemon.service.approvals;
		const registration = await approvals.passkeys.registrationOptions(
			user.login,
			rp,
			{ label: "Fixture" },
		);
		await approvals.passkeys.verifyRegistration(
			user.login,
			rp,
			authenticator.register(registration),
		);
		const pending = () => approvals.pendingFor(agentId)[0];
		await prompt("fixture-permission-diff");
		await until(() => pending()?.kind === "permission");
		const diffRequest = pending()!;
		expect(diffRequest.input).toMatchObject({
			arguments: {
				changes: [
					{ path: "fixture.txt", oldText: null, newText: "approved content" },
				],
			},
		});
		const diffOptions = (await approvals.options(
			user,
			rp,
			diffRequest.requestId,
			"allow-once",
		)) as { options: { challenge: string } };
		expect(
			(
				await approvals.decide(user, rp, diffRequest.requestId, {
					decision: "allow-once",
					assertion: authenticator.assert(diffOptions.options),
				})
			).won,
		).toBe(true);
		await until(() => Boolean(bridge?.output().includes("Permission allow")));
		const answerQuestion = async (answer: InteractionAnswer) => {
			await until(() => pending()?.kind === "question");
			const requestId = pending()!.requestId;
			const options = (await approvals.options(user, rp, requestId, "answer", {
				answer,
			})) as { options: { challenge: string } };
			const result = await approvals.decide(user, rp, requestId, {
				decision: "answer",
				answer,
				assertion: authenticator.assert(options.options),
			});
			expect(result.won).toBe(true);
		};
		await prompt("fixture-legacy-question");
		await answerQuestion({
			kind: "question",
			answers: { choice: ["Preview"] },
		});
		await until(() =>
			Boolean(bridge?.output().includes("Question selected b")),
		);
		await prompt("fixture-form-question");
		await answerQuestion({
			kind: "question",
			answers: {
				env: ["Production"],
				reason: ["Test run"],
				repeats: ["2"],
				confirm: ["Yes"],
				extra: ["Skip this field"],
				flags: ["trace", "profile"],
			},
		});
		await until(() =>
			Boolean(
				bridge
					?.output()
					.includes(
						'Form selected {"env":"prod","reason":"Test run","repeats":2,"confirm":true,"flags":["trace","profile"]}',
					),
			),
		);
		await prompt("fixture-form-question");
		await until(() => pending()?.kind === "question");
		expect(await op.call("stop", { agent: agentId })).toMatchObject({
			result: "interrupted",
		});
		await until(
			() =>
				!pending() &&
				Boolean(bridge?.output().includes("Fixture elicitation cancel")),
		);
		await prompt("fixture-detached");
		await until(
			async () =>
				pending()?.kind === "question" && (await current())?.status === "busy",
		);
		expect(await control().modes(agentId)).toMatchObject({ canSwitch: false });
		const behindDetached = await op.call<{ message: { id: string } }>("send", {
			to: agentId,
			body: "fixture-normal-while-busy-detached",
			priority: "normal",
		});
		const detachedFollower = () =>
			daemon.store.receipt(behindDetached.message.id, agentId);
		expect(detachedFollower()?.state).toBe("queued");
		await answerQuestion({ kind: "question", answers: { choice: ["Yes"] } });
		await until(
			async () =>
				(await current())?.status === "idle" &&
				Boolean(bridge?.output().includes("Detached says hello.")),
		);
		await until(() => detachedFollower()?.state === "delivered");
		const detached = await op.call<TranscriptPageResult>("transcript.read", {
			agent: agentId,
		});
		expect(detached.events).toContainEqual(
			expect.objectContaining({
				kind: "tool_result",
				text: "Buffered background result",
				tool: expect.objectContaining({ name: "Background watcher" }),
			}),
		);
		expect(detached.events).toContainEqual(
			expect.objectContaining({
				role: "assistant",
				text: "Detached says hello.",
			}),
		);
		expect(
			detached.events.some((event) =>
				event.text.includes("Foreign detached content"),
			),
		).toBe(false);
		await prompt("fixture-detached-request-only");
		await until(
			async () =>
				pending()?.kind === "question" && (await current())?.status === "busy",
		);
		expect(await op.call("stop", { agent: agentId })).toMatchObject({
			result: "interrupted",
		});
		await until(
			async () =>
				!pending() &&
				(await current())?.status === "idle" &&
				Boolean(bridge?.output().includes("Detached question cancelled")),
		);
		await prompt("fixture-child");
		const children = () => daemon.service.subagents.list(agentId);
		await until(() =>
			Boolean(bridge?.output().includes("Parent is still working")),
		);
		await until(async () => (await children()).total === 2);
		const listed = (await children()).items;
		const childAgent = listed.find(({ name }) => name === "Fixture child")!;
		const grandchild = listed.find(
			({ name }) => name === "Fixture grandchild",
		)!;
		expect(grandchild.parentSubId).toBe(childAgent.id);
		expect(childAgent.messaging.mode).toBe("parent");
		expect(childAgent.canStop).toBe(true);
		expect(grandchild.canStop).toBe(false);
		expect((await current())?.capabilities?.subagents).toBe(true);
		const childHistory = await op.call<TranscriptPageResult>(
			"transcript.read",
			{ agent: childAgent.id },
		);
		expect(childHistory.events).toContainEqual(
			expect.objectContaining({ text: "Exact child reply" }),
		);
		expect(childHistory.events).toContainEqual(
			expect.objectContaining({
				text: "Work for child",
				from: "Parent session",
			}),
		);
		expect(
			childHistory.events.some(
				({ text }) =>
					text === "Unannounced text" || text === "Status for parent",
			),
		).toBe(false);
		const childApproval = (tool: string) =>
			approvals.pendingFor(childAgent.id).find((card) => card.tool === tool);
		await until(
			() =>
				Boolean(childApproval("Fixture child permission")) &&
				approvals.pendingFor(grandchild.id)[0]?.kind === "question",
		);
		expect(approvals.pendingFor(agentId)).toEqual([]);
		expect(daemon.service.registry.needingYou().map(({ id }) => id)).toContain(
			childAgent.id,
		);
		const childRequestId = childApproval("Fixture child permission")!.requestId;
		const allow = (await approvals.options(
			user,
			rp,
			childRequestId,
			"allow-once",
			{},
		)) as { options: { challenge: string } };
		expect(
			await approvals.decide(user, rp, childRequestId, {
				decision: "allow-once",
				assertion: authenticator.assert(allow.options),
			}),
		).toMatchObject({ won: true, approval: { agentId: childAgent.id } });
		await until(
			() =>
				Boolean(
					bridge?.output().includes("Fixture permission 991 child-allow"),
				) &&
				Boolean(bridge?.output().includes("Fixture permission 994 cancelled")),
		);
		expect(await op.call("stop", { agent: grandchild.id })).toMatchObject({
			result: "unsupported",
		});
		expect(await op.call("stop", { agent: childAgent.id })).toMatchObject({
			result: "interrupted",
		});
		await until(
			async () =>
				(await children()).items.find(({ id }) => id === childAgent.id)
					?.canStop === false &&
				!childApproval("Fixture child cancellable permission") &&
				Boolean(bridge?.output().includes("Fixture permission 992 cancelled")),
		);
		const nestedRequest = approvals.pendingFor(grandchild.id)[0]!;
		expect(nestedRequest).toMatchObject({
			kind: "question",
			agentId: grandchild.id,
		});
		const nestedAnswer = {
			kind: "question",
			answers: { value: ["Grandchild answer"] },
		};
		const nestedProof = (await approvals.options(
			user,
			rp,
			nestedRequest.requestId,
			"answer",
			{ answer: nestedAnswer },
		)) as { options: { challenge: string } };
		expect(
			await approvals.decide(user, rp, nestedRequest.requestId, {
				decision: "answer",
				answer: nestedAnswer,
				assertion: authenticator.assert(nestedProof.options),
			}),
		).toMatchObject({ won: true });
		await until(() =>
			Boolean(
				bridge?.output().includes("Fixture grandchild got Grandchild answer"),
			),
		);
		expect((await current())?.status).toBe("busy");
		expect(await op.call("stop", { agent: agentId })).toMatchObject({
			result: "interrupted",
		});
		await until(async () => (await current())?.status === "idle");
		answerable = false;
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
		const urgent = (body: string) =>
			op.call<{ message: { id: string } }>("send", {
				to: agentId,
				body,
				priority: "urgent",
			});
		const steered = await urgent("fixture-steer");
		await until(
			() =>
				daemon.store.receipt(steered.message.id, agentId)?.state ===
					"delivered" &&
				Boolean(bridge?.output().includes("Steered inside holding turn")),
		);
		expect((await current())?.status).toBe("busy");
		const unconfirmed = await urgent("fixture-unconfirmed");
		await until(
			() =>
				daemon.store.receipt(unconfirmed.message.id, agentId)?.state ===
				"nacked",
		);
		expect(await control().modes(agentId)).toMatchObject({
			current: "plan-v2",
			canSwitch: false,
		});
		expect(await changeMode("ask")).toMatchObject({
			result: "busy",
			via: "acp",
		});
		expect(await runCommand("/model fixture-base")).toMatchObject({
			result: "busy",
			via: "acp",
		});
		expect((await current())?.model).toBe("fixture-plan");
		// Replaying a queued receipt after restart must not start a second turn.
		const sent = daemon.store.receipt(held.message.id, agentId)!;
		daemon.store.setReceipt({ ...sent, state: "queued" });
		const heldAcrossReconnect = await op.call<{ message: { id: string } }>(
			"send",
			{
				to: agentId,
				body: "fixture-normal-while-busy-restart",
			},
		);
		const queuedAcrossReconnect = () =>
			daemon.store.receipt(heldAcrossReconnect.message.id, agentId);
		expect(queuedAcrossReconnect()).toMatchObject({
			state: "queued",
			via: "pulsar-next-turn",
		});
		op.close();
		await daemon.stop();
		daemon = new Daemon({
			socket: join(env.home, "bus.sock"),
			db: join(env.home, "pulsar.db"),
			scan: false,
			remote: { mode: "off" },
		});
		expect(await daemon.start()).toBe(true);
		daemon.service.registry.idleSettleMs = 25;
		op = await operator();
		await until(
			async () =>
				(await current())?.status === "busy" &&
				(await current())?.reach === "push",
			4000,
		);
		expect(queuedAcrossReconnect()).toMatchObject({
			state: "queued",
			via: "pulsar-next-turn",
		});
		expect(await op.call("stop", { agent: agentId })).toMatchObject({
			result: "interrupted",
		});
		await until(
			() =>
				daemon.store.receipt(held.message.id, agentId)?.state === "delivered",
		);
		await until(() => queuedAcrossReconnect()?.state === "delivered");
		expect(bridge.output().match(/Holding/g)?.length).toBe(1);
		await prompt("fixture-hold");
		await until(() => (bridge?.output().match(/Holding/g)?.length ?? 0) === 2);
		const normalBehindTurn = await op.call<{ message: { id: string } }>(
			"send",
			{
				to: agentId,
				body: "fixture-normal-while-busy",
				priority: "normal",
			},
		);
		const secondNormal = await op.call<{ message: { id: string } }>("send", {
			to: agentId,
			body: "fixture-normal-while-busy-second",
			priority: "normal",
		});
		expect(
			daemon.store.receipt(normalBehindTurn.message.id, agentId)?.state,
		).not.toBe("delivered");
		const fallback = await urgent("fixture-next-turn");
		await until(
			() =>
				daemon.store.receipt(fallback.message.id, agentId)?.state ===
					"delivered" && Boolean(bridge?.output().includes("Queued turn ran")),
		);
		expect(bridge.output().match(/Queued turn ran/g)?.length).toBe(1);
		await until(
			() =>
				daemon.store.receipt(normalBehindTurn.message.id, agentId)?.state ===
					"delivered" &&
				Boolean(bridge?.output().includes("Normal turn ran separately")),
		);
		await until(
			() =>
				daemon.store.receipt(secondNormal.message.id, agentId)?.state ===
				"delivered",
		);
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
		expect(history.events).toContainEqual(
			expect.objectContaining({
				role: "user",
				subtype: "command",
				text: "/fixture-local-skill on test",
			}),
		);
		for (const body of [
			"fixture-steer",
			"fixture-next-turn",
			"fixture-normal-while-busy",
		]) {
			expect(
				history.events.filter((event) => event.text === body),
			).toHaveLength(1);
		}
		expect(
			history.events.some((event) => event.text === "fixture-unconfirmed"),
		).toBe(false);
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
		await prompt("fixture-long-result");
		await until(
			async () =>
				(await current())?.status === "idle" &&
				bridge!.output().includes("end-of-reply"),
		);
		const extended = await op.call<TranscriptPageResult>("transcript.read", {
			agent: agentId,
		});
		const blocks = new Map(
			extended.events
				.filter(
					(e) =>
						e.role === "assistant" && /(?:AAAA|BBBB|end-of-reply)/.test(e.text),
				)
				.map((e) => [e.id, e.text]),
		);
		expect([...blocks.values()].join("")).toBe(
			`${"A".repeat(32 * 1024 - 1)}🚀${"B".repeat(40 * 1024)}end-of-reply`,
		);
		expect(
			extended.events
				.filter((e) => e.kind === "tool_call" && e.tool?.callId === "read")
				.at(-1)?.tool?.input,
		).toEqual({ offset: 4, path: "fixture.ts" });
		expect(
			extended.events.filter(
				(e) => e.kind === "tool_result" && e.tool?.callId !== "late-tool",
			),
		).toMatchObject([
			{ text: "file contents", tool: { name: "Read file", callId: "read" } },
			{
				text: "file.ts\n---\nold\n+++\nnew",
				tool: { name: "Edit file", callId: "write" },
			},
		]);
		bridge.child.kill("SIGTERM");
		expect(await bridge.exit).toBe(0);
		await until(async () => (await current())?.status !== "idle");

		for (const mode of ["resume", "load"]) {
			bridge = launch(sessionId, mode);
			await session();
			expect((await current())?.sessionId).toBe(sessionId);
			expect((await current())?.capabilities?.steer).toBe(false);
			await until(() => Boolean(bridge?.output().includes("Holding")));
			expect(bridge.output().match(/Holding/g)?.length).toBe(1);
			expect(await op.call("stop", { agent: agentId })).toMatchObject({
				result: "interrupted",
			});
			await until(async () => (await current())?.status === "idle");
			expect(await runCommand("/model")).toMatchObject({
				result: "unsupported",
				detail: expect.stringContaining("fixture-base, fixture-plan"),
			});
			expect(await runCommand("/effort missing")).toMatchObject({
				result: "unsupported",
				detail: expect.stringContaining("low, high"),
			});
			await selectPlan();
			if (mode === "resume") {
				await until(async () => (await current())?.model === "fixture-plan");
				expect((await daemon.service.agentUsage(agentId, user)).model).toBe(
					"fixture-plan",
				);
			}
			bridge.child.kill("SIGTERM");
			expect(await bridge.exit).toBe(0);
		}

		for (const mode of ["wrong-resume", "wrong-load"]) {
			bridge = launch(sessionId, mode);
			expect(await bridge.exit).toBe(1);
			expect(bridge.output()).toContain("returned a different session ID");
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
