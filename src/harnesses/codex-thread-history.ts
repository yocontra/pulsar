import { contentText, obj, str, toMs } from "../transcripts/summary.ts";
import { newParseState, type TranscriptPage } from "../transcripts/types.ts";
import { codexRpc } from "./codex-rpc.ts";
import { parseCodex } from "./codex-transcript.ts";

/** Codex returns full contents for adds/deletes and unified hunks for updates. */
function patchInput(changes: unknown): string | null {
	if (!Array.isArray(changes)) return null;
	const lines: string[] = [];
	for (const value of changes) {
		const change = obj(value);
		const path = str(change?.path);
		const kind = obj(change?.kind);
		if (!path || !kind) continue;
		let diff = str(change?.diff) ?? "";
		if (kind.type === "update") {
			lines.push(`*** Update File: ${path}`);
			const moved = str(kind.move_path);
			if (moved) {
				lines.push(`*** Move to: ${moved}`);
				const suffix = `\n\nMoved to: ${moved}`;
				if (diff.endsWith(suffix)) diff = diff.slice(0, -suffix.length);
			}
			const hunk = diff.search(/^@@/m);
			if (diff) lines.push(diff.slice(Math.max(0, hunk)).replace(/\n$/, ""));
		} else if (kind.type === "add" || kind.type === "delete") {
			const add = kind.type === "add";
			lines.push(`*** ${add ? "Add" : "Delete"} File: ${path}`);
			if (diff)
				lines.push(diff.replace(/\n$/, "").replace(/^/gm, add ? "+" : "-"));
		}
	}
	return lines.length
		? ["*** Begin Patch", ...lines, "*** End Patch"].join("\n")
		: null;
}

/** Convert public app-server history to the same records used by the rollout parser. */
function records(item: Record<string, unknown>, timestamp: number) {
	const id = str(item.id);
	if (!id) return [];
	const record = (payload: Record<string, unknown>) => ({
		timestamp,
		type: "response_item",
		payload: { id, ...payload },
	});
	const tool = (name: string, args: unknown, output: unknown) => {
		const call = record({
			type: "function_call",
			call_id: id,
			name,
			arguments: args,
		});
		if (item.status === "inProgress") return [call];
		return [
			call,
			record({
				id: `${id}#output`,
				type: "function_call_output",
				call_id: id,
				output:
					typeof output === "string" &&
					(item.status === "failed" ||
						item.status === "declined" ||
						item.success === false)
						? { output, is_error: true }
						: output,
			}),
		];
	};
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
		case "fileChange": {
			const patch = patchInput(item.changes);
			return patch
				? tool("apply_patch", { patch }, str(item.status) ?? "")
				: [];
		}
		case "functionCallOutput":
			return [
				record({
					type: "function_call_output",
					call_id: id,
					name: [item.namespace, item.name].filter(Boolean).join("."),
					output: item.output,
				}),
			];
		case "dynamicToolCall": {
			const name = str(item.tool);
			return name
				? tool(
						[item.namespace, name].filter(Boolean).join("."),
						item.arguments,
						contentText(item.contentItems),
					)
				: [];
		}
		case "webSearch":
			return [
				record({
					type: "web_search_call",
					action: item.action ?? { type: "search", query: item.query },
				}),
			];
		case "imageView":
			return tool("view_image", { path: item.path }, "");
		case "contextCompaction":
			return [{ timestamp, type: "compacted", payload: { id } }];
		case "collabAgentToolCall": {
			const name = str(item.tool);
			if (!name) return [];
			const receivers = Array.isArray(item.receiverThreadIds)
				? item.receiverThreadIds
				: [];
			return tool(
				name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
				{
					target: receivers.length === 1 ? receivers[0] : receivers,
					message: item.prompt,
				},
				JSON.stringify(item.agentsStates ?? {}),
			);
		}
		case "commandExecution":
			return tool(
				"exec_command",
				{ cmd: item.command, workdir: item.cwd },
				{
					output: item.aggregatedOutput ?? "",
					metadata: { exit_code: item.exitCode },
				},
			);
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
				? records(
						item,
						typeof item.startedAtMs === "number"
							? item.startedAtMs
							: toMs(turn.startedAt),
					).map((r) => JSON.stringify(r))
				: [];
		}),
	);
	return {
		events: parseCodex(lines.join("\n"), state),
		cursor: page.nextCursor ?? null,
	};
}
