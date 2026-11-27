import {
	afterAll,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";

// Each test starts real MCP server processes (about a second each).
setDefaultTimeout(20_000);

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Daemon } from "../src/daemon.ts";
import { claudeSessionDir } from "../src/harnesses/claude-subagents.ts";
import { restoreEnv, startDaemon, until } from "./helpers.ts";
import { writeClaudeSub } from "./subagent-fixtures.ts";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
let daemon: Daemon;
let home: string;
let cleanup: () => void;
const clients: Client[] = [];

async function mcpClient(harness: string, cwd: string, sessionId: string) {
	const transport = new StdioClientTransport({
		command: "node",
		args: [cli, "mcp"],
		cwd,
		env: {
			...(process.env as Record<string, string>),
			PULSAR_HOME: home,
			PULSAR_HARNESS: harness,
			PULSAR_SESSION_ID: sessionId,
		},
		stderr: "ignore",
	});
	const client = new Client({ name: "pulsar-test", version: "0.0.0" });
	await client.connect(transport);
	clients.push(client);
	return client;
}

function textOf(result: unknown): string {
	const content = (
		result as { content: Array<{ type: string; text?: string }> }
	).content;
	return content.map((c) => c.text ?? "").join("\n");
}

beforeAll(async () => {
	({ daemon, home, cleanup } = await startDaemon());
});

afterAll(async () => {
	for (const c of clients) await c.close();
	await daemon.stop();
	cleanup();
});

describe("MCP server", () => {
	test("exposes the tools with instructions", async () => {
		const a = await mcpClient("codex", "/tmp", "mcp-a");
		const tools = (await a.listTools()).tools.map((t) => t.name).sort();
		expect(tools).toEqual([
			"inbox",
			"list_agents",
			"respond",
			"send",
			"set_identity",
			"wait",
		]);
		expect(a.getInstructions()).toContain("Pulsar connects you");
		// `list_agents question=` looks up without sending anything.
		const who = (await a.callTool({
			name: "list_agents",
			arguments: { question: "who is editing src/nowhere.ts" },
		})) as { content: Array<{ text: string }> };
		expect(who.content[0]!.text).toContain("Nobody matches");
	});

	test("two harnesses find each other, tag, multicast and reply", async () => {
		const codex = await mcpClient("codex", "/tmp", "mcp-codex");
		const copilot = await mcpClient("copilot", "/tmp", "mcp-copilot");

		const who = textOf(
			await codex.callTool({ name: "set_identity", arguments: {} }),
		);
		expect(who).toContain("codex@");

		await copilot.callTool({
			name: "set_identity",
			arguments: { tags_add: ["workstream:docs"] },
		});
		const listed = textOf(
			await codex.callTool({
				name: "list_agents",
				arguments: { selector: "workstream=docs" },
			}),
		);
		expect(listed).toContain("copilot@");

		const sent = textOf(
			await codex.callTool({
				name: "send",
				arguments: {
					to: "workstream=docs",
					body: "can you review the README?",
				},
			}),
		);
		expect(sent).toMatch(/Sent m_\w+ to 1 agent/);
		const id = /Sent (m_\w+)/.exec(sent)![1]!;

		const inbox = textOf(
			await copilot.callTool({ name: "inbox", arguments: {} }),
		);
		expect(inbox).toContain("can you review the README?");

		await copilot.callTool({
			name: "respond",
			arguments: { message_id: id, state: "reply", text: "on it" },
		});
		const back = textOf(await codex.callTool({ name: "inbox", arguments: {} }));
		expect(back).toContain("on it");
	});

	test("errors come back as tool errors, not crashes", async () => {
		const a = await mcpClient("codex", "/tmp", "mcp-err");
		const r = (await a.callTool({
			name: "send",
			arguments: { to: "project=nobody", body: "x" },
		})) as { isError?: boolean };
		expect(r.isError).toBe(true);
		expect(textOf(r)).toContain("no live agent");
	});

	test("unread note is appended for pull-only agents", async () => {
		const sender = await mcpClient("codex", "/tmp", "mcp-s");
		const pull = await mcpClient("cursor", "/tmp", "mcp-p");
		const pullName = /You are (\S+)/.exec(
			textOf(await pull.callTool({ name: "whoami", arguments: {} })),
		)![1]!;
		await sender.callTool({
			name: "send",
			arguments: { to: pullName, body: "heads up" },
		});
		const listed = textOf(
			await pull.callTool({ name: "list_agents", arguments: {} }),
		);
		expect(listed).toContain("1 unread Pulsar message");
	});

	test("OpenCode: one shared server, one agent per session (from _meta)", async () => {
		const oc = await mcpClient("opencode", "/tmp", "");
		const who = async (sid: string) =>
			textOf(
				await oc.callTool({
					name: "whoami",
					arguments: {},
					_meta: { "ai.opencode/sessionID": sid },
				}),
			);
		const a = await who("ses_aaa");
		const b = await who("ses_bbb");
		expect(a).toContain("opencode:ses_aaa");
		expect(b).toContain("opencode:ses_bbb");
		expect(daemon.live().filter((x) => x.harness === "opencode")).toHaveLength(
			2,
		);
		expect(
			textOf(await oc.callTool({ name: "whoami", arguments: {} })),
		).toContain("did not identify the calling session");
	});

	test("Codex: a provider thread ID binds a nested child under its verified root", async () => {
		const ids = [
			"00000000-0000-0000-0000-000000000011",
			"00000000-0000-0000-0000-000000000012",
			"00000000-0000-0000-0000-000000000013",
			"00000000-0000-0000-0000-000000000014",
		];
		const root = join(home, "codex-child-test");
		const day = join(root, "sessions", "2026", "11", "25");
		mkdirSync(day, { recursive: true });
		for (const [i, id] of ids.entries()) {
			const source = i
				? {
						subagent: {
							thread_spawn: { parent_thread_id: ids[i === 3 ? 1 : i - 1] },
						},
					}
				: "cli";
			writeFileSync(
				join(day, `rollout-2026-11-25T00-00-00-${id}.jsonl`),
				`${JSON.stringify({
					type: "session_meta",
					payload: { id, cwd: "/tmp", source },
				})}\n`,
			);
		}
		const previousHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = root;
		try {
			const cx = await mcpClient("codex", "/tmp", ids[0]!);
			const invoke = (threadId: string) =>
				cx.callTool({
					name: "whoami",
					arguments: {},
					_meta: { threadId, sessionId: "native-host-session" },
				});
			const child = textOf(await invoke(ids[2]!));
			expect(child).toContain(`codex:${ids[0]}/sub:${ids[2]}`);
			expect(daemon.service.registry.get(`codex:${ids[2]}`)).toBeUndefined();
			expect(textOf(await invoke("unverified"))).toContain(
				"valid invoking thread ID",
			);
			const legacy = textOf(
				await cx.callTool({ name: "whoami", arguments: {} }),
			);
			expect(legacy).toContain(`codex:${ids[0]}`);
			expect(legacy).not.toContain("/sub:");
			const from = ids[2]!;
			const to = ids[3]!;
			const address = `codex:${ids[0]}/sub:${to}`;
			expect(textOf(await invoke(to))).toContain(address);
			const send = textOf(
				await cx.callTool({
					name: "send",
					arguments: { to: address, body: "Sibling delivery test" },
					_meta: { threadId: from },
				}),
			);
			expect(send).toMatch(/Sent m_\w+ to 1 agent/);
			const inbox = async (threadId: string) =>
				textOf(
					await cx.callTool({
						name: "inbox",
						arguments: {},
						_meta: { threadId },
					}),
				);
			expect(await inbox(ids[0]!)).not.toContain("Sibling delivery test");
			expect(await inbox(ids[1]!)).not.toContain("Sibling delivery test");
			expect(await inbox(to)).toContain("Sibling delivery test");
		} finally {
			restoreEnv("CODEX_HOME", previousHome);
		}
	});

	test("the MCP wait tool observes an unaddressable child by exact ID before the first scan", async () => {
		const old = process.env.CLAUDE_CONFIG_DIR;
		process.env.CLAUDE_CONFIG_DIR = join(home, "child-wait");
		const sid = "c44d5933-132e-4501-a2a3-55550247bc88";
		try {
			const parent = await mcpClient("claude", home, sid);
			await parent.callTool({ name: "whoami", arguments: {} });
			const observer = await mcpClient("codex", home, "mcp-child-wait");
			const parentId = `claude:${sid}`;
			const childId = `${parentId}/sub:abced1`;
			const folder = claudeSessionDir(
				daemon.service.registry.get(parentId)!.cwd,
				sid,
			)!;
			writeClaudeSub(folder, "abced1", { agentType: "MCP worker" });
			const result = observer.callTool({
				name: "wait",
				arguments: {
					for: `idle:${daemon.service.machineId}/${childId}`,
					timeout_seconds: 5,
				},
			});
			await until(() => daemon.service.waiters.size === 1);
			writeClaudeSub(folder, "abced1", {
				agentType: "MCP worker",
				finished: true,
			});
			await daemon.service.subagents.refresh(parentId);
			expect(textOf(await result)).toContain(
				"MCP worker is gone (its session ended).",
			);
		} finally {
			restoreEnv("CLAUDE_CONFIG_DIR", old);
		}
	});

	test("Claude: invalid injected proof refuses the tool instead of using the parent", async () => {
		const cx = await mcpClient("claude", "/tmp", "claude-proof-parent");
		const result = await cx.callTool({
			name: "whoami",
			arguments: { sourceProof: "not-a-proof" },
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Invalid Claude child tool proof");
	});
});
