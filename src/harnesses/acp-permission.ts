import type { RequestPermissionRequest } from "@agentclientprotocol/sdk";

/** ACP permits a file edit to describe the full proposed change as a diff. */
export function permissionArguments(
	tool: RequestPermissionRequest["toolCall"],
): unknown {
	if (tool.rawInput != null) return tool.rawInput;
	if (tool.kind !== "edit" || !tool.content?.length) return undefined;
	const changes = [];
	for (const item of tool.content) {
		if (
			item.type !== "diff" ||
			!item.path?.trim() ||
			typeof item.newText !== "string"
		)
			return undefined;
		changes.push({
			path: item.path,
			oldText: item.oldText ?? null,
			newText: item.newText,
		});
	}
	return { changes };
}
