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

import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Daemon } from "../src/daemon.ts";
import { startDaemon } from "./helpers.ts";

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
		const gemini = await mcpClient("gemini", "/tmp", "mcp-gemini");

		const who = textOf(
			await codex.callTool({ name: "set_identity", arguments: {} }),
		);
		expect(who).toContain("codex@");

		await gemini.callTool({
			name: "set_identity",
			arguments: { tags_add: ["workstream:docs"] },
		});
		const listed = textOf(
			await codex.callTool({
				name: "list_agents",
				arguments: { selector: "workstream=docs" },
			}),
		);
		expect(listed).toContain("gemini@");

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
			await gemini.callTool({ name: "inbox", arguments: {} }),
		);
		expect(inbox).toContain("can you review the README?");

		await gemini.callTool({
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
	});
});
