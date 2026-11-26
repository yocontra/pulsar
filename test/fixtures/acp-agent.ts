import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const sessionId = "fixture/acp";
const mode = process.env.ACP_FIXTURE_MODE;
const reply = (id: number, result: unknown) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const emit = (method: string, params: unknown, id?: number) =>
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: "2.0", method, params, id })}\n`,
	);
const update = (text: string) =>
	emit("session/update", {
		sessionId,
		update: {
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text },
		},
	});
const lines = createInterface({ input: process.stdin });
let mcp: ReturnType<typeof spawn> | undefined;
let mcpResult: ((text: string) => void) | undefined;
let promptId: number | undefined;
const permissionId = 987;
let currentMode = "ask";
const modes = () => ({
	currentModeId: currentMode,
	availableModes: [
		{ id: "ask", name: "Ask" },
		{ id: "plan-v2", name: "Plan" },
	],
});
const config = () => [
	{
		id: "fixture.mode",
		name: "Session mode",
		category: "mode",
		type: "select",
		currentValue: currentMode,
		options: [
			{
				group: "modes",
				name: "Modes",
				options: [
					{ value: "ask", name: "Ask" },
					{ value: "plan-v2", name: "Plan" },
				],
			},
		],
	},
];

for await (const line of lines) {
	const { id, method, params, result } = JSON.parse(line);
	switch (method) {
		case "initialize":
			reply(id, {
				protocolVersion: 1,
				agentCapabilities:
					mode === "unsupported"
						? {}
						: {
								loadSession: mode === "load",
								sessionCapabilities:
									mode === "load" ? {} : { resume: {}, close: {} },
							},
			});
			break;
		case "session/new":
		case "session/resume":
		case "session/load": {
			if (method !== "session/new" && params.sessionId !== sessionId)
				throw new Error("Fixture session id mismatch");
			if (mode === "resume" && method !== "session/resume")
				throw new Error("Fixture expected session/resume");
			if (mode === "load" && method !== "session/load")
				throw new Error("Fixture expected session/load");
			const spec = params.mcpServers.find(
				(item: { name: string }) => item.name === "pulsar",
			);
			if (!spec)
				throw new Error("Pulsar MCP was not passed to the ACP session");
			const child = spawn(spec.command, spec.args, {
				env: {
					...process.env,
					...Object.fromEntries(
						spec.env.map(({ name, value }: { name: string; value: string }) => [
							name,
							value,
						]),
					),
				},
				stdio: ["pipe", "pipe", "inherit"],
			});
			mcp = child;
			const write = (id: number, method: string, params: unknown) =>
				child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			const mcpLines = createInterface({ input: child.stdout });
			write(1, "initialize", {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "fixture", version: "1" },
			});
			mcpLines.on("line", (message) => {
				const data = JSON.parse(message);
				if (data.id === 1) {
					// Providers can wait for child MCP initialization before returning the session id.
					emit("session/update", {
						sessionId,
						update: {
							sessionUpdate: "available_commands_update",
							availableCommands: [
								{
									name: "fixture-command",
									description: "Run the fixture command",
									input: { hint: "details" },
								},
							],
						},
					});
					reply(id, {
						...(method === "session/new" ? { sessionId } : {}),
						modes: modes(),
						...(mode === "resume" ? { configOptions: config() } : {}),
					});
				}
				if (data.id === 2) mcpResult?.(data.result.content[0].text);
			});
			break;
		}
		case "session/set_mode":
			if (mode === "resume")
				throw new Error("Fixture expected config mode selection");
			currentMode = params.modeId;
			emit("session/update", {
				sessionId,
				update: {
					sessionUpdate: "current_mode_update",
					currentModeId: currentMode,
				},
			});
			reply(id, {});
			break;
		case "session/set_config_option":
			if (mode !== "resume" || params.configId !== "fixture.mode")
				throw new Error("Fixture expected legacy mode selection");
			currentMode = params.value;
			reply(id, { configOptions: config() });
			break;
		case "session/prompt": {
			promptId = id;
			const text = params.prompt[0].text as string;
			const attachment = /^Attached: (.+) \(text\/plain, \d+ B\)$/m.exec(
				text,
			)?.[1];
			if (attachment) {
				update(await readFile(attachment, "utf8"));
				reply(id, { stopReason: "end_turn" });
			} else if (text.startsWith("/fixture-command")) {
				update("Fixture command called");
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-rejected")) {
				process.stdout.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Fixture prompt rejected" } })}\n`,
				);
			} else if (text.includes("fixture-hold")) {
				update("Holding");
			} else if (text.includes("fixture-permission")) {
				emit(
					"session/request_permission",
					{
						sessionId,
						toolCall: {
							title: "Fixture action",
							toolCallId: "test",
							rawInput: { command: "true" },
						},
						options: [
							{ optionId: "allow", kind: "allow_once", name: "Allow" },
							{ optionId: "deny", kind: "reject_once", name: "Deny" },
						],
					},
					permissionId,
				);
			} else if (text.includes("fixture-long-result")) {
				update("A".repeat(32 * 1024 - 1));
				update(`🚀${"B".repeat(40 * 1024)}`);
				update("end-of-reply");
				const tool = (update: unknown) =>
					emit("session/update", { sessionId, update });
				tool({
					sessionUpdate: "tool_call",
					toolCallId: "read",
					title: "Read file",
				});
				tool({
					sessionUpdate: "tool_call_update",
					toolCallId: "read",
					status: "in_progress",
					content: [
						{
							type: "content",
							content: { type: "text", text: "file contents" },
						},
					],
				});
				tool({
					sessionUpdate: "tool_call_update",
					toolCallId: "read",
					status: "completed",
				});
				tool({
					sessionUpdate: "tool_call",
					toolCallId: "write",
					title: "Edit file",
					status: "completed",
					content: [
						{ type: "diff", path: "file.ts", oldText: "old", newText: "new" },
					],
				});
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-tools")) {
				mcpResult = (message) => {
					update(message);
					reply(id, { stopReason: "end_turn" });
				};
				mcp?.stdin?.write(
					`${JSON.stringify({
						jsonrpc: "2.0",
						id: 2,
						method: "tools/call",
						params: { name: "set_identity", arguments: {} },
					})}\n`,
				);
			} else {
				update("Fixture ");
				update("ready");
				emit("session/update", {
					sessionId,
					update: {
						sessionUpdate: "usage_update",
						used: 120,
						size: 4096,
						cost: { amount: 0.003, currency: "USD" },
					},
				});
				reply(id, { stopReason: "end_turn" });
			}
			break;
		}
		case "session/cancel":
			if (promptId !== undefined) reply(promptId, { stopReason: "cancelled" });
			break;
		case "session/close":
			mcp?.kill();
			reply(id, {});
			break;
		default:
			if (id === permissionId && promptId !== undefined) {
				update(
					`Permission ${result.outcome.optionId ?? result.outcome.outcome}`,
				);
				reply(promptId, { stopReason: "end_turn" });
			}
	}
}
mcp?.kill();
