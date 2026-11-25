import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeSessionDir } from "../src/harnesses/claude-subagents.ts";
import { claudeSubagentHook } from "../src/hook.ts";
import {
	agentClient,
	registration,
	restoreEnv,
	startDaemon,
} from "./helpers.ts";
import { writeClaudeSub } from "./subagent-fixtures.ts";

test("a Claude subagent hook receives queued context for its own child and confirms handoff", async () => {
	const { daemon, home, cleanup } = await startDaemon();
	const previous = process.env.CLAUDE_CONFIG_DIR;
	process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
	try {
		const service = daemon.service;
		const sessionId = "00001111-2222-4333-8444-555566667777";
		const cwd = "/work/claude-hook";
		const parent = service.registry.upsert({
			harness: "claude",
			sessionId,
			pid: process.pid,
			cwd,
			name: "Test lead",
			project: null,
			branch: null,
			tags: [],
			meta: {},
			registered: false,
			status: "busy",
		});
		await mkdir(join(home, "claude", "sessions"), { recursive: true });
		await writeFile(
			join(home, "claude", "sessions", `${process.pid}.json`),
			JSON.stringify({ pid: process.pid, sessionId }),
		);
		const folder = claudeSessionDir(cwd, sessionId)!;
		writeClaudeSub(folder, "a1ab", { name: "Probe child", finished: false });
		writeClaudeSub(folder, "a2cd", { name: "Sibling child", finished: false });
		const childId = `${parent.id}/sub:a1ab`;
		let context: string[] = [];
		const hook = (
			event: string,
			key = "a1ab",
			out = (text: string) => {
				context.push(text);
			},
		) =>
			claudeSubagentHook(
				JSON.stringify({
					hook_event_name: event,
					session_id: sessionId,
					agent_id: key,
					cwd,
				}),
				async (text) => out(text),
				join(home, "bus.sock"),
				process.pid,
			);

		await service.subagents.refresh(parent.id);
		expect((await service.subagents.get(childId)).messaging.mode).toBe(
			"parent",
		);
		await hook("SubagentStart");
		await service.subagents.refresh(parent.id);
		expect((await service.subagents.get(childId)).messaging).toMatchObject({
			mode: "direct",
			note: expect.stringMatching(/hook/i),
		});
		const sent = await service.app.send(
			{
				kind: "human",
				login: "developer@example.com",
				node: "local",
				verified: true,
				name: "Developer",
			},
			{ ids: [childId], body: "Check the test marker." },
		);
		expect("receipts" in sent).toBe(true);
		if (!("receipts" in sent)) throw new Error("missing receipt");
		const receipt = sent.receipts[0]!;
		expect(receipt).toMatchObject({ agentId: childId, state: "queued" });
		await hook("PostToolUse", "a2cd");
		expect(context).toEqual([]);
		await expect(
			hook("PostToolUse", "a1ab", () => {
				throw Error("closed output");
			}),
		).rejects.toThrow("closed output");
		expect(daemon.store.receipt(receipt.messageId, childId)?.state).toBe(
			"queued",
		);
		await hook("PostToolUse");
		expect(context).toHaveLength(1);
		const output = JSON.parse(context[0]!);
		expect(output).toEqual({
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: expect.stringContaining(
					"[human operator - Developer] Check the test marker.",
				),
			},
		});
		expect(daemon.store.receipt(receipt.messageId, childId)).toMatchObject({
			state: "delivered",
			via: "claude-subagent-hook",
		});
		const preToolInput = {
			hook_event_name: "PreToolUse",
			session_id: sessionId,
			agent_id: "a1ab",
			cwd,
			tool_name: "mcp__pulsar__respond",
			tool_use_id: "toolu_fixture_test",
			tool_input: {
				message_id: receipt.messageId,
				state: "reply",
				text: "Child answer",
			},
		};
		const checkTool = async (overrides: Record<string, unknown> = {}) => {
			let output = "";
			await claudeSubagentHook(
				JSON.stringify({ ...preToolInput, ...overrides }),
				async (value) => {
					output = value;
				},
				join(home, "bus.sock"),
				process.pid,
			);
			return output ? JSON.parse(output).hookSpecificOutput : null;
		};
		const tool = await checkTool();
		const proof = tool.updatedInput.sourceProof;
		expect(tool).toMatchObject({
			hookEventName: "PreToolUse",
			updatedInput: {
				...preToolInput.tool_input,
				sourceProof: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(tool.permissionDecision).toBeUndefined();
		expect(await checkTool()).toMatchObject({ permissionDecision: "deny" });
		expect(
			await checkTool({
				tool_use_id: "toolu_unsupported",
				tool_name: "mcp__pulsar__unsupported",
			}),
		).toMatchObject({ permissionDecision: "deny" });
		const hello = registration({
			role: "cli",
			harness: "claude",
			sessionId,
			pid: process.pid,
			cwd,
		});
		const bound = (await agentClient(hello)).client;
		const other = (await agentClient(hello)).client;
		try {
			await expect(
				bound.call("claude.subagent.bind", { proof, tool: "send" }),
			).rejects.toThrow("no valid Claude subagent proof");
			expect(
				await bound.call("claude.subagent.bind", { proof, tool: "respond" }),
			).toMatchObject({ agent: { id: childId } });
			await expect(
				other.call("claude.subagent.bind", { proof, tool: "respond" }),
			).rejects.toThrow("no valid Claude subagent proof");
			await expect(
				bound.call("send", { to: "*", body: "Invalid" }),
			).rejects.toThrow("outside this Claude subagent tool proof");
			const answered = await bound.call<{
				message: { fromId: string; fromName: string };
			}>("reply", {
				messageId: receipt.messageId,
				body: "Child answer",
			});
			expect(answered.message).toMatchObject({
				fromId: childId,
				fromName: "Probe child",
			});
			await expect(
				bound.call("reply", {
					messageId: receipt.messageId,
					body: "Duplicate",
				}),
			).rejects.toThrow("already sent its update");
		} finally {
			bound.close();
			other.close();
		}

		const identityInput = {
			tool_use_id: "toolu_fixture_identity",
			tool_name: "mcp__pulsar__set_identity",
			tool_input: { name: "Named child", activity: "Checking the fixture" },
		};
		const identity = await checkTool(identityInput);
		const identityRpc = (await agentClient(hello)).client;
		const reopened = (await agentClient(hello)).client;
		try {
			await identityRpc.call("claude.subagent.bind", {
				proof: identity.updatedInput.sourceProof,
				tool: "set_identity",
			});
			expect(
				await identityRpc.call("set_identity", identityInput.tool_input),
			).toMatchObject({
				agent: {
					id: childId,
					name: "named-child",
					activity: "Checking the fixture",
				},
			});
			expect(daemon.store.loadIdentity(childId)).toMatchObject({
				name: "named-child",
				activity: "Checking the fixture",
			});
			expect(daemon.store.loadIdentity(parent.id)?.name).toBeUndefined();
			expect(service.registry.get(parent.id)?.name).toBe("Test lead");
			await service.subagents.refresh(parent.id);
			expect((await service.subagents.get(childId)).name).toBe("named-child");

			const next = await checkTool({
				...identityInput,
				tool_use_id: "toolu_read_identity",
				tool_input: {},
			});
			await reopened.call("claude.subagent.bind", {
				proof: next.updatedInput.sourceProof,
				tool: "set_identity",
			});
			expect(await reopened.call("whoami")).toMatchObject({
				agent: { id: childId, name: "named-child" },
			});
		} finally {
			identityRpc.close();
			reopened.close();
		}

		context = [];
		await hook("PostToolUse");
		await hook("SubagentStop");
		await service.subagents.refresh(parent.id);
		expect((await service.subagents.get(childId)).messaging.mode).toBe(
			"parent",
		);
		expect(context).toEqual([]);
	} finally {
		await daemon.stop();
		restoreEnv("CLAUDE_CONFIG_DIR", previous);
		cleanup();
	}
});
