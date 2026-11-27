import { contentText, obj, str, toMs } from "../transcripts/summary.ts";
import { newParseState, type TranscriptPage } from "../transcripts/types.ts";
import { codexRpc } from "./codex-rpc.ts";
import { parseCodex } from "./codex-transcript.ts";

/** Convert public app-server history to the same records used by the rollout parser. */
function records(item: Record<string, unknown>, timestamp: number) {
	const id = str(item.id);
	if (!id) return [];
	const record = (payload: Record<string, unknown>) => ({
		timestamp,
		type: "response_item",
		payload: { id, ...payload },
	});
	switch (item.type) {
		case "userMessage":
			return [
				record({
					type: "message",
					role: "user",
					content: contentText(item.content),
				}),
			];
		case "plan":
		case "agentMessage":
			return [
				record({ type: "message", role: "assistant", content: item.text }),
			];
		case "reasoning":
			return [
				record({
					type: "reasoning",
					summary: Array.isArray(item.summary)
						? item.summary.filter((x) => typeof x === "string").join("\n")
						: "",
				}),
			];
		case "mcpToolCall":
			return item.status === "inProgress"
				? [
						record({
							type: "function_call",
							id: `${id}#mcp`,
							name: `mcp__${item.server}__${item.tool}`,
							call_id: id,
							arguments: item.arguments,
						}),
					]
				: [
						{
							timestamp,
							type: "event_msg",
							payload: {
								type: "item_completed",
								item: { ...item, type: "McpToolCall" },
							},
						},
					];
		case "collabAgentToolCall": {
			const name = str(item.tool);
			if (!name) return [];
			const receivers = Array.isArray(item.receiverThreadIds)
				? item.receiverThreadIds
				: [];
			const call = record({
				type: "function_call",
				call_id: id,
				name: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
				arguments: {
					target: receivers.length === 1 ? receivers[0] : receivers,
					message: item.prompt,
				},
			});
			return item.status === "inProgress"
				? [call]
				: [
						call,
						record({
							id: `${id}#output`,
							type: "function_call_output",
							call_id: id,
							output: JSON.stringify(item.agentsStates ?? {}),
						}),
					];
		}
		case "commandExecution": {
			const call = record({
				type: "function_call",
				name: "exec_command",
				call_id: id,
				arguments: { cmd: item.command, workdir: item.cwd },
			});
			return item.status === "inProgress"
				? [call]
				: [
						call,
						record({
							id: `${id}#output`,
							type: "function_call_output",
							call_id: id,
							output: {
								output: item.aggregatedOutput ?? "",
								metadata: { exit_code: item.exitCode },
							},
						}),
					];
		}
		default:
			return [];
	}
}

export async function codexThreadHistory(
	threadId: string,
	cursor: string | null,
	cwd: string | null,
): Promise<TranscriptPage> {
	const [page] = (await codexRpc(
		[
			[
				"thread/turns/list",
				{
					threadId,
					itemsView: "full",
					sortDirection: "desc",
					limit: 8,
					...(cursor && { cursor }),
				},
			],
		],
		{ experimental: true },
	)) as [
		{
			data?: Array<{ startedAt?: number; items?: unknown[] }>;
			nextCursor?: string;
		},
	];
	if (!Array.isArray(page?.data))
		throw new Error("Codex did not return the requested thread history.");
	const state = newParseState({ cwd });
	const lines = page.data.reverse().flatMap((turn) =>
		(turn.items ?? []).flatMap((raw) => {
			const item = obj(raw);
			return item
				? records(item, toMs(turn.startedAt)).map((r) => JSON.stringify(r))
				: [];
		}),
	);
	return {
		events: parseCodex(lines.join("\n"), state),
		cursor: page.nextCursor ?? null,
	};
}
