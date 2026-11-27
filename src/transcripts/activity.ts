import { toolKind } from "./describe.ts";

/** A short activity label without arguments or message content. */
export function toolAction(name: unknown, completed: boolean): string {
	if (name === "run_workflow")
		return completed ? "Finished a workflow" : "Started a workflow";
	const kind = typeof name === "string" ? toolKind(name) : "other";
	switch (kind) {
		case "shell":
			return completed ? "Ran a command" : "Requested a command";
		case "read":
		case "list":
			return completed ? "Read workspace files" : "Requested a file read";
		case "edit":
		case "patch":
		case "write":
		case "notebook":
			return completed ? "Finished a file change" : "Requested a file change";
		case "search":
		case "websearch":
		case "fetch":
			return completed ? "Received search results" : "Requested a search";
		case "task":
			return completed
				? "Received a subagent result"
				: "Requested a subagent task";
		default:
			return completed ? "Received a tool result" : "Called a tool";
	}
}
