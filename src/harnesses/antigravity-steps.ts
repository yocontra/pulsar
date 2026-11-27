import { backgroundJob } from "../transcripts/background-job.ts";
import {
	callEvent,
	obj,
	parseArgs,
	resultEvents,
} from "../transcripts/summary.ts";
import { newParseState, type TranscriptEvent } from "../transcripts/types.ts";
import {
	message,
	repeated,
	utf8,
	type WireFields,
} from "./antigravity-proto.ts";

type Base = Pick<TranscriptEvent, "id" | "ts">;

// Convert agy's built-in tool arguments to the fields the shared transcript UI reads.
// MCP tools keep their own argument names.
function toolInput(name: string, input: unknown) {
	const args = obj(input);
	if (!args) return input;
	const names: Record<string, Record<string, string>> = {
		run_command: { CommandLine: "command", Cwd: "cwd" },
		read_file: { Path: "path", StartLine: "offset" },
		edit_file: {
			Path: "path",
			Target: "old_string",
			Replacement: "new_string",
		},
		write_file: { Path: "path", Content: "content" },
		run_workflow: {
			Description: "description",
			Cwd: "cwd",
			ScriptPath: "path",
		},
		manage_task: { Action: "action", TaskId: "id" },
		send_message: { Recipient: "recipient", Message: "message" },
	};
	if (
		name === "read_file" &&
		typeof args.StartLine === "number" &&
		typeof args.EndLine === "number" &&
		args.EndLine >= args.StartLine
	) {
		const { Path: path, StartLine: offset, EndLine, ...rest } = args;
		return { ...rest, path, offset, limit: EndLine - offset + 1 };
	}
	if (name === "update_steps" && Array.isArray(args.steps)) {
		return {
			plan: args.steps.map((s) => ({
				step: obj(s)?.title,
				status: obj(s)?.status,
			})),
		};
	}
	const aliases = Object.hasOwn(names, name) ? names[name] : undefined;
	if (!aliases) return input;
	return Object.fromEntries(
		Object.entries(args).map(([key, value]) => [
			Object.hasOwn(aliases, key) ? aliases[key] : key,
			value,
		]),
	);
}

function nativeTool(descriptor: WireFields) {
	const name = utf8(descriptor.get(2));
	const input = parseArgs(utf8(descriptor.get(3)));
	const args = obj(input);
	if (
		name === "call_mcp_tool" &&
		typeof args?.ServerName === "string" &&
		typeof args.ToolName === "string" &&
		/^[\w.-]{1,128}$/.test(args.ServerName) &&
		/^[\w.-]{1,128}$/.test(args.ToolName)
	) {
		return {
			name: `mcp__${args.ServerName}__${args.ToolName}`,
			input:
				typeof args.Arguments === "string"
					? parseArgs(args.Arguments)
					: args.Arguments,
		};
	}
	return { name, input: toolInput(name, input) };
}

/** Public tool steps, task notices and errors in a native conversation. */
export function antigravityStepEvents(
	type: number,
	root: WireFields,
	base: Base,
): TranscriptEvent[] {
	if (type === 15) {
		const events: TranscriptEvent[] = [];
		for (const raw of repeated(root.get(20), 7)) {
			const descriptor = message(raw);
			const { name, input } = nativeTool(descriptor);
			const id = utf8(descriptor.get(1));
			if (!name || !id) continue;
			events.push(
				callEvent(
					newParseState(),
					{ ...base, id: `${base.id}#call${events.length}` },
					name,
					id,
					input,
				),
			);
		}
		return events;
	}
	if (type === 132) {
		const descriptor = message(message(root.get(5)).get(4));
		const { name } = nativeTool(descriptor);
		const id = utf8(descriptor.get(1));
		const status = root.get(4);
		if (!name || !id) return [];
		const interrupted = status === 6 || status === 12;
		if (!interrupted && status !== 3 && status !== 7) return [];
		const result = message(message(root.get(140)).get(2));
		const error = status === 7;
		const output =
			utf8(result.get(1)) || (error ? utf8(message(root.get(31)).get(2)) : "");
		return resultEvents(
			newParseState(),
			base,
			id,
			output || (interrupted ? "Interrupted" : ""),
			error || interrupted,
			name,
			interrupted ? { interrupted: true } : undefined,
		);
	}
	if (type === 101) {
		const notice = message(root.get(114));
		if (utf8(notice.get(3)) !== "task_notification") return [];
		const task = message(notice.get(4));
		const text = utf8(task.get(4)) || utf8(message(task.get(10)).get(1));
		if (!text) return [];
		const header =
			/^Task id "([\w.-]+\/)?(task-[\w.-]+)" (finished|failed|was cancel(?:l)?ed) with result:\s*/i.exec(
				text,
			);
		if (!header) return [backgroundJob(base, "Task update", "updated", text)];
		const body = text.slice(header[0].length);
		const exit =
			/^Command exited with code (-?\d+)\.(?:\s*Command output:[ \t]*\r?\n|\s*Command output:[ \t]?|[ \t]*\r?\n)?/.exec(
				body,
			);
		const status = header[3]?.startsWith("was ")
			? "cancelled"
			: header[3] === "failed" || (exit && Number(exit[1]) !== 0)
				? "failed"
				: "completed";
		const title = `Task ${header[2]!.slice(5)} ${status}${exit ? ` · exit ${exit[1]}` : ""}`;
		return [
			backgroundJob(base, title, status, body.slice(exit?.[0].length ?? 0)),
		];
	}
	if (type === 17) {
		const error = message(message(root.get(24)).get(3));
		if (!error.size) return [];
		return [
			{
				...base,
				role: "system",
				kind: "system",
				text: utf8(error.get(1)) || "Antigravity request failed.",
			},
		];
	}
	return [];
}
