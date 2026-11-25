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
function toolInput(name: string, raw: string) {
	const input = parseArgs(raw);
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
		send_message: { Recipient: "recipient", Message: "message" },
	};
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
			const name = utf8(descriptor.get(2));
			const id = utf8(descriptor.get(1));
			if (!name || !id) continue;
			events.push(
				callEvent(
					newParseState(),
					{ ...base, id: `${base.id}#call${events.length}` },
					name,
					id,
					toolInput(name, utf8(descriptor.get(3))),
				),
			);
		}
		return events;
	}
	if (type === 132) {
		const descriptor = message(message(root.get(5)).get(4));
		const name = utf8(descriptor.get(2));
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
		return text
			? [{ ...base, role: "system", kind: "system", subtype: "task", text }]
			: [];
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
