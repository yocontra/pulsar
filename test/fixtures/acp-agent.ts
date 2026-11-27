import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const sessionId = "fixture/acp";
const childSessionId = "fixture/child";
const grandchildSessionId = "fixture/grandchild";
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
const questionPermissionId = 988;
const elicitationId = 989;
const detachedPermissionId = 990;
const childPermissionId = 991;
const childWaitingPermissionId = 992;
const childQuestionId = 993;
const strangerPermissionId = 994;
let currentMode = "ask";
let currentModel: string | undefined;
const modes = () => ({
	currentModeId: currentMode,
	availableModes: [
		{ id: "ask", name: "Ask" },
		{ id: "plan-v2", name: "Plan" },
	],
});
const modelOption = () => ({
	id: "fixture.model",
	name: "Model",
	category: "model",
	type: "select",
	currentValue:
		currentModel ?? (currentMode === "ask" ? "fixture-base" : "fixture-plan"),
	options: [
		{
			group: "models",
			name: "Fixture models",
			options: [
				{ value: "fixture-base", name: "Base" },
				{ value: "fixture-plan", name: "Planner" },
			],
		},
	],
});
const config = () => [
	modelOption(),
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
			if (!params.clientCapabilities.elicitation?.form)
				throw new Error("Fixture expected form capability");
			if (!params.clientCapabilities.subagents)
				throw new Error("Fixture expected exposed subagent support");
			reply(id, {
				protocolVersion: 1,
				...(mode === "steer"
					? {
							agentInfo: {
								name: "@agentclientprotocol/codex-acp",
								version: "2.12.0",
							},
							_meta: { steering: { supported: true } },
						}
					: {}),
				agentCapabilities:
					mode === "unsupported"
						? {}
						: {
								loadSession: mode === "load" || mode === "wrong-load",
								sessionCapabilities:
									mode === "load" || mode === "wrong-load"
										? {}
										: { resume: {}, close: {} },
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
			if (mode === "wrong-resume" || mode === "wrong-load") {
				if (
					method !==
					(mode === "wrong-resume" ? "session/resume" : "session/load")
				)
					throw new Error("A saved session must not start a new conversation");
				reply(id, { sessionId: "another-session" });
				break;
			}
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
								...(mode === "steer"
									? [{ name: "model", description: "Native model menu" }]
									: []),
								{
									name: "fixture-command",
									description: "Run the fixture command",
									input: { hint: "details" },
								},
								{
									name: "skill:fixture-native-skill",
									description: "Run the advertised skill",
								},
							],
						},
					});
					reply(id, {
						...(method === "session/new" ? { sessionId } : {}),
						modes: modes(),
						configOptions: mode === "resume" ? config() : [modelOption()],
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
			if (params.configId === "fixture.model") {
				if (
					!modelOption().options[0]?.options.some(
						({ value }) => value === params.value,
					)
				)
					throw new Error("Unknown ACP model sent to provider");
				currentModel = params.value;
			} else {
				if (mode !== "resume" || params.configId !== "fixture.mode")
					throw new Error("Fixture expected legacy mode selection");
				currentMode = params.value;
			}
			reply(id, {
				configOptions: mode === "resume" ? config() : [modelOption()],
			});
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
			} else if (text.includes("/model fixture-base")) {
				update("Fixture received model syntax as prompt text");
				reply(id, { stopReason: "end_turn" });
			} else if (text === "/model") {
				update("Fixture native model command called");
				reply(id, { stopReason: "end_turn" });
			} else if (text.startsWith("/fixture-command")) {
				update("Fixture command called");
				reply(id, { stopReason: "end_turn" });
			} else if (text.startsWith("/skill:fixture-native-skill")) {
				update("Fixture received native skill syntax");
				reply(id, { stopReason: "end_turn" });
			} else if (text.startsWith("Read the installed Antigravity skill at ")) {
				const path =
					/^Read the installed Antigravity skill at (".*") and follow its instructions\./.exec(
						text,
					)?.[1];
				if (
					!path ||
					!(await readFile(JSON.parse(path), "utf8")).includes(
						"Fixture skill instructions.",
					)
				)
					throw new Error(
						"Fixture skill prompt did not reference the installed skill",
					);
				update(
					`Fixture read installed skill: ${text.split("\n\nUser request: ")[1] ?? ""}`,
				);
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-idle-wake")) {
				update("Fixture woke from idle");
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-rejected")) {
				process.stdout.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message: "Fixture prompt rejected" } })}\n`,
				);
			} else if (text.includes("fixture-hold")) {
				update("Holding");
			} else if (text.includes("fixture-child")) {
				const emitUpdate = (sessionId: string, update: unknown) =>
					emit("session/update", { sessionId, update });
				emitUpdate(childSessionId, {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: "Unannounced text" },
				});
				emitUpdate(sessionId, {
					sessionUpdate: "subagent_update",
					sessionId: childSessionId,
					title: "Fixture child",
					capabilities: { cancel: {} },
					state: { state: "running" },
				});
				emitUpdate(childSessionId, {
					sessionUpdate: "subagent_update",
					sessionId: grandchildSessionId,
					title: "Fixture grandchild",
					state: { state: "running" },
				});
				emitUpdate(grandchildSessionId, {
					sessionUpdate: "subagent_update",
					sessionId: childSessionId,
					title: "Wrong parent",
				});
				emitUpdate(childSessionId, {
					sessionUpdate: "session_message",
					messageId: "from-parent",
					senderSessionId: sessionId,
					recipientSessionId: childSessionId,
					content: [{ type: "text", text: "Work for child" }],
				});
				for (const text of ["Exact ", "child reply"])
					emitUpdate(childSessionId, {
						sessionUpdate: "agent_message_chunk",
						messageId: "child-reply",
						content: { type: "text", text },
					});
				emitUpdate(sessionId, {
					sessionUpdate: "session_message",
					messageId: "from-child",
					senderSessionId: childSessionId,
					recipientSessionId: sessionId,
					content: [{ type: "text", text: "Status for parent" }],
				});
				const permissions = [
					{ optionId: "child-allow", name: "Allow once", kind: "allow_once" },
					{ optionId: "child-deny", name: "Deny", kind: "reject_once" },
				];
				for (const [id, target, title] of [
					[childPermissionId, childSessionId, "Fixture child permission"],
					[
						childWaitingPermissionId,
						childSessionId,
						"Fixture child cancellable permission",
					],
					[
						strangerPermissionId,
						"unannounced-session",
						"Unannounced permission",
					],
				] as const)
					emit(
						"session/request_permission",
						{
							sessionId: target,
							options: permissions,
							toolCall: {
								title,
								toolCallId: String(id),
								rawInput: { operation: "fixture-only" },
							},
						},
						id,
					);
				emit(
					"elicitation/create",
					{
						sessionId: grandchildSessionId,
						mode: "form",
						message: "Pick a fixture",
						requestedSchema: {
							type: "object",
							required: ["value"],
							properties: {
								value: { type: "string", enum: ["Grandchild answer"] },
							},
						},
					},
					childQuestionId,
				);
				update("Parent is still working");
			} else if (text.includes("fixture-detached")) {
				emit("session/update", {
					sessionId,
					update: {
						sessionUpdate: "tool_call",
						toolCallId: "late-tool",
						title: "Background watcher",
						status: "in_progress",
					},
				});
				emit("session/update", {
					sessionId,
					update: {
						sessionUpdate: "tool_call_update",
						toolCallId: "late-tool",
						rawOutput: "Buffered background result",
					},
				});
				reply(id, { stopReason: "end_turn" });
				promptId = undefined;
				setTimeout(() => {
					emit("session/update", {
						sessionId: "unrelated-session",
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: "Foreign detached content" },
						},
					});
					emit("session/update", {
						sessionId,
						update: {
							sessionUpdate: "tool_call_update",
							toolCallId: "late-tool",
							status: "completed",
						},
					});
					if (!text.includes("request-only")) update("Detached says ");
					emit(
						"session/request_permission",
						{
							sessionId,
							toolCall: {
								toolCallId: "interaction_detached",
								title: "Choose after the turn",
							},
							options: [
								{ optionId: "late-yes", name: "Yes", kind: "allow_once" },
								{ optionId: "late-no", name: "No", kind: "reject_once" },
							],
						},
						detachedPermissionId,
					);
				}, 60);
			} else if (text.includes("fixture-legacy-question")) {
				emit(
					"session/request_permission",
					{
						sessionId,
						toolCall: {
							toolCallId: "interaction_fixture",
							title: "Which branch?",
						},
						options: [
							{ optionId: "a", name: "Stable", kind: "allow_once" },
							{ optionId: "b", name: "Preview", kind: "reject_once" },
						],
					},
					questionPermissionId,
				);
			} else if (text.includes("fixture-form-question")) {
				emit(
					"elicitation/create",
					{
						sessionId,
						mode: "form",
						message: "Pick the environment and a reason",
						requestedSchema: {
							type: "object",
							properties: {
								env: {
									type: "string",
									title: "Environment",
									oneOf: [{ const: "prod", title: "Production" }],
								},
								reason: { type: "string", title: "Reason" },
								repeats: { type: "integer", title: "Repeats", minimum: 1 },
								confirm: { type: "boolean", title: "Confirm" },
								extra: { type: "string", title: "Extra notes" },
								flags: {
									type: "array",
									title: "Flags",
									items: { type: "string", enum: ["trace", "profile"] },
								},
							},
							required: ["env", "reason", "repeats", "confirm"],
						},
					},
					elicitationId,
				);
			} else if (text.includes("fixture-next-turn")) {
				update("Queued turn ran");
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-normal-while-busy")) {
				update("Normal turn ran separately");
				reply(id, { stopReason: "end_turn" });
			} else if (text.includes("fixture-permission")) {
				emit(
					"session/request_permission",
					{
						sessionId,
						toolCall: {
							title: "Fixture action",
							toolCallId: "test",
							...(text.includes("fixture-permission-diff")
								? {
										kind: "edit",
										content: [
											{
												type: "diff",
												path: "fixture.txt",
												oldText: null,
												newText: "approved content",
											},
										],
									}
								: { rawInput: { command: "true" } }),
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
		case "_session/steering": {
			if (
				mode !== "steer" ||
				params._meta.steering.idleBehavior !== "promptRequired"
			)
				throw new Error("Fixture expected host-owned steering");
			const text = params.prompt[0].text as string;
			if (text.includes("fixture-normal-while-busy"))
				throw new Error("Fixture received a normal message as a steer");
			if (text.includes("fixture-unconfirmed")) {
				reply(id, { outcome: "failed" });
			} else if (text.includes("fixture-next-turn")) {
				reply(id, { outcome: "promptRequired", reason: "noRunningTurn" });
				if (promptId !== undefined) reply(promptId, { stopReason: "end_turn" });
			} else {
				reply(id, { outcome: "injected" });
				update("Steered inside holding turn");
			}
			break;
		}
		case "session/cancel":
			if (params.sessionId === childSessionId) {
				emit("session/update", {
					sessionId,
					update: {
						sessionUpdate: "subagent_update",
						sessionId: childSessionId,
						state: { state: "idle", stopReason: "cancelled" },
					},
				});
				break;
			}
			if (params.sessionId !== sessionId)
				throw new Error("Unexpected cancel target");
			if (promptId !== undefined) reply(promptId, { stopReason: "cancelled" });
			break;
		case "session/close":
			mcp?.kill();
			reply(id, {});
			break;
		default:
			if (
				id === childPermissionId ||
				id === childWaitingPermissionId ||
				id === strangerPermissionId
			)
				process.stderr.write(
					`Fixture permission ${id} ${result?.outcome?.optionId ?? result?.outcome?.outcome}\n`,
				);
			if (id === childQuestionId)
				process.stderr.write(
					`Fixture grandchild got ${result?.content?.value}\n`,
				);
			if (id === detachedPermissionId) {
				if (result?.outcome?.outcome === "cancelled")
					process.stderr.write("Detached question cancelled\n");
				else
					update(result?.outcome?.optionId === "late-yes" ? "hello." : "bye.");
				emit("session/update", {
					sessionId,
					update: { sessionUpdate: "usage_update", used: 121, size: 4096 },
				});
			}
			if (id === elicitationId && promptId !== undefined) {
				if (result?.action === "accept") {
					update(`Form selected ${JSON.stringify(result.content)}`);
					reply(promptId, { stopReason: "end_turn" });
				} else {
					process.stderr.write(`Fixture elicitation ${result?.action}\n`);
				}
			}
			if (id === questionPermissionId && promptId !== undefined) {
				update(`Question selected ${result?.outcome?.optionId}`);
				reply(promptId, { stopReason: "end_turn" });
			}
			if (id === permissionId && promptId !== undefined) {
				update(
					`Permission ${result.outcome.optionId ?? result.outcome.outcome}`,
				);
				reply(promptId, { stopReason: "end_turn" });
			}
	}
}
mcp?.kill();
